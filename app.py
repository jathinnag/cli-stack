"""cli-stack — a real terminal in its own window, built with Python.

How it works:
  - Flask serves the web/ page (xterm.js draws the classic terminal).
  - A WebSocket carries your keystrokes -> shell, and shell output -> screen.
  - pywinpty is the "real terminal engine" running an actual shell, so
    interactive programs (python, etc.) work.
  - We open the page in an app-mode browser window (no tabs/address bar),
    so it looks and feels like its own application.
"""

import base64
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import traceback

from flask import Flask, redirect, request, send_from_directory
from flask_sock import Sock

# Pick the right pty engine + shell for the operating system.
if sys.platform == "win32":
    from winpty import PtyProcess
    SHELL = "powershell.exe"
else:
    from ptyprocess import PtyProcess
    SHELL = os.environ.get("SHELL", "bash")

HOST = "127.0.0.1"
PORT = 8000
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

# ---- Authentication ----
# This server can run a real shell, so we lock it to the one browser window the
# app opens for itself. A fresh random token is minted each launch; the launch
# URL carries it once, the page exchanges it for a cookie, and every request
# afterwards must present that cookie (or, for the in-terminal `save` command,
# the same token in a header). See _guard() for the full policy.
TOKEN = secrets.token_urlsafe(32)
COOKIE = "cli_stack_auth"
TOKEN_HEADER = "X-CLI-Stack-Token"
# Only honor requests addressed to our own loopback host:port. This is the key
# defense against DNS-rebinding, where a malicious site is rebound to 127.0.0.1
# but the browser still sends its own domain in the Host header.
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}


def _token_eq(value):
    """Constant-time check that `value` equals the session token."""
    return bool(value) and secrets.compare_digest(value, TOKEN)


def _authed():
    """True if the request carries the token via cookie or header."""
    return _token_eq(request.cookies.get(COOKIE)) or _token_eq(
        request.headers.get(TOKEN_HEADER)
    )

# Folders the user has explicitly kept with the "save" command typed in a
# terminal. They are never auto-added or auto-evicted — they stay until the
# user removes them, and the folder chooser lists them.
SAVED_FILE = os.path.join(os.path.expanduser("~"), ".cli-stack-saved.json")
SAVED_MAX = 50
_saved_lock = threading.Lock()

# The URL the in-terminal `save` command posts the current folder to.
SAVE_URL = f"http://{HOST}:{PORT}/save-dir"


def _build_spawn():
    """The command used to launch each shell.

    We define a `save` command/function inside the shell so the user can type
    `save` (or `save <path>`) in any terminal to remember its current folder.
    The function just POSTs the current directory back to this server."""
    if sys.platform == "win32":
        # Define the function silently at startup, then stay interactive
        # (-NoExit). -EncodedCommand sidesteps all the quoting headaches.
        ps = (
            "function save {\r\n"
            "  param([string]$Path)\r\n"
            "  if (-not $Path) { $Path = (Get-Location).Path }\r\n"
            "  try { $full = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path }"
            " catch { $full = $Path }\r\n"
            "  try {\r\n"
            f"    Invoke-RestMethod -Uri '{SAVE_URL}' -Method Post"
            f" -Headers @{{ '{TOKEN_HEADER}' = '{TOKEN}' }}"
            " -Body (@{ path = $full } | ConvertTo-Json) -ContentType 'application/json'"
            " -TimeoutSec 5 | Out-Null\r\n"
            '    Write-Host "Saved to cli-stack: $full" -ForegroundColor Green\r\n'
            "  } catch {\r\n"
            '    Write-Host "cli-stack save failed: $($_.Exception.Message)" -ForegroundColor Red\r\n'
            "  }\r\n"
            "}\r\n"
        )
        encoded = base64.b64encode(ps.encode("utf-16-le")).decode("ascii")
        return f"{SHELL} -NoLogo -NoExit -EncodedCommand {encoded}"

    # POSIX: only bash gets the convenience function (via a throwaway rcfile
    # that still loads the user's own ~/.bashrc). Other shells fall back to a
    # plain launch — the /save-dir endpoint still works if called directly.
    if os.path.basename(SHELL).startswith("bash"):
        rc = os.path.join(tempfile.gettempdir(), "cli-stack-bashrc.sh")
        body = '''[ -f ~/.bashrc ] && . ~/.bashrc
save() {
  local p="${1:-$PWD}"
  p="$(cd "$p" 2>/dev/null && pwd || echo "$p")"
  if command -v curl >/dev/null 2>&1; then
    curl -s -X POST -H 'Content-Type: application/json' -H '__HDR__: __TOK__' -d "{\\"path\\":\\"$p\\"}" '__URL__' >/dev/null
  fi
  echo "Saved to cli-stack: $p"
}
'''.replace("__URL__", SAVE_URL).replace("__HDR__", TOKEN_HEADER).replace("__TOK__", TOKEN)
        try:
            with open(rc, "w", encoding="utf-8") as f:
                f.write(body)
            return [SHELL, "--rcfile", rc, "-i"]
        except Exception:
            return SHELL
    return SHELL


SPAWN = _build_spawn()

app = Flask(__name__, static_folder=None)
sock = Sock(app)


# ---- Gate every request behind the token (HTTP routes and the WebSocket) ----

@app.before_request
def _guard():
    # 1) DNS-rebinding defense: ignore anything not addressed to localhost.
    if request.host not in ALLOWED_HOSTS:
        return ("Forbidden: unexpected Host header.", 403)
    # 2) The launch URL carries the token once; index() swaps it for a cookie.
    if request.path == "/" and _token_eq(request.args.get("token")):
        return None
    # 3) Everything else needs the auth cookie (or the save command's header).
    if not _authed():
        return (
            "Unauthorized. Start cli-stack with 'python app.py' so it opens "
            "its own authenticated window.",
            401,
        )
    return None


# ---- Serve the web page and its files ----

@app.route("/")
def index():
    # Arriving with a valid token in the URL: set the auth cookie, then redirect
    # to a clean "/" so the token doesn't linger in history or the referrer.
    if _token_eq(request.args.get("token")):
        resp = redirect("/")
        resp.set_cookie(
            COOKIE, TOKEN, httponly=True, samesite="Strict", path="/"
        )
        return resp
    return send_from_directory(WEB_DIR, "index.html")


@app.route("/<path:filename>")
def web_files(filename):
    return send_from_directory(WEB_DIR, filename)


# ---- Starting folders for a new terminal ----

@app.route("/default-dir")
def default_dir():
    # "This directory" = wherever the app itself was launched from.
    return {"dir": os.getcwd()}


def _same_path(a, b):
    """Path equality, case-insensitive on Windows."""
    if sys.platform == "win32":
        return os.path.normcase(a) == os.path.normcase(b)
    return a == b


# ---- Folders the user explicitly saved (via the "save" command) ----

def load_saved():
    """Read the user's saved folders (most-recent-first); [] on any problem."""
    try:
        with open(SAVED_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return [p for p in data if isinstance(p, str)]
    except Exception:
        return []


def add_saved(path):
    """Remember a folder the user saved: move it to the front of the saved
    list, de-duplicated, capped at SAVED_MAX. Returns the absolute path on
    success, or None if it wasn't a real folder."""
    try:
        path = os.path.abspath(path)
    except Exception:
        return None
    if not os.path.isdir(path):
        return None
    with _saved_lock:
        items = [p for p in load_saved() if not _same_path(p, path)]
        items.insert(0, path)
        items = items[:SAVED_MAX]
        try:
            with open(SAVED_FILE, "w", encoding="utf-8") as f:
                json.dump(items, f)
        except Exception:
            pass
    return path


def remove_saved(path):
    """Forget a saved folder (used by the chooser's ✕ button)."""
    with _saved_lock:
        items = [p for p in load_saved() if not _same_path(p, path)]
        try:
            with open(SAVED_FILE, "w", encoding="utf-8") as f:
                json.dump(items, f)
        except Exception:
            pass


@app.route("/saved-dirs")
def saved_dirs():
    # Only offer folders that still exist on disk.
    dirs = [p for p in load_saved() if os.path.isdir(p)]
    return {"dirs": dirs}


@app.route("/save-dir", methods=["POST"])
def save_dir():
    # Called by the `save` command running inside a terminal: it sends the
    # shell's current folder, which we add to the saved list.
    data = request.get_json(silent=True) or {}
    path = data.get("path")
    if not path:
        return {"ok": False, "error": "no path"}, 400
    saved = add_saved(path)
    if not saved:
        return {"ok": False, "error": "not a folder"}, 400
    return {"ok": True, "dir": saved}


@app.route("/unsave-dir", methods=["POST"])
def unsave_dir():
    data = request.get_json(silent=True) or {}
    path = data.get("path")
    if path:
        remove_saved(path)
    return {"ok": True}


# ---- Session logging ----
# Every session is transcribed to a plain-text log inside the folder it opened
# in: <folder>/context/logs/session-<timestamp>.log. The shell stream is full of
# ANSI color/cursor escapes, so we strip those to keep the log readable. It's a
# best-effort transcript — interactive line redraws (e.g. PowerShell's
# PSReadLine) can still leave minor artifacts.
_OSC = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")   # OSC ... BEL / ST
_CSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")           # CSI ... final byte
_ESC = re.compile(r"\x1b[@-Z\\-_]")                        # other 2-char escapes
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")    # stray control chars


def _strip_ansi(text):
    text = _OSC.sub("", text)
    text = _CSI.sub("", text)
    text = _ESC.sub("", text)
    text = text.replace("\r\n", "\n").replace("\r", "")
    return _CTRL.sub("", text)


def _open_session_log(base_dir):
    """Create <base_dir>/context/logs/ and open a fresh transcript file there."""
    try:
        logs_dir = os.path.join(base_dir, "context", "logs")
        os.makedirs(logs_dir, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        path = os.path.join(logs_dir, f"session-{stamp}-{secrets.token_hex(2)}.log")
        f = open(path, "a", encoding="utf-8", errors="replace")
        f.write(
            "# cli-stack session log\n"
            f"# started: {time.strftime('%Y-%m-%d %H:%M:%S')}\n"
            f"# folder:  {base_dir}\n\n"
        )
        f.flush()
        return f
    except Exception:
        traceback.print_exc()
        return None  # logging is best-effort; the terminal still works


def _emit_line(sess, line):
    """Write one finished transcript line, collapsing keystroke redraws: if the
    previous line is just a shorter prefix of this one (how PSReadLine repaints
    a line as you type), it was a partial redraw, so drop it and keep this one."""
    prev = sess.pending_line
    if prev is not None and not (line.startswith(prev) and line != prev):
        sess.logfile.write(prev + "\n")
    sess.pending_line = line


def _log_write(sess, data):
    """Transcribe shell output: strip escapes (holding back a trailing partial
    one across read boundaries), then emit complete lines with redraw-collapse."""
    f = sess.logfile
    if not f:
        return
    try:
        buf = sess.logbuf + data
        idx = buf.rfind("\x1b")
        if idx != -1 and len(buf) - idx < 16:  # likely an unfinished escape
            out, sess.logbuf = buf[:idx], buf[idx:]
        else:
            out, sess.logbuf = buf, ""
        if not out:
            return
        sess.lineacc += _strip_ansi(out)
        lines = sess.lineacc.split("\n")
        sess.lineacc = lines.pop()  # last piece has no newline yet — keep it
        for line in lines:
            _emit_line(sess, line)
        f.flush()
    except Exception:
        pass


def _close_session_log(sess):
    f = sess.logfile
    if not f:
        return
    sess.logfile = None
    try:
        # Flush anything still buffered (incomplete escape, partial line, the
        # last pending line) before stamping the end time.
        tail = _strip_ansi(sess.logbuf) + sess.lineacc
        sess.logbuf = sess.lineacc = ""
        for line in tail.split("\n"):
            _emit_line(sess, line)
        if sess.pending_line is not None:
            f.write(sess.pending_line + "\n")
            sess.pending_line = None
        f.write(f"\n# ended: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
        f.close()
    except Exception:
        pass


# ---- Terminal sessions ----
# A session is one real shell process, kept ALIVE independently of any single
# WebSocket. When the browser's socket drops (system sleep, tab throttling, a
# network blip) the shell keeps running; output produced meanwhile is buffered,
# and the page reconnects with the same session id to pick up right where it
# left off. Shells are only torn down on an explicit pane close or after a
# disconnected session has waited out the grace period below.
SESSION_GRACE = 60 * 60      # keep a disconnected shell resumable this long (s)
PENDING_CAP = 256 * 1024     # max characters of missed output buffered per shell
_sessions = {}               # sid -> _Session
_sessions_lock = threading.Lock()


class _Session:
    def __init__(self, sid, pty, logfile=None):
        self.sid = sid
        self.pty = pty
        self.lock = threading.Lock()  # serializes all sends + attach/detach
        self.ws = None                # the currently attached socket, or None
        self.pending = []             # output collected while detached
        self.pending_chars = 0
        self.alive = True
        self.detached_at = time.time()
        self.logfile = logfile        # transcript file handle, or None
        self.logbuf = ""              # carry-over for split escape sequences
        self.lineacc = ""             # current unfinished transcript line
        self.pending_line = None      # last line held back for redraw-collapse


def _pump_session(sess):
    """One per shell: forward output to the attached socket, or buffer it."""
    while True:
        try:
            data = sess.pty.read()  # blocks until the shell prints something
        except Exception:
            break  # EOFError / pty gone -> shell ended
        if not data:
            continue
        _log_write(sess, data)  # transcribe to <folder>/context/logs/
        with sess.lock:
            if sess.ws is not None:
                try:
                    sess.ws.send(data)
                    continue
                except Exception:
                    sess.ws = None  # socket broke; buffer this chunk instead
                    sess.detached_at = time.time()
            sess.pending.append(data)
            sess.pending_chars += len(data)
            # Trim the oldest buffered output so a long detach can't grow forever.
            while sess.pending_chars > PENDING_CAP and len(sess.pending) > 1:
                sess.pending_chars -= len(sess.pending.pop(0))

    # The shell exited — close the log, notify whoever is watching, forget it.
    sess.alive = False
    _close_session_log(sess)
    with sess.lock:
        if sess.ws is not None:
            try:
                sess.ws.send("\r\n\x1b[31m[session ended]\x1b[0m\r\n")
            except Exception:
                pass
    with _sessions_lock:
        _sessions.pop(sess.sid, None)


def _kill_session(sid):
    """Tear a shell down for good (explicit pane close, or the reaper)."""
    with _sessions_lock:
        sess = _sessions.pop(sid, None)
    if sess is None:
        return
    sess.alive = False
    try:
        if sess.pty.isalive():
            sess.pty.terminate(force=True)
    except Exception:
        pass
    with sess.lock:
        ws, sess.ws = sess.ws, None
    if ws is not None:
        try:
            ws.close()
        except Exception:
            pass


def _reap_sessions():
    """Periodically retire shells that have been disconnected past the grace
    period (e.g. the app window was closed and never came back)."""
    while True:
        time.sleep(60)
        now = time.time()
        for sid, sess in list(_sessions.items()):
            if not sess.alive or (
                sess.ws is None and now - sess.detached_at > SESSION_GRACE
            ):
                _kill_session(sid)


# ---- The live connection between the page and a real shell ----

@sock.route("/ws")
def terminal_socket(ws):
    # Re-check auth here too: never spawn a shell for an unauthenticated socket,
    # even if the before_request guard were somehow bypassed for the upgrade.
    if request.host not in ALLOWED_HOSTS or not _authed():
        return

    # The page sends a "start" message first: its session id (so we can resume
    # an existing shell) and, for a brand-new shell, the folder to launch in.
    first = ws.receive()
    if first is None:
        return  # window closed before it started
    try:
        start = json.loads(first)
    except Exception:
        return
    if not isinstance(start, dict) or start.get("type") != "start":
        return
    sid = start.get("sid") or secrets.token_urlsafe(9)

    # Resume the matching live shell if we still have it; otherwise start one.
    with _sessions_lock:
        sess = _sessions.get(sid)
        if sess is not None and not sess.alive:
            _sessions.pop(sid, None)
            sess = None

    if sess is None:
        cwd = start.get("cwd") or None
        if cwd and not os.path.isdir(cwd):
            cwd = None  # fall back to the default if the path is bad
        # SPAWN also wires up the in-terminal `save` command (see _build_spawn).
        try:
            pty = PtyProcess.spawn(SPAWN, cwd=cwd, dimensions=(24, 80))
        except Exception as e:
            traceback.print_exc()
            try:
                ws.send(f"\r\n\x1b[31mFailed to start shell: {e}\x1b[0m\r\n")
            except Exception:
                pass
            return
        # Transcribe this session into the folder it opened in.
        logfile = _open_session_log(cwd or os.getcwd())
        sess = _Session(sid, pty, logfile)
        with _sessions_lock:
            _sessions[sid] = sess
        threading.Thread(target=_pump_session, args=(sess,), daemon=True).start()

    # Attach this socket and flush anything the shell printed while detached.
    with sess.lock:
        sess.ws = ws
        if sess.pending:
            missed = "".join(sess.pending)
            sess.pending = []
            sess.pending_chars = 0
            try:
                ws.send(missed)
            except Exception:
                sess.ws = None

    # Messages from the browser -> shell. A bad/unknown message must never kill
    # the connection, so each one is parsed and applied defensively.
    try:
        while True:
            message = ws.receive()
            if message is None:
                break  # socket closed
            try:
                msg = json.loads(message)
            except Exception:
                continue  # ignore anything that isn't a JSON command
            kind = msg.get("type")
            if kind == "input":
                sess.pty.write(msg.get("data", ""))
            elif kind == "resize":
                try:
                    sess.pty.setwinsize(int(msg["rows"]), int(msg["cols"]))
                except Exception:
                    pass  # ignore bad/transient resize values
    except Exception as e:
        # A dropped connection (ConnectionClosed) is normal — don't make noise.
        if e.__class__.__name__ != "ConnectionClosed":
            traceback.print_exc()
    finally:
        # Detach, but leave the shell running so the page can resume it later.
        with sess.lock:
            if sess.ws is ws:
                sess.ws = None
                sess.detached_at = time.time()


@app.route("/close-session", methods=["POST"])
def close_session():
    # The page calls this when a pane is genuinely closed, so we can stop the
    # shell instead of keeping it around for a resume that will never come.
    data = request.get_json(silent=True) or {}
    sid = data.get("sid")
    if sid:
        _kill_session(sid)
    return {"ok": True}


# ---- Open the page as its own window ----

def open_window():
    time.sleep(1.0)  # give the server a moment to start
    # The token rides in the URL exactly once; the page swaps it for a cookie.
    url = f"http://{HOST}:{PORT}/?token={TOKEN}"
    try:
        # Microsoft Edge in "app mode": a clean window with no tabs/bar.
        subprocess.Popen(
            f'start "" msedge --app="{url}" --window-size=900,600',
            shell=True,
        )
    except Exception:
        # Fallback: just open the default browser.
        import webbrowser
        webbrowser.open(url)


if __name__ == "__main__":
    print(f"cli-stack running. Opening a window... (server at http://{HOST}:{PORT})")
    threading.Thread(target=open_window, daemon=True).start()
    threading.Thread(target=_reap_sessions, daemon=True).start()
    app.run(host=HOST, port=PORT, threaded=True)

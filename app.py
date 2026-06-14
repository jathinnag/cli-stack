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


# ---- The live connection between the page and a real shell ----

@sock.route("/ws")
def terminal_socket(ws):
    # Re-check auth here too: never spawn a shell for an unauthenticated socket,
    # even if the before_request guard were somehow bypassed for the upgrade.
    if request.host not in ALLOWED_HOSTS or not _authed():
        return

    # The page sends a "start" message first, telling us which folder to
    # launch the shell in (chosen via the buttons on a fresh terminal).
    cwd = None
    first = ws.receive()
    if first is None:
        return  # window closed before it started
    try:
        start = json.loads(first)
        if start.get("type") == "start":
            cwd = start.get("cwd") or None
    except Exception:
        pass
    if cwd and not os.path.isdir(cwd):
        cwd = None  # fall back to the default if the path is bad

    # Each window gets its own real shell process, rooted at the chosen folder.
    # SPAWN also wires up the in-terminal `save` command (see _build_spawn).
    try:
        pty = PtyProcess.spawn(SPAWN, cwd=cwd, dimensions=(24, 80))
    except Exception as e:
        # Couldn't start the shell — tell the user instead of just closing.
        traceback.print_exc()
        try:
            ws.send(f"\r\n\x1b[31mFailed to start shell: {e}\x1b[0m\r\n")
        except Exception:
            pass
        return

    # Background thread: shell output -> browser.
    def pump_output():
        while True:
            try:
                data = pty.read()  # waits for the shell to print something
            except EOFError:
                break  # shell closed
            except Exception:
                break  # pty gone
            try:
                ws.send(data)
            except Exception:
                break  # browser/window closed

    threading.Thread(target=pump_output, daemon=True).start()

    # This loop: messages from the browser -> shell. A bad/unknown message must
    # never kill the connection, so each one is parsed and applied defensively.
    try:
        while True:
            message = ws.receive()
            if message is None:
                break  # window closed
            try:
                msg = json.loads(message)
            except Exception:
                continue  # ignore anything that isn't a JSON command
            kind = msg.get("type")
            if kind == "input":
                pty.write(msg.get("data", ""))
            elif kind == "resize":
                try:
                    pty.setwinsize(int(msg["rows"]), int(msg["cols"]))
                except Exception:
                    pass  # ignore bad/transient resize values
    except Exception:
        # Browser closed mid-read, or the pty died — fall through to cleanup.
        traceback.print_exc()
    finally:
        try:
            if pty.isalive():
                pty.terminate(force=True)
        except Exception:
            pass


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
    app.run(host=HOST, port=PORT, threaded=True)

"""cli-stack — a real terminal in its own window, built with Python.

How it works:
  - Flask serves the web/ page (xterm.js draws the classic terminal).
  - A WebSocket carries your keystrokes -> shell, and shell output -> screen.
  - pywinpty is the "real terminal engine" running an actual shell, so
    interactive programs (python, etc.) work.
  - We open the page in an app-mode browser window (no tabs/address bar),
    so it looks and feels like its own application.
"""

import json
import os
import subprocess
import sys
import threading
import time

from flask import Flask, send_from_directory
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

# Where we remember folders terminals have been started in, so the "choose"
# button can offer them again. Kept in the home folder (survives restarts).
RECENTS_FILE = os.path.join(os.path.expanduser("~"), ".cli-stack-recents.json")
RECENTS_MAX = 12
_recents_lock = threading.Lock()

app = Flask(__name__, static_folder=None)
sock = Sock(app)


# ---- Serve the web page and its files ----

@app.route("/")
def index():
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


def load_recents():
    """Read the saved recent folders (most-recent-first); [] on any problem."""
    try:
        with open(RECENTS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return [p for p in data if isinstance(p, str)]
    except Exception:
        return []


def add_recent(path):
    """Record a folder a terminal was started in: move it to the front of the
    recents list, de-duplicated, capped at RECENTS_MAX."""
    try:
        path = os.path.abspath(path)
    except Exception:
        return
    if not os.path.isdir(path):
        return
    with _recents_lock:
        items = [p for p in load_recents() if not _same_path(p, path)]
        items.insert(0, path)
        items = items[:RECENTS_MAX]
        try:
            with open(RECENTS_FILE, "w", encoding="utf-8") as f:
                json.dump(items, f)
        except Exception:
            pass


@app.route("/recent-dirs")
def recent_dirs():
    # Only offer folders that still exist.
    dirs = [p for p in load_recents() if os.path.isdir(p)]
    return {"dirs": dirs}


# ---- The live connection between the page and a real shell ----

@sock.route("/ws")
def terminal_socket(ws):
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

    # The folder the shell actually opens in (the launch dir when unspecified).
    effective_cwd = cwd or os.getcwd()
    add_recent(effective_cwd)

    # Each window gets its own real shell process, rooted at the chosen folder.
    pty = PtyProcess.spawn(SHELL, cwd=cwd, dimensions=(24, 80))

    # Background thread: shell output -> browser.
    def pump_output():
        while True:
            try:
                data = pty.read()  # waits for the shell to print something
            except EOFError:
                break  # shell closed
            try:
                ws.send(data)
            except Exception:
                break  # browser/window closed
    threading.Thread(target=pump_output, daemon=True).start()

    # This loop: messages from the browser -> shell.
    while True:
        message = ws.receive()
        if message is None:
            break  # window closed
        msg = json.loads(message)
        if msg["type"] == "input":
            pty.write(msg["data"])
        elif msg["type"] == "resize":
            pty.setwinsize(msg["rows"], msg["cols"])

    if pty.isalive():
        pty.terminate(force=True)


# ---- Open the page as its own window ----

def open_window():
    time.sleep(1.0)  # give the server a moment to start
    url = f"http://{HOST}:{PORT}/"
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

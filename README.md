# cli-stack

A real terminal in its own window, built with Python. A Flask server bridges a
WebSocket to a genuine shell (via a pty), and [xterm.js](https://xtermjs.org/)
draws the terminal in an app-mode browser window — so interactive programs
(`python`, etc.) work just like in a normal terminal.

## Features

- **Browser-style tabs** — each tab is an independent set of terminals.
- **Split panes** — up to 4 terminals per tab, in draggable split layouts.
- **Folder chooser** — each new terminal asks where to start: the app's launch
  folder ("This directory") or one of your saved folders.
- **`save` command** — type `save` in any terminal to remember its current
  folder (or `save <path>` for a specific one). Saved folders then appear in the
  chooser for every new terminal, with a ✕ to forget them.
- **Copy / paste** — select to copy, middle-click or right-click to paste.

## Run

```sh
pip install -r requirements.txt
python app.py
```

The app opens in a Microsoft Edge "app mode" window (falls back to the default
browser). The server listens on `http://127.0.0.1:8000`.

Tested primarily on **Windows** (PowerShell + [pywinpty]). On macOS/Linux it
launches your `$SHELL` via [ptyprocess]; the `save` command is wired up for
`bash` and is best-effort on other shells.

[pywinpty]: https://github.com/andfoy/pywinpty
[ptyprocess]: https://github.com/pexpect/ptyprocess

## Security

⚠️ **This app gives full shell access to anything that can reach
`http://127.0.0.1:8000` — there is no authentication.**

It binds to `127.0.0.1` (localhost only), so it isn't exposed to your network by
default. But be aware that:

- Any other program running on your machine can connect and run commands as you.
- A malicious website you visit could, in principle, reach the local server
  (e.g. via DNS-rebinding) and obtain a shell.

Run it only on a machine you trust, and don't change the host to `0.0.0.0` or
forward the port unless you add authentication first. This is a personal-use /
learning project, **not** a hardened, multi-user remote terminal.

## Project layout

```
app.py            Flask + WebSocket server; spawns one shell per terminal,
                  injects the `save` command, stores saved folders
requirements.txt  Python dependencies
LICENSE           MIT license for this project
web/
  index.html      page shell, layout + tab styling
  renderer.js     tabs, split-pane layout tree, per-pane terminals, chooser
  vendor/         third-party assets (xterm.js, xterm.css, fit addon) + LICENSE
```

Saved folders are stored in `~/.cli-stack-saved.json`.

## License

This project is licensed under the [MIT License](LICENSE).

Bundled third-party assets in `web/vendor/` (xterm.js and its fit addon) are
MIT-licensed by the xterm.js authors — see [`web/vendor/LICENSE`](web/vendor/LICENSE).

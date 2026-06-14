# cli-stack

A real terminal in its own window, built with Python. A Flask server bridges a
WebSocket to a genuine shell (via a pty), and [xterm.js](https://xtermjs.org/)
draws the terminal in an app-mode browser window — so interactive programs
(`python`, etc.) work just like in a normal terminal.

Features:

- **Browser-style tabs** — each tab is an independent set of terminals.
- **Split panes** — up to 4 terminals per tab, in draggable split layouts.
- New terminals open in the app's launch folder. (A folder chooser with a
  recent-folders list is built in but currently hidden — see
  `web/renderer.js`, `Pane`'s constructor, to re-enable it.)

## Run

```sh
pip install -r requirements.txt
python app.py
```

The app opens in a Microsoft Edge "app mode" window (falls back to the default
browser). The server listens on `http://127.0.0.1:8000`.

## Project layout

```
app.py            Flask + WebSocket server; spawns one shell per terminal
requirements.txt  Python dependencies
web/
  index.html      page shell, layout + tab styling
  renderer.js     tabs, split-pane layout tree, per-pane terminals
  vendor/         third-party assets (xterm.js, xterm.css, fit addon)
```

Recently-used folders are stored in `~/.cli-stack-recents.json`.

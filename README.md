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

This app can run a real shell, so access is locked down to the one browser
window the app opens for itself. Three layers work together:

- **Per-launch token** — a fresh random token is minted each run and only ever
  placed in the window the app opens. Other local programs don't know it, so
  they can't connect.
- **`SameSite=Strict`, `HttpOnly` cookie** — the page swaps the launch token for
  a cookie scoped to `127.0.0.1`. JavaScript on other sites can't read it, and
  browsers won't send it on cross-site requests.
- **`Host`-header allowlist** — the server only honors requests addressed to
  `127.0.0.1:8000` / `localhost:8000`, which blocks DNS-rebinding attacks (where
  a malicious site is rebound to `127.0.0.1` but still sends its own domain).

Every HTTP route and the WebSocket are gated by this; the in-terminal `save`
command authenticates with the same token via a header.

It also binds to `127.0.0.1` (localhost only), so it isn't exposed to your
network. Still, treat this as a **personal-use / learning project, not a
hardened multi-user remote terminal** — don't change the host to `0.0.0.0` or
forward the port, since that would expose the shell beyond your machine.

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

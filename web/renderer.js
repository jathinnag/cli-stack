// renderer.js — terminal panes arranged as a Blender-style split-tree with
// draggable dividers, per-pane close buttons, and right-click split/close.
// Each pane is an independent CLI (its own shell).

// ---------------------------------------------------------------------------
// The layout is a persistent TREE kept in `root`:
//   { type: "leaf", pane }                         -> one terminal
//   { type: "split", dir: "row"|"col", children, sizes }
// "row" = children side by side (vertical dividers).
// "col" = children stacked (horizontal dividers).
// Editing the tree (split/close) then calling render() updates the screen.
// ---------------------------------------------------------------------------
const leaf = (pane) => ({ type: "leaf", pane: pane || null });
const split = (dir, children, sizes) => ({ type: "split", dir, children, sizes });

// Preset layouts for the picker (their leaves get panes assigned on use).
const LAYOUTS = [
  { id: "single", label: "Single", tree: leaf() },
  { id: "cols2", label: "Side by side", tree: split("row", [leaf(), leaf()]) },
  { id: "rows2", label: "Stacked", tree: split("col", [leaf(), leaf()]) },
  { id: "cols3", label: "Three columns", tree: split("row", [leaf(), leaf(), leaf()]) },
  {
    id: "main3", label: "Main + two",
    tree: split("row", [leaf(), split("col", [leaf(), leaf()])], [6, 4]),
  },
  {
    id: "grid4", label: "Grid",
    tree: split("col", [split("row", [leaf(), leaf()]), split("row", [leaf(), leaf()])]),
  },
];

const GUTTER = 6; // gutter grab-area width in pixels (must match .gutter flex-basis in CSS)
const MAX_PANES = 4; // most terminals allowed in a single tab

const grid = document.getElementById("grid");
// The inner strip that holds only the tab elements; the ⋮ overflow button
// sits beside it in #tabbar and survives renderTabs() rebuilds.
const tabbar = document.getElementById("tabs");
const picker = document.getElementById("picker");
const menuBtn = document.getElementById("menu-btn");
const appMenu = document.getElementById("app-menu");

// `tabs` holds every open tab; the ACTIVE tab's layout is mirrored into the
// `root` / `activePane` globals below so the rest of the code is unchanged.
// On switch we save the live globals back into the tab, then load the next.
let tabs = [];           // [{ root, activePane }]
let current = -1;        // index of the active tab in `tabs`

let root = null;         // the active tab's live layout tree
let activePane = null;   // the active tab's highlighted pane
let zoomedPane = null;   // the active tab's pinned "focus zoom" pane (or null)

// The app's launch folder ("This directory"), fetched once and reused.
let _defaultDir = null;
function defaultDir() {
  if (!_defaultDir) {
    _defaultDir = fetch("/default-dir")
      .then((r) => r.json())
      .then((d) => d.dir || "")
      .catch(() => "");
  }
  return _defaultDir;
}

// ---------------------------------------------------------------------------
// UI icons: inline SVG line icons, stroke-only and monochrome, so they look
// identical on every platform (emoji glyphs like 💾 render in full colour and
// vary by font; text ✕ / + glyphs sit differently in every font). They stroke
// with `currentColor`, so the button's CSS `color` — including its hover
// state — drives the icon.
const ICONS = {
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  save:
    '<path d="M2.5 2.5h8l3 3v8h-11z"/>' +
    '<path d="M5.5 2.5v3.5h5V2.5"/>' +
    '<path d="M4.5 13.5v-4h7v4"/>',
  focus:
    '<path d="M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10"/>',
};

function svgIcon(name) {
  return (
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" ' +
    'stroke="currentColor" stroke-width="1.4" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    ICONS[name] +
    "</svg>"
  );
}

// An icon-only <button>: `label` doubles as tooltip and accessible name.
function iconButton(className, iconName, label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ui-btn " + className;
  b.innerHTML = svgIcon(iconName);
  b.title = label;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return b;
}

// ---------------------------------------------------------------------------
// A Pane = one terminal + its own connection to a real shell on the server.
// ---------------------------------------------------------------------------
class Pane {
  constructor() {
    this.el = document.createElement("div");
    this.el.className = "pane";

    const termEl = document.createElement("div");
    termEl.className = "pane-term";
    this.el.appendChild(termEl);

    // Tool strip in the top-right corner: focus / save / close. Revealed only
    // while the pointer is in that corner (see .pane-tools in the CSS).
    const tools = document.createElement("div");
    tools.className = "pane-tools";
    tools.addEventListener("mousedown", (e) => e.stopPropagation());
    this.focusBtn = iconButton("pane-btn pane-focus", "focus", "Focus this terminal",
      () => toggleZoomPane(this));
    tools.append(
      this.focusBtn,
      iconButton("pane-btn pane-save", "save", "Save transcript to a file",
        () => this.saveToFile()),
      iconButton("pane-btn pane-close", "close", "Close terminal",
        () => closePane(this))
    );
    this.el.appendChild(tools);

    this.term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      // Change the quoted name below to try other fonts you have installed,
      // e.g. "Consolas", "Lucida Console", "Cascadia Code", "Fira Code".
      fontFamily: "'Cascadia Mono', Consolas, 'Courier New', monospace",
      theme: { background: "#000000", foreground: "#ffffff", cursor: "#ffffff" },
    });
    // App chords (Ctrl+1..9 tab switch, the Ctrl+Shift+letter SHORTCUTS):
    // make xterm ignore them so the keydown bubbles up to the window
    // handlers instead of being sent to the shell.
    this.term.attachCustomKeyEventHandler(
      (e) => tabSwitchIndex(e) < 0 && !chordFor(e)
    );

    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(termEl);

    // The shell isn't started yet — `ws` stays null until the user picks a
    // starting folder via the overlay below.
    this.ws = null;
    this.startCwd = "";

    // A stable id for this pane's shell. The server keeps the shell alive
    // across socket drops, so when we reconnect with the same id we resume the
    // very same session instead of getting a fresh shell.
    this.sid = newSessionId();
    this.closing = false;       // true once the pane is genuinely closed
    this.reconnecting = false;  // true while we're trying to re-attach
    this.reconnectDelay = 500;  // backoff between reconnect attempts (ms)
    this.reconnectTimer = null;

    this.term.onData((data) => this.send({ type: "input", data }));

    this.el.addEventListener("focusin", () => setActive(this));
    this.el.addEventListener("mousedown", (e) => {
      // Middle-click pastes (classic terminal convention), then bail so the
      // browser's own middle-click auto-scroll doesn't kick in.
      if (e.button === 1) {
        e.preventDefault();
        this.paste();
        return;
      }
      this.term.focus();
    });

    // Selecting text with the mouse copies it to the clipboard automatically.
    this.el.addEventListener("mouseup", () => this.copySelection());

    // Right-click -> copy / paste + split / close menu.
    this.el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, this);
    });

    // Auto-refit whenever this pane's size changes (drag, resize, layout swap).
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.el);

    // Show the folder chooser so the user can start here, in a saved folder,
    // or in a recent one. (To always start in the launch folder instead,
    // replace the next line with `this.start("")`.)
    this.showStartChooser();
  }

  // Overlay shown on a brand-new terminal: pick where the shell should start.
  showStartChooser() {
    const overlay = document.createElement("div");
    overlay.className = "start-overlay";
    // Clicks here shouldn't bubble out to pane focus/drag handlers.
    overlay.addEventListener("mousedown", (e) => e.stopPropagation());

    const title = document.createElement("div");
    title.className = "start-title";
    title.textContent = "Start this terminal in…";

    const btnThis = document.createElement("button");
    btnThis.className = "start-btn";
    btnThis.textContent = "This directory";
    btnThis.addEventListener("click", () => this.start("")); // "" => app's folder
    // Show the actual folder path under the label once we know it.
    defaultDir().then((dir) => {
      if (!dir) return;
      const path = document.createElement("span");
      path.className = "start-btn-path";
      path.textContent = dir;
      btnThis.appendChild(path);
    });

    // Folders the user kept with the `save` command, shown up front so they're
    // one click away. Each row starts a terminal there; its ✕ forgets it.
    const savedSection = document.createElement("div");
    savedSection.className = "saved-section hidden";
    const savedHeading = document.createElement("div");
    savedHeading.className = "section-heading";
    savedHeading.textContent = "Saved folders";
    const savedList = document.createElement("div");
    savedList.className = "recent-list"; // reuse the recent-list styling
    savedSection.append(savedHeading, savedList);

    const refreshSaved = async () => {
      let dirs = [];
      try {
        dirs = (await fetch("/saved-dirs").then((r) => r.json())).dirs || [];
      } catch (e) {
        /* fetch failed — leave the section hidden */
      }
      savedList.innerHTML = "";
      if (dirs.length === 0) {
        savedSection.classList.add("hidden");
        return;
      }
      savedSection.classList.remove("hidden");
      dirs.forEach((dir) => {
        const item = document.createElement("div");
        item.className = "recent-item saved-item";

        const label = document.createElement("button");
        label.type = "button";
        label.className = "ui-btn saved-item-path";
        label.textContent = dir;
        label.title = dir;
        label.addEventListener("click", () => this.start(dir));

        const remove = iconButton("saved-remove", "close", "Remove from saved", async () => {
          try {
            await fetch("/unsave-dir", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path: dir }),
            });
          } catch (e) {
            /* ignore — refresh will still re-read the list */
          }
          refreshSaved();
        });

        item.append(label, remove);
        savedList.appendChild(item);
      });
    };
    refreshSaved();

    overlay.append(title, btnThis, savedSection);
    this.el.appendChild(overlay);
    this.overlay = overlay;
  }

  // Dismiss the chooser and connect the shell, rooted at `cwd`.
  start(cwd) {
    this.startCwd = cwd || "";
    if (this.overlay) { this.overlay.remove(); this.overlay = null; }
    this.connect();
  }

  // Open this pane's own live connection to the Python server -> its own shell.
  // If the socket later drops (sleep, throttling, a blip) we automatically
  // reconnect with the same session id and resume the same shell.
  connect() {
    this.ws = new WebSocket(`ws://${location.host}/ws`);
    this.ws.onopen = () => {
      // The session id resumes an existing shell; cwd only matters for a new one.
      this.send({ type: "start", sid: this.sid, cwd: this.startCwd });
      this.resize();
      this.term.focus();
      if (this.reconnecting) {
        this.reconnecting = false;
        this.term.write("\x1b[32m[reconnected]\x1b[0m\r\n");
      }
      this.reconnectDelay = 500; // reset backoff after a good connection
    };
    this.ws.onmessage = (event) => this.term.write(event.data);
    this.ws.onclose = () => {
      this.ws = null;
      if (this.closing) return; // pane was closed on purpose — don't reconnect
      if (!this.reconnecting) {
        this.reconnecting = true;
        this.term.write("\r\n\x1b[33m[connection lost — reconnecting…]\x1b[0m");
      }
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5000);
    };
  }

  resize() {
    // During a focus-zoom glide the observer fires every frame with transient
    // sizes; each pty resize makes the console host rewrap and repaint, which
    // mangles the buffer. Skip those — syncSizesAnimated() does one clean
    // refit for every pane once the glide settles.
    if (grid.classList.contains("zoom-anim")) return;
    try {
      this.fit.fit();
      this.send({ type: "resize", rows: this.term.rows, cols: this.term.cols });
    } catch (e) {
      /* not visible yet — ignore */
    }
  }

  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  // Read everything in this terminal — scrollback plus the visible screen — as
  // plain text, with trailing blank lines trimmed off.
  getAllText() {
    const buf = this.term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : "");
    }
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    return lines.join("\r\n");
  }

  // Download this terminal's full text as a timestamped .txt file.
  saveToFile() {
    const text = this.getAllText();
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const a = document.createElement("a");
    a.href = url;
    a.download = `terminal-${stamp}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Copy whatever is currently selected in this terminal to the clipboard.
  copySelection() {
    const text = this.term.getSelection();
    if (text) {
      try { navigator.clipboard.writeText(text); } catch (e) { /* denied */ }
    }
  }

  // Paste the clipboard's text into the shell, as if it were typed.
  async paste() {
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch (e) {
      return; // clipboard read blocked (permissions / not focused)
    }
    if (text) {
      // Route through xterm's own paste handling (same as Ctrl+V) so line
      // endings are normalized (\r\n -> \r) and bracketed paste is honored,
      // instead of sending raw clipboard text to the shell.
      this.term.paste(text);
      this.term.focus();
    }
  }

  dispose() {
    // This is a real close, so stop the shell on the server (otherwise it would
    // be kept alive for a resume that will never come) and don't reconnect.
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.sid) {
      try {
        fetch("/close-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sid: this.sid }),
          keepalive: true, // still sent even if the page is unloading
        });
      } catch (e) { /* best effort */ }
    }
    this.observer.disconnect();
    try { if (this.ws) this.ws.close(); } catch (e) {}
    this.term.dispose();
    this.el.remove();
  }
}

// A random session id for a pane's shell (resilient to socket drops). Uses the
// browser's UUID generator when available, with a simple fallback.
function newSessionId() {
  try {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  } catch (e) { /* fall through */ }
  return "s-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function setActive(pane) {
  if (activePane === pane) return;
  if (activePane) activePane.el.classList.remove("active");
  activePane = pane;
  if (pane) pane.el.classList.add("active");
}

// ---------------------------------------------------------------------------
// Tree helpers.
// ---------------------------------------------------------------------------
function collectPanes(node, acc = []) {
  if (node.type === "leaf") acc.push(node.pane);
  else node.children.forEach((c) => collectPanes(c, acc));
  return acc;
}

function countLeaves(node) {
  if (node.type === "leaf") return 1;
  return node.children.reduce((sum, c) => sum + countLeaves(c), 0);
}

// Find a leaf's parent + index, so we can edit the tree around it.
function findParent(node, pane, parent = null, index = -1) {
  if (node.type === "leaf") return node.pane === pane ? { node, parent, index } : null;
  for (let i = 0; i < node.children.length; i++) {
    const hit = findParent(node.children[i], pane, node, i);
    if (hit) return hit;
  }
  return null;
}

// Collapse any split that has only one child left (merge it upward).
function normalize(node) {
  if (node.type === "leaf") return node;
  node.children = node.children.map(normalize);
  if (node.children.length === 1) return node.children[0];
  return node;
}

// ---------------------------------------------------------------------------
// Build the DOM from the current tree.
// ---------------------------------------------------------------------------
function renderNode(node, parentEl) {
  if (node.type === "leaf") {
    parentEl.appendChild(node.pane.el);
    return;
  }

  const container = document.createElement("div");
  container.className = "split " + node.dir;
  parentEl.appendChild(container);

  if (!node.sizes || node.sizes.length !== node.children.length) {
    node.sizes = node.children.map(() => 1);
  }

  const wraps = [];
  node.children.forEach((child, i) => {
    const wrap = document.createElement("div");
    wrap.className = "split-child";
    wrap.style.flexGrow = node.sizes[i];
    container.appendChild(wrap);
    wraps.push(wrap);
    renderNode(child, wrap);

    if (i < node.children.length - 1) {
      const gutter = document.createElement("div");
      gutter.className = "gutter " + node.dir;
      container.appendChild(gutter);
      makeDraggable(gutter, node, i, wraps, container);
    }
  });
}

function render() {
  grid.innerHTML = ""; // detaches pane.el nodes; the Pane objects stay alive
  // In single mode there's nothing to close, so hide the close button (see CSS #grid.single).
  grid.classList.toggle("single", countLeaves(root) === 1);
  renderNode(root, grid);
  requestAnimationFrame(() => collectPanes(root).forEach((p) => p.resize()));
}

// ---------------------------------------------------------------------------
// Dragging a gutter shifts space between the two panes on either side.
// ---------------------------------------------------------------------------
function makeDraggable(gutter, node, index, wraps, container) {
  gutter.addEventListener("mousedown", (e) => {
    e.preventDefault();
    grid.classList.remove("zoom-anim"); // a drag must track the mouse 1:1
    const horizontal = node.dir === "row";
    const startPos = horizontal ? e.clientX : e.clientY;
    const startA = node.sizes[index];
    const startB = node.sizes[index + 1];

    const totalUnits = node.sizes.reduce((a, b) => a + b, 0);
    const gutterSpace = (node.children.length - 1) * GUTTER;
    const contentPx =
      (horizontal ? container.clientWidth : container.clientHeight) - gutterSpace;
    const pxPerUnit = contentPx / totalUnits;

    const onMove = (ev) => {
      const pos = horizontal ? ev.clientX : ev.clientY;
      const deltaUnits = (pos - startPos) / pxPerUnit;
      let a = startA + deltaUnits;
      let b = startB - deltaUnits;
      const min = 0.5;
      if (a < min) { b -= (min - a); a = min; }
      if (b < min) { a -= (min - b); b = min; }
      node.sizes[index] = a;
      node.sizes[index + 1] = b;
      wraps[index].style.flexGrow = a;
      wraps[index + 1].style.flexGrow = b;
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = horizontal ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  });
}

// ---------------------------------------------------------------------------
// Focus zoom: each pane's focus button pins that pane at ~80% of the grid.
// applyZoom runs from toggleZoomPane() and after every render() (splits,
// closes, layout swaps, tab switches), so it must be idempotent.
// ---------------------------------------------------------------------------

// Like findParent, but returns the whole chain of {split, idx} from the root
// down to the leaf holding `pane` (empty array = root itself is the leaf).
function findPath(node, pane, path = []) {
  if (node.type === "leaf") return node.pane === pane ? path : null;
  for (let i = 0; i < node.children.length; i++) {
    const hit = findPath(node.children[i], pane, [...path, { split: node, idx: i }]);
    if (hit) return hit;
  }
  return null;
}

const ZOOM_SHARE = 0.8;       // area the focused pane aims for
const ZOOM_MIN_SIBLING = 180; // px each squeezed sibling keeps along the split axis

function applyZoom() {
  if (!root || !zoomedPane) return;
  const path = findPath(root, zoomedPane);
  if (!path || path.length === 0) return; // single pane: nothing to zoom

  // Per-level fraction so the focused pane's total area works out to ~80%
  // even when the leaf sits under nested splits...
  const fTarget = Math.pow(ZOOM_SHARE, 1 / path.length);

  let parentEl = grid;
  for (const { split: node, idx } of path) {
    const n = node.sizes.length;

    // ...but never squeeze a sibling below ZOOM_MIN_SIBLING px: a terminal
    // that small shows nothing useful. Measured from the live container, so
    // a 2x2 grid in a small window zooms less than a side-by-side pair.
    const container = parentEl.firstElementChild; // the .split div
    const wraps = container
      ? Array.from(container.children).filter((el) => el.classList.contains("split-child"))
      : [];
    const along = container
      ? (node.dir === "row" ? container.clientWidth : container.clientHeight) - GUTTER * (n - 1)
      : 0;
    let f = fTarget;
    if (along > 0) {
      const maxF = (along - ZOOM_MIN_SIBLING * (n - 1)) / along;
      f = Math.min(fTarget, Math.max(maxF, 1 / n));
    }

    // Snapshot the pre-zoom sizes once so (a) the pass is idempotent, (b) the
    // remainder keeps the original sibling ratios, (c) toggle-off can restore.
    if (!node._savedSizes || node._savedSizes.length !== node.sizes.length) {
      node._savedSizes = node.sizes.slice();
    }
    const base = node._savedSizes;
    const total = node.sizes.reduce((a, b) => a + b, 0);
    const baseOthers = base.reduce((a, b) => a + b, 0) - base[idx];
    const rem = (1 - f) * total;
    node.sizes[idx] = f * total;
    for (let j = 0; j < n; j++) {
      if (j === idx) continue;
      node.sizes[j] = baseOthers > 0 ? (base[j] / baseOthers) * rem : rem / (n - 1);
    }
    parentEl = wraps[idx] || parentEl;
  }
  syncSizesAnimated();
}

// The cap above depends on the window size, so re-measure after a resize.
let _zoomResizeTimer = null;
window.addEventListener("resize", () => {
  if (!zoomedPane) return;
  clearTimeout(_zoomResizeTimer);
  _zoomResizeTimer = setTimeout(applyZoom, 120);
});

// Apply the tree's sizes with the flex-grow transition enabled, dropping the
// class once the glide is over so drags (and render rebuilds) stay instant.
let _zoomAnimTimer = null;
function syncSizesAnimated() {
  grid.classList.add("zoom-anim");
  syncSizes(root, grid);
  clearTimeout(_zoomAnimTimer);
  _zoomAnimTimer = setTimeout(() => {
    grid.classList.remove("zoom-anim");
    // One clean refit per pane at the settled size (see Pane.resize()).
    collectPanes(root).forEach((p) => p.resize());
  }, 300);
}

// Push the tree's sizes into the DOM that render() already built. Each pane's
// ResizeObserver refits xterm, so no rebuild (and no focus churn) is needed.
function syncSizes(node, parentEl) {
  if (node.type === "leaf") return;
  const container = parentEl.firstElementChild; // the .split div
  if (!container) return;
  const wraps = Array.from(container.children).filter((el) =>
    el.classList.contains("split-child")
  );
  node.children.forEach((child, i) => {
    if (!wraps[i]) return;
    wraps[i].style.flexGrow = node.sizes[i];
    syncSizes(child, wraps[i]);
  });
}

// Undo the zoom weights everywhere (used when the toggle turns off).
function restoreSizes(node) {
  if (node.type === "leaf") return;
  if (node._savedSizes && node._savedSizes.length === node.sizes.length) {
    node.sizes = node._savedSizes.slice();
  }
  delete node._savedSizes;
  node.children.forEach(restoreSizes);
}

// Pin the zoom to `pane` (stealing it from whichever pane held it), or
// release it when `pane` is already the pinned one.
function toggleZoomPane(pane) {
  if (countLeaves(root) < 2) return; // nothing to zoom against
  zoomedPane = zoomedPane === pane ? null : pane;
  collectPanes(root).forEach((p) => {
    const on = p === zoomedPane;
    p.focusBtn.classList.toggle("active", on);
    const label = on ? "Restore layout" : "Focus this terminal";
    p.focusBtn.title = label;
    p.focusBtn.setAttribute("aria-label", label);
  });
  if (zoomedPane) {
    setActive(zoomedPane);
    zoomedPane.term.focus();
    applyZoom();
  } else {
    // Only sizes changed (not the tree), so glide back instead of rebuilding.
    restoreSizes(root);
    syncSizesAnimated();
  }
}

// ---------------------------------------------------------------------------
// Operations: split a pane, close a pane.
// ---------------------------------------------------------------------------
function splitPane(pane, dir) {
  if (countLeaves(root) >= MAX_PANES) return; // tab is full (max 4 terminals)
  const hit = findParent(root, pane);
  if (!hit) return;
  const newPane = new Pane();
  // Turn the found leaf into a split holding [old pane, new pane].
  hit.node.type = "split";
  hit.node.dir = dir;
  hit.node.children = [leaf(pane), leaf(newPane)];
  hit.node.sizes = [1, 1];
  delete hit.node.pane;
  render();
  setActive(newPane);
}

function closePane(pane) {
  const panes = collectPanes(root);
  if (panes.length <= 1) return; // always keep at least one terminal

  const hit = findParent(root, pane);
  pane.dispose();

  if (pane === zoomedPane) {
    // The pinned pane is going away — give the survivors their sizes back.
    zoomedPane = null;
    restoreSizes(root);
  }

  if (hit.parent) {
    hit.parent.children.splice(hit.index, 1);
    if (hit.parent.sizes) hit.parent.sizes.splice(hit.index, 1);
    if (hit.parent._savedSizes) hit.parent._savedSizes.splice(hit.index, 1);
  }
  root = normalize(root);

  if (activePane === pane) {
    activePane = null;
    setActive(collectPanes(root)[0]);
  }
  render();
}

// ---------------------------------------------------------------------------
// Right-click context menu.
// ---------------------------------------------------------------------------
let contextMenuEl = null;

// Fill `container` with menu rows. Each item is { label, fn, key?, disabled? }
// or { separator: true }; `after` runs once an item has been chosen (to
// close the menu that owns it).
function buildMenuRows(container, items, after) {
  items.forEach((it) => {
    if (it.separator) {
      const sep = document.createElement("div");
      sep.className = "context-separator";
      container.appendChild(sep);
      return;
    }
    const row = document.createElement("button");
    row.type = "button";
    row.className = "ui-btn context-item";
    row.setAttribute("role", "menuitem");
    const label = document.createElement("span");
    label.textContent = it.label;
    row.appendChild(label);
    if (it.key) {
      const key = document.createElement("span");
      key.className = "context-key";
      key.textContent = it.key;
      row.appendChild(key);
    }
    if (it.disabled) {
      row.disabled = true;
    } else {
      row.addEventListener("click", () => { after(); it.fn(); });
    }
    container.appendChild(row);
  });
}

// The split rows are shared by the right-click menu and the ⋮ menu.
function splitItems(pane) {
  if (countLeaves(root) >= MAX_PANES) {
    return [{ label: `Max ${MAX_PANES} terminals per tab`, disabled: true }];
  }
  return [
    { label: "Split left / right", key: SHORTCUTS.splitRow.key, fn: () => splitPane(pane, "row") },
    { label: "Split top / bottom", key: SHORTCUTS.splitCol.key, fn: () => splitPane(pane, "col") },
  ];
}

function showContextMenu(x, y, pane) {
  hideContextMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.setAttribute("role", "menu");

  const many = countLeaves(root) > 1;
  const items = [];
  // Clipboard first: Copy (only when something is selected) and Paste.
  if (pane.term.hasSelection()) {
    items.push({ label: "Copy", fn: () => pane.copySelection() });
  }
  items.push({ label: "Paste", fn: () => pane.paste() });
  items.push({ separator: true });
  items.push(...splitItems(pane));
  // Focus zoom only means something with a sibling to shrink.
  if (many) {
    items.push({
      label: pane === zoomedPane ? "Restore layout" : "Focus this terminal",
      key: SHORTCUTS.focus.key,
      fn: () => toggleZoomPane(pane),
    });
  }
  items.push({ separator: true });
  items.push({ label: "Save transcript…", fn: () => pane.saveToFile() });
  // Only offer "Close" when there's more than one terminal.
  if (many) items.push({ label: "Close terminal", fn: () => closePane(pane) });

  buildMenuRows(menu, items, hideContextMenu);

  document.body.appendChild(menu);
  // Clamp so a right-click near the bottom/right edge doesn't push the menu
  // off-screen (it's position: fixed, so measure after it's in the DOM).
  const margin = 4;
  const maxX = window.innerWidth - menu.offsetWidth - margin;
  const maxY = window.innerHeight - menu.offsetHeight - margin;
  menu.style.left = Math.max(margin, Math.min(x, maxX)) + "px";
  menu.style.top = Math.max(margin, Math.min(y, maxY)) + "px";
  contextMenuEl = menu;
}

function hideContextMenu() {
  if (contextMenuEl) { contextMenuEl.remove(); contextMenuEl = null; }
}

// ---------------------------------------------------------------------------
// Picker: apply a preset layout WITHOUT closing any running terminal.
// Reuses existing panes, adds new ones, and grows the layout to fit them all.
// ---------------------------------------------------------------------------
function addLeaf(tree) {
  if (tree.type === "leaf") {
    tree.type = "split";
    tree.dir = "row";
    tree.children = [leaf(), leaf()];
    delete tree.sizes;
  } else {
    tree.children.push(leaf());
    if (tree.sizes) tree.sizes.push(1);
  }
}

function assignPanes(node, nextPane) {
  if (node.type === "leaf") node.pane = nextPane();
  else node.children.forEach((c) => assignPanes(c, nextPane));
}

function applyLayout(layout) {
  const existing = collectPanes(root);
  const tree = structuredClone(layout.tree); // preset; leaves have no pane yet
  const target = Math.max(countLeaves(tree), existing.length);

  while (countLeaves(tree) < target) addLeaf(tree); // grow to fit all panes

  const pool = existing.slice();
  assignPanes(tree, () => pool.shift() || new Pane()); // reuse, then create new
  root = tree;

  render();
  if (!collectPanes(root).includes(activePane)) setActive(collectPanes(root)[0]);
}

// Ctrl+Shift+L cycles the tab through the presets that hold EXACTLY the
// terminals it already has, so cycling only rearranges panes — it never
// spawns or closes a shell (2 panes: side by side <-> stacked, 3 panes:
// three columns <-> main + two).

// App-wide Ctrl+Shift+<letter> chords. One table so the menus can print the
// same key beside the same action. Uses e.code so it works on any keyboard
// layout. (Ctrl+1..9 tab switching lives in tabSwitchIndex().)
const SHORTCUTS = {
  splitRow: { code: "KeyD", key: "Ctrl+Shift+D", run: () => activePane && splitPane(activePane, "row") },
  splitCol: { code: "KeyE", key: "Ctrl+Shift+E", run: () => activePane && splitPane(activePane, "col") },
  focus: { code: "KeyZ", key: "Ctrl+Shift+Z", run: () => activePane && toggleZoomPane(activePane) },
  cycleLayout: { code: "KeyL", key: "Ctrl+Shift+L", run: () => cycleLayout() },
};
function chordFor(e) {
  if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return null;
  return Object.values(SHORTCUTS).find((s) => s.code === e.code) || null;
}

// Do two trees split the screen the same way? (Panes and drag-adjusted
// sizes are ignored — only the structure matters.)
function sameShape(a, b) {
  if (a.type !== b.type) return false;
  if (a.type === "leaf") return true;
  return a.dir === b.dir && a.children.length === b.children.length &&
    a.children.every((c, i) => sameShape(c, b.children[i]));
}

function cycleLayout() {
  const n = collectPanes(root).length;
  const options = LAYOUTS.filter((l) => countLeaves(l.tree) === n);
  if (options.length < 2) return; // nothing to cycle to at this pane count

  // Start after the preset we're currently on; a hand-made layout that
  // matches no preset (findIndex -1) starts the cycle at the first option.
  const at = options.findIndex((l) => sameShape(l.tree, root));
  applyLayout(options[(at + 1) % options.length]);
  if (activePane) activePane.term.focus();
}

window.addEventListener("keydown", (e) => {
  const chord = chordFor(e);
  if (!chord) return;
  e.preventDefault();
  chord.run();
});

// ---------------------------------------------------------------------------
// Build the Snap-Layouts-style picker thumbnails from each tree.
// ---------------------------------------------------------------------------
function renderMini(node, parentEl) {
  if (node.type === "leaf") {
    const cell = document.createElement("div");
    cell.className = "mini-cell";
    parentEl.appendChild(cell);
    return;
  }
  const box = document.createElement("div");
  box.style.display = "flex";
  box.style.flex = "1";
  box.style.gap = "3px";
  box.style.flexDirection = node.dir === "row" ? "row" : "column";
  const sizes = node.sizes || node.children.map(() => 1);
  node.children.forEach((child, i) => {
    const w = document.createElement("div");
    w.style.display = "flex";
    w.style.flexGrow = sizes[i];
    w.style.flexBasis = "0";
    box.appendChild(w);
    renderMini(child, w);
  });
  parentEl.appendChild(box);
}

function buildPicker() {
  picker.innerHTML = ""; // rebuilt each time it opens

  // Switching layouts never closes a terminal, so a layout with FEWER cells
  // than we currently have can't actually be used — only show layouts with
  // enough cells. (If none qualify, fall back to showing them all.)
  const current = collectPanes(root).length;
  let options = LAYOUTS.filter((l) => countLeaves(l.tree) >= current);
  if (options.length === 0) options = LAYOUTS;

  options.forEach((layout) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "ui-btn layout-option";
    option.setAttribute("aria-label", `${layout.label} layout`);

    const mini = document.createElement("div");
    mini.className = "mini-grid";
    renderMini(layout.tree, mini);

    const label = document.createElement("div");
    label.className = "layout-label";
    label.textContent = layout.label;

    option.appendChild(mini);
    option.appendChild(label);
    option.addEventListener("click", () => { applyLayout(layout); hidePicker(); });
    picker.appendChild(option);
  });
}

function hidePicker() { picker.classList.add("hidden"); }

// ---------------------------------------------------------------------------
// ⋮ overflow menu on the right of the tab strip. "Layouts" is its only
// entry today; new app-wide actions belong here rather than as more buttons.
// ---------------------------------------------------------------------------
function hideAppMenu() {
  const hadFocus = appMenu.contains(document.activeElement);
  appMenu.classList.add("hidden");
  menuBtn.classList.remove("open");
  menuBtn.setAttribute("aria-expanded", "false");
  // Don't strand keyboard focus on a hidden menu.
  if (hadFocus && activePane) activePane.term.focus();
}

function buildAppMenu() {
  appMenu.innerHTML = "";
  const n = collectPanes(root).length;
  const canCycle = LAYOUTS.filter((l) => countLeaves(l.tree) === n).length > 1;
  const items = [
    { label: "New tab", fn: newTab },
    { label: "Rename tab", fn: () => beginRename(current) },
    { separator: true },
    ...splitItems(activePane),
    { label: "Layouts…", fn: () => { buildPicker(); picker.classList.remove("hidden"); } },
    { label: "Next layout", key: SHORTCUTS.cycleLayout.key, fn: cycleLayout, disabled: !canCycle },
  ];
  buildMenuRows(appMenu, items, hideAppMenu);
}

menuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const opening = appMenu.classList.contains("hidden");
  hidePicker(); // the menu and the picker it opens are never up together
  if (!opening) return hideAppMenu();
  buildAppMenu();
  appMenu.classList.remove("hidden");
  menuBtn.classList.add("open");
  menuBtn.setAttribute("aria-expanded", "true");
  // Land keyboard users on the first row (Tab moves between rows, Escape
  // closes).
  const first = appMenu.querySelector(".context-item:not(:disabled)");
  if (first) first.focus();
});

// Escape closes whichever popover is open. Capture phase so it runs before
// xterm sees the key, and only swallows the keystroke when something was
// actually open — otherwise ESC still reaches the shell (vim, etc.).
window.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "Escape") return;
    const open =
      contextMenuEl ||
      !appMenu.classList.contains("hidden") ||
      !picker.classList.contains("hidden");
    if (!open) return;
    e.preventDefault();
    e.stopPropagation();
    hideContextMenu();
    hideAppMenu();
    hidePicker();
    if (activePane) activePane.term.focus();
  },
  true
);

// Click elsewhere closes the picker, the overflow menu and the right-click menu.
document.addEventListener("mousedown", (e) => {
  if (!picker.contains(e.target) && !menuBtn.contains(e.target)) hidePicker();
  if (!appMenu.contains(e.target) && !menuBtn.contains(e.target)) hideAppMenu();
  if (contextMenuEl && !contextMenuEl.contains(e.target)) hideContextMenu();
});

// ---------------------------------------------------------------------------
// Tabs: each tab is an independent layout tree of terminals (max 4 each).
// Switching tabs only detaches/reattaches DOM — panes (and their shells) stay
// alive in the background, exactly like background browser tabs.
// ---------------------------------------------------------------------------

// Copy the live globals back into the tab they belong to.
function saveTab() {
  if (current < 0) return;
  tabs[current].root = root;
  tabs[current].activePane = activePane;
  tabs[current].zoomedPane = zoomedPane;
}

// Make the given tab the active one and mirror it into the globals.
function loadTab() {
  root = tabs[current].root;
  activePane = tabs[current].activePane;
  zoomedPane = tabs[current].zoomedPane || null;
}

function newTab() {
  saveTab();
  const t = { root: leaf(new Pane()), activePane: null, zoomedPane: null, name: null };
  t.activePane = t.root.pane;
  tabs.push(t);
  current = tabs.length - 1;
  loadTab();
  renderTabs();
  render();
  if (activePane) activePane.term.focus();
}

// Ctrl+1..8 jumps straight to that tab; Ctrl+9 jumps to the LAST tab
// (browser convention). Returns the target tab index, or -1 if the event
// isn't a tab-switch chord. Uses e.code so it works on any keyboard layout.
function tabSwitchIndex(e) {
  if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return -1;
  const m = /^Digit([1-9])$/.exec(e.code);
  if (!m) return -1;
  const n = Number(m[1]);
  return n === 9 ? tabs.length - 1 : n - 1;
}

// Bubble phase on purpose: the tab-rename input stops propagation of its own
// keydowns, so typing Ctrl+1 while renaming won't yank the tab strip away.
window.addEventListener("keydown", (e) => {
  const i = tabSwitchIndex(e);
  if (i < 0 || i >= tabs.length) return;
  e.preventDefault();
  switchTab(i);
});

function switchTab(i) {
  if (i === current) return;
  saveTab();
  current = i;
  loadTab();
  renderTabs();
  render();
  if (activePane) activePane.term.focus();
}

function closeTab(i) {
  if (tabs.length <= 1) return; // always keep at least one tab

  // Confirm before closing — closing a tab disposes all of its terminals.
  const name = tabs[i].name || `Terminal ${i + 1}`;
  const n = countLeaves(tabs[i].root);
  const detail = n > 1 ? ` and its ${n} terminals` : "";
  if (!confirm(`Close "${name}"${detail}?`)) return;

  saveTab();
  collectPanes(tabs[i].root).forEach((p) => p.dispose());
  tabs.splice(i, 1);
  if (current > i) current -= 1;
  else if (current === i) current = Math.min(i, tabs.length - 1);
  loadTab();
  renderTabs();
  render();
  if (activePane) activePane.term.focus();
}

// Draw the browser-style tab strip.
function renderTabs() {
  tabbar.innerHTML = "";
  tabs.forEach((t, i) => {
    const el = document.createElement("div");
    el.className = "tab" + (i === current ? " active" : "");
    el.setAttribute("role", "tab");
    el.setAttribute("aria-selected", i === current ? "true" : "false");
    el.tabIndex = 0;
    el.addEventListener("click", () => onTabClick(i));
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      onTabClick(i); // two quick presses rename, like a double-click
    });

    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = t.name || `Terminal ${i + 1}`;
    title.title = "Double-click to rename";
    el.appendChild(title);

    // How many terminals this tab holds. Just the number — the cap is a
    // fixed rule, not per-tab information worth repeating on every tab.
    const count = document.createElement("span");
    count.className = "tab-count";
    count.textContent = `${countLeaves(t.root)}`;
    count.title = `${countLeaves(t.root)} of ${MAX_PANES} terminals`;
    el.appendChild(count);

    if (tabs.length > 1) {
      el.appendChild(iconButton("tab-close", "close", "Close tab", () => closeTab(i)));
    }
    tabbar.appendChild(el);
  });

  tabbar.appendChild(iconButton("tab-add", "plus", "New tab", newTab));

  revealActiveTab();
  updateTabFades();
}

// With many tabs the strip scrolls; make sure the active tab (and, when it's
// the last one, the + button beside it) is actually on screen.
function revealActiveTab() {
  const el = tabbar.children[current];
  if (!el) return;
  const target = current === tabs.length - 1 ? tabbar.lastElementChild : el;
  const strip = tabbar.getBoundingClientRect();
  const r = target.getBoundingClientRect();
  if (r.right > strip.right) tabbar.scrollLeft += r.right - strip.right;
  const r2 = el.getBoundingClientRect();
  if (r2.left < strip.left) tabbar.scrollLeft -= strip.left - r2.left;
}

// Fade the edge(s) that have tabs hidden beyond them (see #tabs.can-* CSS).
function updateTabFades() {
  const max = tabbar.scrollWidth - tabbar.clientWidth;
  tabbar.classList.toggle("can-left", tabbar.scrollLeft > 1);
  tabbar.classList.toggle("can-right", tabbar.scrollLeft < max - 1);
}
tabbar.addEventListener("scroll", updateTabFades);
window.addEventListener("resize", () => { revealActiveTab(); updateTabFades(); });

// A plain vertical wheel over the strip scrolls it sideways (there's no
// visible scrollbar to grab, and a mouse has no horizontal wheel).
tabbar.addEventListener(
  "wheel",
  (e) => {
    if (tabbar.scrollWidth <= tabbar.clientWidth) return;
    if (e.deltaX !== 0) return; // trackpad already scrolls horizontally
    e.preventDefault();
    tabbar.scrollLeft += e.deltaY;
  },
  { passive: false }
);

// A single click switches tabs; two quick clicks on the same tab rename it.
// We detect the double-click ourselves (rather than via the native `dblclick`
// event) because switchTab() rebuilds the whole tab strip, so the two clicks
// land on different DOM nodes and a native dblclick would be unreliable. The
// timestamp/index state below lives at module scope, so it survives re-renders.
let lastTabClick = { i: -1, t: 0 };
function onTabClick(i) {
  const now = Date.now();
  if (lastTabClick.i === i && now - lastTabClick.t < 400) {
    lastTabClick = { i: -1, t: 0 };
    switchTab(i);   // make sure the tab we're renaming is the active one
    beginRename(i); // re-renders, so query the live node by index inside
    return;
  }
  lastTabClick = { i, t: now };
  switchTab(i);
}

// Swap a tab's title for an inline text field so the user can rename it.
// Enter / blur commits, Escape cancels, and an empty value restores the
// default "Terminal N" label.
function beginRename(i) {
  const el = tabbar.children[i];
  if (!el) return;
  const title = el.querySelector(".tab-title");
  if (!title) return;

  const input = document.createElement("input");
  input.className = "tab-rename";
  input.value = tabs[i].name || `Terminal ${i + 1}`;

  let done = false;
  const commit = (save) => {
    if (done) return; // blur fires after Enter/Escape — only act once.
    done = true;
    if (save) {
      const name = input.value.trim();
      tabs[i].name = name || null; // null => fall back to the default label.
    }
    renderTabs();
    if (activePane) activePane.term.focus();
  };

  // Keep typing/clicks inside the field from switching tabs or reaching the
  // focused terminal.
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") commit(true);
    else if (e.key === "Escape") commit(false);
  });
  input.addEventListener("blur", () => commit(true));

  el.replaceChild(input, title);
  input.focus();
  input.select();
}

// Keep the per-tab terminal count badge fresh after splits/closes/layouts.
// (render() is called by every layout-changing op, so we patch it once here.)
const _render = render;
render = function () {
  _render();
  saveTab(); // applyLayout() swaps `root` wholesale; keep the tab record (and its badge) in sync
  renderTabs();
  applyZoom(); // re-assert focus zoom after any layout change or tab switch
};

// ---------------------------------------------------------------------------
// Confirm before the whole window closes (the "X" button, Alt+F4, etc.).
// Browsers no longer allow a custom message here — they show their own
// generic "leave site?" prompt — but setting returnValue is what triggers it.
// ---------------------------------------------------------------------------
window.addEventListener("beforeunload", (e) => {
  e.preventDefault();
  e.returnValue = "";
});

// ---------------------------------------------------------------------------
// Start up: one tab with one terminal.
// ---------------------------------------------------------------------------
newTab();

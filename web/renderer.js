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
const tabbar = document.getElementById("tabbar");
const picker = document.getElementById("picker");
const layoutBtn = document.getElementById("layout-btn");

// `tabs` holds every open tab; the ACTIVE tab's layout is mirrored into the
// `root` / `activePane` globals below so the rest of the code is unchanged.
// On switch we save the live globals back into the tab, then load the next.
let tabs = [];           // [{ root, activePane }]
let current = -1;        // index of the active tab in `tabs`

let root = null;         // the active tab's live layout tree
let activePane = null;   // the active tab's highlighted pane

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
// A Pane = one terminal + its own connection to a real shell on the server.
// ---------------------------------------------------------------------------
class Pane {
  constructor() {
    this.el = document.createElement("div");
    this.el.className = "pane";

    const termEl = document.createElement("div");
    termEl.className = "pane-term";
    this.el.appendChild(termEl);

    // ✕ close button (shown on hover via CSS).
    const closeBtn = document.createElement("div");
    closeBtn.className = "pane-close";
    closeBtn.textContent = "✕";
    closeBtn.title = "Close terminal";
    closeBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closePane(this);
    });
    this.el.appendChild(closeBtn);

    this.term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      // Change the quoted name below to try other fonts you have installed,
      // e.g. "Consolas", "Lucida Console", "Cascadia Code", "Fira Code".
      fontFamily: "'Cascadia Mono', Consolas, 'Courier New', monospace",
      theme: { background: "#000000", foreground: "#ffffff", cursor: "#ffffff" },
    });
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(termEl);

    // The shell isn't started yet — `ws` stays null until the user picks a
    // starting folder via the overlay below.
    this.ws = null;
    this.startCwd = "";

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

    // For now, skip the folder chooser and just start in the present folder.
    // (The chooser code below is kept — replace the next line with
    // `this.showStartChooser()` to bring the buttons back.)
    this.start(""); // "" => the app's launch folder
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

    const btnOther = document.createElement("button");
    btnOther.className = "start-btn";
    btnOther.textContent = "Other directory (recent)";

    // A list of previously-used folders, revealed when "recent" is clicked.
    const recentList = document.createElement("div");
    recentList.className = "recent-list hidden";

    btnOther.addEventListener("click", async () => {
      // Toggle the list closed if it's already open.
      if (!recentList.classList.contains("hidden")) {
        recentList.classList.add("hidden");
        return;
      }
      recentList.innerHTML = "";
      recentList.classList.remove("hidden");

      let dirs = [];
      try {
        dirs = (await fetch("/recent-dirs").then((r) => r.json())).dirs || [];
      } catch (e) {
        /* fetch failed — show the empty note below */
      }
      // The launch folder already has its own "This directory" button.
      const def = await defaultDir();
      dirs = dirs.filter((d) => d.toLowerCase() !== (def || "").toLowerCase());

      if (dirs.length === 0) {
        const empty = document.createElement("div");
        empty.className = "recent-empty";
        empty.textContent = "No other recent folders yet.";
        recentList.appendChild(empty);
        return;
      }
      dirs.forEach((dir) => {
        const item = document.createElement("button");
        item.className = "recent-item";
        item.textContent = dir;
        item.title = dir;
        item.addEventListener("click", () => this.start(dir));
        recentList.appendChild(item);
      });
    });

    overlay.append(title, btnThis, btnOther, recentList);
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
  connect() {
    this.ws = new WebSocket(`ws://${location.host}/ws`);
    this.ws.onopen = () => {
      this.send({ type: "start", cwd: this.startCwd }); // first message picks the folder
      this.resize();
      this.term.focus();
    };
    this.ws.onmessage = (event) => this.term.write(event.data);
    this.ws.onclose = () => this.term.write("\r\n\x1b[31m[closed]\x1b[0m");
  }

  resize() {
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
      this.send({ type: "input", data: text });
      this.term.focus();
    }
  }

  dispose() {
    this.observer.disconnect();
    try { if (this.ws) this.ws.close(); } catch (e) {}
    this.term.dispose();
    this.el.remove();
  }
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
  // In single mode there's nothing to close, so hide the ✕ (see CSS #grid.single).
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

  if (hit.parent) {
    hit.parent.children.splice(hit.index, 1);
    if (hit.parent.sizes) hit.parent.sizes.splice(hit.index, 1);
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

function showContextMenu(x, y, pane) {
  hideContextMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu";

  const items = [];
  // Clipboard first: Copy (only when something is selected) and Paste.
  if (pane.term.hasSelection()) {
    items.push({ label: "Copy", fn: () => pane.copySelection() });
  }
  items.push({ label: "Paste", fn: () => pane.paste() });
  items.push({ separator: true });
  // Splitting adds a terminal, so only offer it while under the per-tab cap.
  if (countLeaves(root) < MAX_PANES) {
    items.push({ label: "Split left / right", fn: () => splitPane(pane, "row") });
    items.push({ label: "Split top / bottom", fn: () => splitPane(pane, "col") });
  } else {
    items.push({ label: `Max ${MAX_PANES} terminals per tab`, disabled: true });
  }
  // Only offer "Close" when there's more than one terminal.
  if (collectPanes(root).length > 1) {
    items.push({ label: "Close terminal", fn: () => closePane(pane) });
  }
  items.forEach((it) => {
    if (it.separator) {
      const sep = document.createElement("div");
      sep.className = "context-separator";
      menu.appendChild(sep);
      return;
    }
    const row = document.createElement("div");
    row.className = "context-item" + (it.disabled ? " disabled" : "");
    row.textContent = it.label;
    if (!it.disabled) {
      row.addEventListener("click", () => { it.fn(); hideContextMenu(); });
    }
    menu.appendChild(row);
  });

  menu.style.left = x + "px";
  menu.style.top = y + "px";
  document.body.appendChild(menu);
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
    const option = document.createElement("div");
    option.className = "layout-option";

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

layoutBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const opening = picker.classList.contains("hidden");
  if (opening) buildPicker(); // refresh the list for the current terminal count
  picker.classList.toggle("hidden");
});

// Click elsewhere closes the picker and the right-click menu.
document.addEventListener("mousedown", (e) => {
  if (!picker.contains(e.target) && e.target !== layoutBtn) hidePicker();
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
}

// Make the given tab the active one and mirror it into the globals.
function loadTab() {
  root = tabs[current].root;
  activePane = tabs[current].activePane;
}

function newTab() {
  saveTab();
  const t = { root: leaf(new Pane()), activePane: null };
  t.activePane = t.root.pane;
  tabs.push(t);
  current = tabs.length - 1;
  loadTab();
  renderTabs();
  render();
  if (activePane) activePane.term.focus();
}

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
    el.addEventListener("click", () => switchTab(i));

    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = `Terminal ${i + 1}`;
    el.appendChild(title);

    // How many terminals this tab holds (X / 4).
    const count = document.createElement("span");
    count.className = "tab-count";
    count.textContent = `${countLeaves(t.root)}/${MAX_PANES}`;
    el.appendChild(count);

    if (tabs.length > 1) {
      const x = document.createElement("span");
      x.className = "tab-close";
      x.textContent = "✕";
      x.title = "Close tab";
      x.addEventListener("click", (e) => { e.stopPropagation(); closeTab(i); });
      el.appendChild(x);
    }
    tabbar.appendChild(el);
  });

  const add = document.createElement("div");
  add.className = "tab-add";
  add.textContent = "+";
  add.title = "New tab";
  add.addEventListener("click", newTab);
  tabbar.appendChild(add);
}

// Keep the per-tab terminal count badge fresh after splits/closes/layouts.
// (render() is called by every layout-changing op, so we patch it once here.)
const _render = render;
render = function () {
  _render();
  renderTabs();
};

// ---------------------------------------------------------------------------
// Start up: one tab with one terminal.
// ---------------------------------------------------------------------------
newTab();

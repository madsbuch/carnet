import { ask } from "@tauri-apps/plugin-dialog";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { basename, contentHash, DAILY_RE, dirOf, normalizePath, noteTitle, resolveLink } from "../links";
import { buildGraph, dailyPath, searchNotes, type GraphData } from "../graph-data";
import * as backend from "./backend";
import { BlockView } from "./blockview";
import { GraphView } from "./graph";
import { setupWiki } from "./wiki";

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const previewEl = $<HTMLElement>("#preview");
const editorEl = $<HTMLTextAreaElement>("#editor");
const backlinksEl = $<HTMLElement>("#backlinks");
const treeEl = $<HTMLElement>("#tree");
const toastEl = $<HTMLElement>("#toast");
const qoEl = $<HTMLElement>("#quickopen");
const qoInput = $<HTMLInputElement>("#qo-input");
const qoList = $<HTMLUListElement>("#qo-list");
const setupEl = $<HTMLElement>("#setup");
const setupPath = $<HTMLInputElement>("#setup-path");

let paths: string[] = [];
let note: backend.Note | null = null;
/** Hash of the current note's content as last seen on disk (conflict detection). */
let loadedHash: string | null = null;
let dirty = false;
let editing = false; // raw source mode; block editing lives in blockView
let allNotesCache: backend.Note[] | null = null;
let graphCache: GraphData | null = null;
let lastNoteHash = "";
let started = false;
let loadSeq = 0;
const openDirs = new Set<string>();

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const graphView = new GraphView(
  $<HTMLElement>("#graphview"),
  (path) => openPath(path),
  () => exitGraph(),
);

const blockView = new BlockView(previewEl, {
  content: () => note?.content ?? "",
  update: (next) => {
    if (!note) return;
    note.content = next;
    dirty = true;
    updateDirty();
    scheduleSave();
  },
  wikiExists: (name) => note !== null && resolveLink(name, note.path, paths) !== null,
  followWiki: (name) => followWiki(name),
  openRelative: (href) => {
    if (note) openPath(normalizePath(dirOf(note.path) + safeDecode(href)));
  },
  openExternal: (url) => void backend.openUrl(url).catch((err) => toast(String(err))),
  imageSrc: (src) => {
    if (!note || !src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("/")) return null;
    return backend.assetUrl(normalizePath(dirOf(note.path) + safeDecode(src)));
  },
});

/* ---------- caches ---------- */

function invalidate(): void {
  allNotesCache = null;
  graphCache = null;
}

async function getAllNotes(): Promise<backend.Note[]> {
  return (allNotesCache ??= await backend.readAllNotes());
}

async function getGraph(): Promise<GraphData> {
  return (graphCache ??= buildGraph(await getAllNotes()));
}

/* ---------- toast ---------- */

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 3000);
}

/* ---------- saving ---------- */

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 800);
}

function updateDirty(): void {
  $("#dirty-dot").hidden = !dirty;
}

// Saves are serialized through a queue: overlapping writes of the same note
// would race each other's mtime and produce phantom conflict dialogs.
let saveQueue: Promise<void> = Promise.resolve();
function save(): Promise<void> {
  const run = saveQueue.then(() => doSave());
  saveQueue = run.catch(() => {});
  return run;
}

async function doSave(): Promise<void> {
  clearTimeout(saveTimer);
  if (!note || !dirty) return;
  const n = note;
  const contentAtSave = n.content;
  try {
    let res = await backend.writeNote(n.path, contentAtSave, n.mtime, loadedHash ?? undefined);
    if (res.status === "conflict") {
      const keepMine = await ask(
        "This note changed on disk — probably synced from another device. Which version should win?",
        { title: "Note changed on disk", okLabel: "Keep mine", cancelLabel: "Load disk version" },
      );
      if (keepMine) {
        res = await backend.writeNote(n.path, contentAtSave);
      } else {
        n.content = res.content;
        n.mtime = res.mtime;
        if (note === n) {
          loadedHash = contentHash(res.content);
          dirty = false;
          updateDirty();
          if (editing) editorEl.value = n.content;
          else renderPreview();
        }
        invalidate();
        return;
      }
    }
    if (res.status === "ok") {
      n.mtime = res.mtime;
      if (note === n) loadedHash = contentHash(contentAtSave);
    }
    if (note === n && n.content === contentAtSave) {
      dirty = false;
      updateDirty();
    }
    invalidate();
  } catch (e) {
    toast("Save failed: " + e);
  }
}

/* ---------- navigation ---------- */

function openPath(path: string): void {
  const target = "#/n/" + encodeURIComponent(path);
  if (location.hash === target) void loadNote(path);
  else location.hash = target;
}

function openDaily(): void {
  openPath(dailyPath(paths).path);
}

function exitGraph(): void {
  if (location.hash === "#/graph") location.hash = lastNoteHash || "#/";
  else graphView.hide();
}

function route(): void {
  const h = location.hash;
  if (h === "#/graph") {
    void openGraph();
    return;
  }
  graphView.hide();
  if (h.startsWith("#/n/")) {
    lastNoteHash = h;
    void loadNote(normalizePath(decodeURIComponent(h.slice(4))));
  } else {
    openDaily();
  }
}

async function loadNote(path: string): Promise<void> {
  // re-selecting the current note (sidebar, graph exit) must not blow away
  // an in-progress edit or re-render under the user
  if (note?.path === path && (dirty || editing || blockView.hasActiveEdit())) {
    renderTree();
    return;
  }
  blockView.flush(); // end any edit session — it must not survive into another note
  const seq = ++loadSeq;
  await save();
  if (seq !== loadSeq) return;
  try {
    let n = await backend.readNote(path);
    if (seq !== loadSeq) return;
    let created = false;
    if (!n) {
      // baseMtime 0: if the file appears concurrently (Dropbox sync), the
      // write conflicts instead of wiping it — then adopt the disk version
      const res = await backend.writeNote(path, "", 0);
      if (seq !== loadSeq) return;
      if (res.status === "conflict") {
        n = { path, content: res.content, mtime: res.mtime };
      } else {
        n = { path, content: "", mtime: res.mtime };
        created = true;
        toast("Created " + path);
      }
      if (!paths.includes(path)) {
        paths.push(path);
        paths.sort();
      }
      invalidate();
    }
    note = n;
    loadedHash = contentHash(n.content);
    dirty = false;
    editing = false;
    addRecent(path);
    renderAll();
    window.scrollTo(0, 0);
    if (created) blockView.openFirst();
  } catch (e) {
    toast(String(e));
  }
}

async function openGraph(): Promise<void> {
  try {
    const g = await getGraph();
    if (location.hash !== "#/graph") return; // user already navigated away
    graphView.show(g, note?.path ?? null);
  } catch (e) {
    toast(String(e));
  }
}

function followWiki(name: string): void {
  if (!note) return;
  const target = resolveLink(name, note.path, paths);
  if (target) openPath(target);
  else if (name.includes("/")) openPath(normalizePath(name) + ".md");
  else openPath(dirOf(note.path) + name + ".md");
}

/* ---------- rendering ---------- */

function renderAll(): void {
  const title = note ? noteTitle(note.path) : "Carnet";
  $("#note-title").textContent = title;
  $("#note-title").title = note?.path ?? "";
  document.title = note ? `${title} — Carnet` : "Carnet";
  updateDirty();
  if (editing) showEditor();
  else showPreview(false);
  renderTree();
}

function renderPreview(): void {
  if (!note) return;
  blockView.render();
  void renderBacklinks();
}

async function renderBacklinks(): Promise<void> {
  if (!note) {
    backlinksEl.hidden = true;
    return;
  }
  const forPath = note.path;
  let g: GraphData;
  try {
    g = await getGraph();
  } catch {
    return;
  }
  if (note?.path !== forPath || editing) return;
  const sources = [...new Set(g.edges.filter((e) => e.target === forPath).map((e) => e.source))].sort();
  backlinksEl.hidden = sources.length === 0;
  const ul = backlinksEl.querySelector("ul")!;
  ul.innerHTML = "";
  for (const p of sources) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.textContent = noteTitle(p);
    a.title = p;
    a.addEventListener("click", () => openPath(p));
    li.appendChild(a);
    ul.appendChild(li);
  }
}

/* ---------- source (raw markdown) mode ---------- */

function autoSize(): void {
  // never let the collapse-measure cycle scroll the page (WebKit clamps
  // scrollY while the textarea is momentarily at min-height)
  const y = window.scrollY;
  editorEl.style.height = "auto";
  editorEl.style.height = Math.max(editorEl.scrollHeight, window.innerHeight * 0.7) + "px";
  window.scrollTo(0, y);
}

function showEditor(): void {
  if (!note) return;
  blockView.flush(); // source mode replaces the block session entirely
  editing = true;
  editorEl.value = note.content;
  previewEl.hidden = true;
  backlinksEl.hidden = true;
  editorEl.hidden = false;
  $("#ic-edit").hidden = true;
  $("#ic-done").hidden = false;
  autoSize();
  editorEl.focus();
}

function showPreview(saveFirst = true): void {
  editing = false;
  editorEl.hidden = true;
  previewEl.hidden = false;
  $("#ic-edit").hidden = false;
  $("#ic-done").hidden = true;
  renderPreview();
  if (saveFirst) void save();
}

/* ---------- sidebar tree ---------- */

interface DirNode {
  dirs: Map<string, DirNode>;
  files: string[];
}

function renderTree(): void {
  const root: DirNode = { dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.split("/");
    let d = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!d.dirs.has(parts[i])) d.dirs.set(parts[i], { dirs: new Map(), files: [] });
      d = d.dirs.get(parts[i])!;
    }
    d.files.push(p);
  }
  treeEl.innerHTML = "";
  treeEl.appendChild(renderDir(root, ""));
}

function renderDir(d: DirNode, prefix: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const [name, sub] of [...d.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
    const dirPath = prefix + name + "/";
    const det = document.createElement("details");
    det.open = openDirs.has(dirPath) || (note?.path.startsWith(dirPath) ?? false);
    det.addEventListener("toggle", () => {
      if (det.open) openDirs.add(dirPath);
      else openDirs.delete(dirPath);
    });
    const sum = document.createElement("summary");
    sum.textContent = name;
    det.appendChild(sum);
    det.appendChild(renderDir(sub, dirPath));
    frag.appendChild(det);
  }
  const regular = d.files.filter((p) => !DAILY_RE.test(basename(p))).sort();
  const daily = d.files.filter((p) => DAILY_RE.test(basename(p))).sort().reverse();
  for (const p of [...regular, ...daily]) {
    const a = document.createElement("a");
    a.textContent = noteTitle(p);
    a.title = p;
    if (p === note?.path) a.classList.add("current");
    a.addEventListener("click", () => {
      closeSidebar();
      openPath(p);
    });
    frag.appendChild(a);
  }
  return frag;
}

function toggleSidebar(): void {
  const open = document.body.classList.toggle("sidebar-open");
  $("#backdrop").hidden = !open;
}

function closeSidebar(): void {
  document.body.classList.remove("sidebar-open");
  $("#backdrop").hidden = true;
}

/* ---------- quick open ---------- */

function recents(): string[] {
  try {
    return JSON.parse(localStorage.getItem("carnet.recent") ?? "[]");
  } catch {
    return [];
  }
}

function addRecent(path: string): void {
  const r = [path, ...recents().filter((p) => p !== path)].slice(0, 15);
  localStorage.setItem("carnet.recent", JSON.stringify(r));
}

function fuzzyScore(query: string, path: string): number {
  const q = query.toLowerCase();
  const s = path.toLowerCase();
  let qi = 0;
  let streak = 0;
  let score = 0;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) {
      qi++;
      streak++;
      score += 1 + streak;
      if (i === 0 || "/-_ .".includes(s[i - 1])) score += 6;
    } else {
      streak = 0;
    }
  }
  if (qi < q.length) return -1;
  if (basename(s).startsWith(q)) score += 20;
  return score - s.length * 0.01;
}

interface QoItem {
  path?: string;
  create?: string;
  snippet?: string;
}

let qoItems: QoItem[] = [];
let qoSel = 0;
let qoSearchTimer: ReturnType<typeof setTimeout> | undefined;

function openQuickOpen(): void {
  qoEl.hidden = false;
  qoInput.value = "";
  updateQuickOpen("");
  qoInput.focus();
}

function closeQuickOpen(): void {
  qoEl.hidden = true;
}

function updateQuickOpen(q: string): void {
  clearTimeout(qoSearchTimer);
  if (!q) {
    qoItems = recents()
      .filter((p) => paths.includes(p))
      .map((p) => ({ path: p }));
    renderQoItems();
    return;
  }
  qoItems = paths
    .map((p) => [fuzzyScore(q, p), p] as const)
    .filter(([s]) => s >= 0)
    .sort((a, b) => b[0] - a[0])
    .slice(0, 12)
    .map(([, p]) => ({ path: p }));
  const exact = paths.some((p) => noteTitle(p).toLowerCase() === q.toLowerCase());
  if (!exact) qoItems.push({ create: q });
  renderQoItems();
  if (q.length >= 3) {
    qoSearchTimer = setTimeout(async () => {
      if (qoInput.value.trim() !== q || qoEl.hidden) return;
      try {
        const hits = searchNotes(await getAllNotes(), q, 10).filter(
          (h) => h.snippet !== null && !qoItems.some((it) => it.path === h.path),
        );
        if (qoInput.value.trim() !== q || qoEl.hidden) return;
        const selected = qoItems[qoSel]; // late results must not move the selection
        const createIdx = qoItems.findIndex((it) => it.create !== undefined);
        const extra = hits.map((h) => ({ path: h.path, snippet: h.snippet ?? undefined }));
        if (createIdx >= 0) qoItems.splice(createIdx, 0, ...extra);
        else qoItems.push(...extra);
        const keep = selected ? qoItems.indexOf(selected) : 0;
        renderQoItems(keep >= 0 ? keep : 0);
      } catch {
        /* vault unreadable; leave filename matches */
      }
    }, 150);
  }
}

/** Full rebuild — only when the item list itself changed. */
function renderQoItems(sel = 0): void {
  qoList.innerHTML = "";
  qoItems.forEach((it, i) => {
    const li = document.createElement("li");
    if (it.create !== undefined) {
      li.classList.add("create");
      li.textContent = `Create "${it.create}"`;
    } else if (it.path) {
      li.textContent = noteTitle(it.path);
      const span = document.createElement("span");
      span.className = "qo-path";
      span.textContent = dirOf(it.path);
      li.appendChild(span);
      if (it.snippet) {
        const sn = document.createElement("span");
        sn.className = "qo-snippet";
        sn.textContent = it.snippet;
        li.appendChild(sn);
      }
    }
    // selection changes must not rebuild the list — that resets its scroll
    li.addEventListener("mouseenter", () => updateQoSel(i, false));
    li.addEventListener("click", () => activateQuickOpen(it));
    qoList.appendChild(li);
  });
  updateQoSel(sel, false);
}

function updateQoSel(i: number, scroll = true): void {
  qoSel = Math.max(0, Math.min(i, qoItems.length - 1));
  [...qoList.children].forEach((li, k) => li.classList.toggle("sel", k === qoSel));
  if (scroll) qoList.children[qoSel]?.scrollIntoView({ block: "nearest" });
}

function activateQuickOpen(it: QoItem | undefined): void {
  if (!it) return;
  closeQuickOpen();
  if (it.path) openPath(it.path);
  else if (it.create) {
    const name = it.create.trim();
    const path = normalizePath(name.toLowerCase().endsWith(".md") ? name : name + ".md");
    openPath(path);
  }
}

qoInput.addEventListener("input", () => updateQuickOpen(qoInput.value.trim()));
qoInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    updateQoSel(qoSel + 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    updateQoSel(qoSel - 1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    activateQuickOpen(qoItems[qoSel]);
  }
});
qoEl.addEventListener("click", (e) => {
  if (e.target === qoEl) closeQuickOpen();
});

/* ---------- refresh on focus (Dropbox may have synced) ---------- */

async function refreshFromDisk(): Promise<void> {
  if (!started || !backend.vaultRoot()) return;
  invalidate();
  try {
    paths = await backend.listNotes();
  } catch {
    return;
  }
  renderTree();
  if (!note || dirty || blockView.hasActiveEdit()) return;
  const before = note;
  const fresh = await backend.readNote(note.path).catch(() => null);
  // the world may have moved while we awaited — re-check everything
  if (!fresh || note !== before || dirty || blockView.hasActiveEdit()) return;
  if (fresh.mtime !== note.mtime) {
    note = fresh;
    loadedHash = contentHash(fresh.content);
    if (editing) editorEl.value = fresh.content;
    else renderPreview();
    toast("Updated from disk");
  }
}

/* ---------- setup screen ---------- */

async function showSetup(): Promise<void> {
  setupEl.hidden = false;
  try {
    const home = (await homeDir()).replace(/\/$/, "");
    for (const guess of [home + "/Dropbox", home + "/Library/CloudStorage/Dropbox"]) {
      if (await backend.vaultValid(guess)) {
        setupPath.value = guess;
        break;
      }
    }
  } catch {
    /* mobile: user types the path */
  }
}

async function finishSetup(): Promise<void> {
  const p = setupPath.value.trim().replace(/\/$/, "");
  if (!p) return;
  if (!(await backend.vaultValid(p).catch(() => false))) {
    toast("Not a folder: " + p);
    return;
  }
  backend.setVault(p);
  setupEl.hidden = true;
  await startApp();
}

async function changeVault(): Promise<void> {
  blockView.flush();
  await save();
  closeSidebar();
  graphView.hide();
  backend.clearVault();
  started = false;
  note = null;
  paths = [];
  invalidate();
  history.replaceState(null, "", "#/");
  void showSetup();
}

/* ---------- chrome wiring ---------- */

$("#btn-menu").addEventListener("click", toggleSidebar);
$("#backdrop").addEventListener("click", closeSidebar);
$("#btn-today").addEventListener("click", () => openDaily());
$("#btn-search").addEventListener("click", openQuickOpen);
$("#btn-graph").addEventListener("click", () => (location.hash = "#/graph"));
$("#btn-edit").addEventListener("click", () => (editing ? showPreview() : showEditor()));
$("#btn-new").addEventListener("click", () => {
  closeSidebar();
  openQuickOpen();
});
$("#btn-vault").addEventListener("click", () => void changeVault());
$("#setup-browse").addEventListener("click", async () => {
  try {
    const p = await backend.browseForVault();
    if (p) setupPath.value = p;
    else if (/android/i.test(navigator.userAgent)) toast("On Android, type the folder path instead");
  } catch {
    toast("Folder picker unavailable here — type the path instead");
  }
});
$("#setup-go").addEventListener("click", () => void finishSetup());
setupPath.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void finishSetup();
});

editorEl.addEventListener("input", () => {
  if (!note) return;
  note.content = editorEl.value;
  dirty = true;
  updateDirty();
  scheduleSave();
  autoSize();
});

document.addEventListener("keydown", (e) => {
  if (!started && setupEl.hidden === false) return;
  const target = e.target as HTMLElement | null;
  const inField = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (qoEl.hidden) openQuickOpen();
    else closeQuickOpen();
    return;
  }
  if (mod && e.key.toLowerCase() === "s") {
    e.preventDefault();
    blockView.commit(false);
    void save();
    return;
  }
  if (e.key === "Escape") {
    if (!qoEl.hidden) closeQuickOpen();
    else if (graphView.isOpen) exitGraph();
    else if (editing) showPreview();
    else if (blockView.hasActiveEdit()) blockView.commit();
    else closeSidebar();
    return;
  }
  if (inField || mod || e.altKey) return;
  if (graphView.isOpen) {
    // the graph covers everything — don't let shortcuts act on hidden UI
    if (e.key === "t") openDaily();
    else if (e.key === "g") exitGraph();
    return;
  }
  if (e.key === "e") {
    e.preventDefault();
    if (editing) showPreview();
    else showEditor();
  } else if (e.key === "t") openDaily();
  else if (e.key === "g") location.hash = "#/graph";
  else if (e.key === "b") toggleSidebar();
  else if (e.key === "/") {
    e.preventDefault();
    openQuickOpen();
  }
});

window.addEventListener("focus", () => void refreshFromDisk());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    blockView.commit(false);
    void save();
  } else {
    void refreshFromDisk();
  }
});
window.addEventListener("hashchange", () => {
  if (started) route();
});

// flush the last edits before the window closes (Cmd+Q, red button)
void getCurrentWindow()
  .onCloseRequested(async () => {
    blockView.flush();
    await save();
  })
  .catch(() => {});

/* ---------- boot ---------- */

async function startApp(): Promise<void> {
  try {
    paths = await backend.listNotes();
  } catch (e) {
    toast(String(e));
    backend.clearVault();
    await showSetup();
    return;
  }
  started = true;
  route();
}

async function boot(): Promise<void> {
  setupWiki();
  const root = backend.vaultRoot();
  if (root && (await backend.vaultValid(root).catch(() => false))) {
    await startApp();
  } else {
    await showSetup();
  }
}

void boot();

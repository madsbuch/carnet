// Time the paths Carnet actually runs while you use it, against a real vault on
// disk. Everything here calls the app's own source — nothing is reimplemented,
// so a fix shows up here immediately.
//
//   bun run bench/gen-vault.ts /tmp/vault10k 10000
//   bun run bench/hot-paths.ts /tmp/vault10k
//
// Times are for one desktop CPU core. A mid-range Android phone runs this kind
// of string-heavy JS roughly 4-6x slower; the "phone" column applies 5x.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { buildGraph, searchNotes } from "../src/graph-data";
import { buildLinkIndex, contentHash, fuzzyScore, normalizeTasks, taskLines } from "../src/links";
import { countLabel } from "../src/counts";
import { segmentBlocks } from "../src/blocks";
import { VaultIndex } from "../src/vault-index";
import { scopeAround } from "../src/client/graph";

const ROOT = process.argv[2] ?? "/tmp/vault10k";
const BUDGET_MS = 100; // above this a user notices; above ~1s the app looks hung

function walk(dir: string, rel = "", out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory()) walk(`${dir}/${e.name}`, `${rel}${e.name}/`, out);
    else if (e.name.toLowerCase().endsWith(".md")) out.push(rel + e.name);
  }
  return out;
}

/** Median of `n` runs after one warm-up, so JIT noise doesn't dominate. */
function ms(f: () => unknown, n = 5): number {
  f();
  const t: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = performance.now();
    f();
    t.push(performance.now() - s);
  }
  return t.sort((a, b) => a - b)[Math.floor(n / 2)]!;
}

const rows: { label: string; t: number; note: string }[] = [];
const row = (label: string, t: number, note = ""): void => void rows.push({ label, t, note });

const paths = walk(ROOT).sort();
const notes = paths.map((p) => ({
  path: p,
  content: readFileSync(`${ROOT}/${p}`, "utf8"),
  mtime: statSync(`${ROOT}/${p}`).mtimeMs,
}));
const megabytes = notes.reduce((a, n) => a + n.content.length, 0) / 1048576;
console.log(`\n${ROOT}: ${notes.length} notes, ${megabytes.toFixed(1)} MB\n`);

/* ---- once per session: loading the vault ---- */
const payload = JSON.stringify(notes);
row("read_all_notes: serialize to JSON (Rust)", ms(() => JSON.stringify(notes), 3), `${(payload.length / 1048576).toFixed(1)} MB payload`);
row("read_all_notes: JSON.parse (webview)", ms(() => JSON.parse(payload), 3), "once per session, not per save");
row("buildLinkIndex(paths)  [when the file list changes]", ms(() => buildLinkIndex(paths), 3));

let index = new VaultIndex([]);
row("VaultIndex build  [once, then edited in place]", ms(() => (index = new VaultIndex(notes)), 1),
  `${index.graph().nodes.length} nodes, ${index.graph().edges.length} edges`);
row("  (buildGraph, the same work done from scratch)", ms(() => buildGraph(notes), 1), "what a save used to cost");

/* ---- per interaction ---- */
const mid = notes[Math.floor(notes.length / 2)]!;
row("backlinks for the open note  [every navigation]", ms(() => index.backlinks(mid.path)));
row("VaultIndex.setContent  [every save]", ms(() => index.setContent(mid.path, mid.content)));
const linked = buildLinkIndex(paths);
row("resolve one wiki link  [every link, every render]", ms(() => { for (let i = 0; i < 1000; i++) linked.resolve("rust-42", paths[i]!); }) / 1000);
row('quick open keystroke ("rust")', ms(() => paths.map((p) => [fuzzyScore("rust", p), p] as const).filter(([s]) => s >= 0).sort((a, b) => b[0] - a[0]).slice(0, 12)));
row("full-text search, worst case (no hits)", ms(() => searchNotes(notes, "zzqqxx-no-such-string", 10)));

const full = index.graph();
let scoped = full;
row("graph: scope to the open note  [pressing g]", ms(() => (scoped = scopeAround(full, mid.path, 2).data)),
  `${scoped.nodes.length} nodes, ${scoped.edges.length} edges shown`);

/* ---- per keystroke / per render, on the biggest note ---- */
const big = notes.find((n) => n.content.length > 150_000)?.content ?? notes[0]!.content;
const bigKb = (big.length / 1024).toFixed(0);
row(`countLabel(${bigKb} KB note)  [debounced, not per keystroke]`, ms(() => countLabel(big)));
row(`contentHash(${bigKb} KB note)  [every save]`, ms(() => contentHash(big)));
row(`segmentBlocks(${bigKb} KB note)  [every render]`, ms(() => segmentBlocks(big)));
row(`normalizeTasks(${bigKb} KB note)  [every render]`, ms(() => normalizeTasks(big)));

// the checklist case: task lines used to be recomputed once per checkbox block
const checklist = Array.from({ length: 4000 }, (_, i) => `- [ ] item ${i}`).join("\n\n");
row("taskLines(4,000-item checklist)  [once per render]", ms(() => taskLines(checklist)));

const w = Math.max(...rows.map((r) => r.label.length));
const bar = "─".repeat(w + 42);
console.log(bar);
console.log(`${"path".padEnd(w)}  ${"desktop".padStart(11)}  ${"phone (~5x)".padStart(12)}`);
console.log(bar);
for (const { label, t, note } of rows) {
  const fmt = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v.toFixed(1)} ms`);
  const flag = t * 5 > BUDGET_MS ? "  ⚠" : "   ";
  console.log(`${label.padEnd(w)}  ${fmt(t).padStart(11)}  ${fmt(t * 5).padStart(12)}${flag}  ${note}`);
}
console.log(bar);
console.log(`the sidebar tree is ${paths.length.toLocaleString()} elements — built only while it is on screen`);
console.log(`the graph draws ${scoped.edges.length.toLocaleString()} edges in one batched path, and parks its rAF loop once settled`);
console.log(`\n⚠ = over ${BUDGET_MS} ms on a phone, i.e. visible to the user\n`);

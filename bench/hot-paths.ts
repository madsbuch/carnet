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
import { contentHash, extractLinks, fuzzyScore, normalizeTasks, resolveLink } from "../src/links";
import { countLabel } from "../src/counts";
import { segmentBlocks } from "../src/blocks";

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

/* ---- what happens when the vault is (re)read ---- */
const payload = JSON.stringify(notes);
row("read_all_notes: serialize to JSON (Rust)", ms(() => JSON.stringify(notes), 3), `${(payload.length / 1048576).toFixed(1)} MB payload`);
row("read_all_notes: JSON.parse (webview)", ms(() => JSON.parse(payload), 3));

/* ---- the link graph: backlinks under every note, and the graph view ---- */
let g = { nodes: [] as unknown[], edges: [] as { source: string; target: string }[] };
row("buildGraph(whole vault)", ms(() => (g = buildGraph(notes) as typeof g), 1), `${g.nodes.length} nodes, ${g.edges.length} edges`);
row("  extractLinks over all notes", ms(() => notes.map((n) => extractLinks(n.content)), 1));
row("  one resolveLink call", ms(() => { for (let i = 0; i < 100; i++) resolveLink("rust-42", paths[i]!, paths); }, 1) / 100, "scans every path — O(vault)");
const target = notes[Math.floor(notes.length / 2)]!.path;
row("backlinks filter over built edges", ms(() => g.edges.filter((e) => e.target === target)));

/* ---- typing and searching ---- */
row('quick open keystroke ("rust")', ms(() => paths.map((p) => [fuzzyScore("rust", p), p] as const).filter(([s]) => s >= 0).sort((a, b) => b[0] - a[0]).slice(0, 12)));
row("full-text search, worst case (no hits)", ms(() => searchNotes(notes, "zzqqxx-no-such-string", 10)));

const big = notes.find((n) => n.content.length > 150_000)?.content ?? notes[0]!.content;
const bigKb = (big.length / 1024).toFixed(0);
row(`countLabel(${bigKb} KB note)  [every keystroke]`, ms(() => countLabel(big)));
row(`contentHash(${bigKb} KB note)  [every save]`, ms(() => contentHash(big)));
row(`segmentBlocks(${bigKb} KB note)  [every render]`, ms(() => segmentBlocks(big)));
row(`normalizeTasks(${bigKb} KB note)  [every render]`, ms(() => normalizeTasks(big)));

/* ---- DOM scale (counts, not times — needs a browser to time) ---- */
const dirs = new Set<string>();
for (const p of paths) {
  const parts = p.split("/");
  for (let i = 0; i < parts.length - 1; i++) dirs.add(parts.slice(0, i + 1).join("/"));
}

const w = Math.max(...rows.map((r) => r.label.length));
const bar = "─".repeat(w + 40);
console.log(bar);
console.log(`${"path".padEnd(w)}  ${"desktop".padStart(11)}  ${"phone (~5x)".padStart(12)}`);
console.log(bar);
for (const { label, t, note } of rows) {
  const fmt = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v.toFixed(1)} ms`);
  const flag = t * 5 > BUDGET_MS ? "  ⚠" : "";
  console.log(`${label.padEnd(w)}  ${fmt(t).padStart(11)}  ${fmt(t * 5).padStart(12)}${flag}  ${note}`);
}
console.log(bar);
console.log(`renderTree builds ${paths.length.toLocaleString()} <a> + ${dirs.size} <details> = ${(paths.length + dirs.size).toLocaleString()} listeners, from scratch, on every navigation`);
console.log(`the graph view draws ${g.edges.length.toLocaleString()} un-batched ctx.stroke() + ${g.nodes.length.toLocaleString()} ctx.arc() per frame`);
console.log(`\n⚠ = over ${BUDGET_MS} ms on a phone, i.e. visible to the user\n`);

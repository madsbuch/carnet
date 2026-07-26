// Build a synthetic vault to measure Carnet against: daily notes, project
// folders, a long tail of topic notes, ~5 wiki links each, plus a couple of
// genuinely large notes. Deterministic, so two runs are comparable.
//
//   bun run bench/gen-vault.ts /tmp/vault10k 10000
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const ROOT = process.argv[2] ?? "/tmp/vault10k";
const N = Number(process.argv[3] ?? 10000);

rmSync(ROOT, { recursive: true, force: true });

let seed = 12345;
const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;

const TOPICS = [
  "rust", "typescript", "tauri", "dropbox", "sync", "markdown", "graph", "search",
  "mobile", "android", "macos", "design", "hiring", "pricing", "roadmap", "retro",
  "meeting", "spec", "bug", "idea", "reading", "recipe", "travel", "finance",
];
const FOLDERS = [
  "projects/carnet", "projects/atlas", "projects/ledger", "areas/work", "areas/home",
  "resources/books", "resources/papers", "archive/2023", "archive/2024", "",
];
const WORDS = (
  "the quick brown fox jumps over a lazy dog while writing notes about " +
  "architecture latency throughput persistence conflict resolution and the general " +
  "problem of keeping ten thousand markdown files coherent across two devices"
).split(" ");

const paths: string[] = [];
const start = Date.UTC(2019, 0, 1);
for (let i = 0; i < Math.min(2000, N * 0.2); i++) {
  paths.push(`journal/${new Date(start + i * 86400000).toISOString().slice(0, 10)}.md`);
}
let k = 0;
while (paths.length < N) {
  const f = pick(FOLDERS);
  paths.push((f ? f + "/" : "") + `${pick(TOPICS)}-${k++}.md`);
}
const titles = paths.map((p) => p.slice(p.lastIndexOf("/") + 1).replace(/\.md$/, ""));

let bytes = 0;
for (let i = 0; i < paths.length; i++) {
  const p = paths[i]!;
  const dir = p.slice(0, p.lastIndexOf("/"));
  if (dir) mkdirSync(`${ROOT}/${dir}`, { recursive: true });
  const lines: string[] = [`# ${titles[i]}`, ""];
  for (let l = 0; l < 5; l++) {
    lines.push(`- see [${titles[Math.floor(rnd() * titles.length)]}] for context`);
  }
  lines.push("");
  for (let q = 0, paras = 3 + Math.floor(rnd() * 4); q < paras; q++) {
    const w: string[] = [];
    for (let j = 0; j < 45; j++) w.push(pick(WORDS));
    lines.push(w.join(" "), "");
  }
  lines.push("- [ ] follow up", "- [x] done already", "", "```ts", "const x = 1;", "```", "");
  const body = lines.join("\n");
  bytes += Buffer.byteLength(body);
  writeFileSync(`${ROOT}/${p}`, body);
}

// the long notes — where per-keystroke work starts to matter
mkdirSync(`${ROOT}/big`, { recursive: true });
for (const [name, kb] of [["big/megafile.md", 200], ["big/huge.md", 500]] as const) {
  const chunk = WORDS.join(" ") + "\n\n";
  let s = "# big\n\n";
  while (Buffer.byteLength(s) < kb * 1024) s += chunk;
  writeFileSync(`${ROOT}/${name}`, s);
  bytes += Buffer.byteLength(s);
}

console.log(
  `${ROOT}: ${paths.length + 2} notes, ${(bytes / 1048576).toFixed(1)} MB markdown`,
);

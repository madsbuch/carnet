// Shared pure helpers — used by both the Bun server and the browser client.

export const DAILY_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Directory of a vault-relative path, with trailing slash ("" for root). */
export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i + 1);
}

export function noteTitle(path: string): string {
  return basename(path).replace(/\.md$/i, "");
}

/** Top-level folder of a path ("" for vault root). */
export function topFolder(path: string): string {
  const i = path.indexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Collapse "." and ".." segments; never escapes above the root. */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const seg of path.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

// Fence opener: at most 3 spaces of indent (4+ is indented code, not a
// fence), optionally behind blockquote prefixes ("> ```").
const FENCE_LINE_RE = /^((?: {0,3}> ?)*) {0,3}(`{3,}|~{3,})/;
const QUOTED_LINE_RE = /^ {0,3}>/;

interface FenceState {
  chars: string;
  quoted: boolean;
}

/**
 * Advance fence state by one line; reports whether the line belongs to a
 * fence (opener, closer, or fenced content). A fence opened inside a
 * blockquote ends when the blockquote does, like markdown renderers close it.
 */
function stepFence(line: string, fence: FenceState | null): { fence: FenceState | null; inFence: boolean } {
  if (fence && fence.quoted && !QUOTED_LINE_RE.test(line)) {
    fence = null; // the blockquote ended and took its fence with it
  }
  const fm = line.match(FENCE_LINE_RE);
  if (fence) {
    if (fm && fm[2][0] === fence.chars[0] && fm[2].length >= fence.chars.length) {
      return { fence: null, inFence: true }; // closing line
    }
    return { fence, inFence: true };
  }
  if (fm) return { fence: { chars: fm[2], quoted: fm[1].length > 0 }, inFence: true };
  return { fence: null, inFence: false };
}

/** Remove fenced code blocks and inline code spans so [links] inside them are ignored. */
export function stripCode(src: string): string {
  const kept: string[] = [];
  let fence: FenceState | null = null;
  for (const line of src.split("\n")) {
    const step = stepFence(line, fence);
    fence = step.fence;
    if (step.inFence) continue;
    kept.push(line.replace(/`[^`]*`/g, ""));
  }
  return kept.join("\n");
}

/**
 * Does this bracketed text count as a wiki link name?
 * Excludes checkboxes ([ ], [x]), footnotes ([^1]) and bare numbers ([1] citations).
 */
export function isWikiName(name: string): boolean {
  return name.length > 0 && !/^[xX ]$/.test(name) && !name.startsWith("^") && !/^\d+$/.test(name);
}

/**
 * Extract wiki link names from markdown: [name] not part of a standard
 * markdown link/image/reference ([text](url), ![alt](src), [a][b], [def]: url).
 */
export function extractLinks(src: string): string[] {
  const clean = stripCode(src);
  // [name]s that have a reference definition ([name]: url) are ordinary
  // markdown links, not notes — the renderer skips them too.
  const defs = new Set<string>();
  const defRe = /^ {0,3}\[([^\]\n]+)\]:\s/gm;
  let dm: RegExpExecArray | null;
  while ((dm = defRe.exec(clean))) defs.add(dm[1].trim().toLowerCase().replace(/\s+/g, " "));
  const names = new Set<string>();
  const re = /(^|[^\]])\[([^\[\]\n]+)\](?!\(|\[|:)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const name = m[2].trim();
    if (isWikiName(name) && !defs.has(name.toLowerCase().replace(/\s+/g, " "))) names.add(name);
  }
  return [...names];
}

/**
 * Subsequence fuzzy match of query against a path: higher is better, -1 means
 * no match. Rewards streaks, word starts, and title prefixes — shared by quick
 * open and the wiki-link type-ahead.
 */
export function fuzzyScore(query: string, path: string): number {
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

/**
 * Link resolution over a prebuilt index. Resolving used to scan every path in
 * the vault per link, which made the graph O(links x notes) — 80 seconds at
 * 10,000 notes. Building this once costs one pass; each lookup is then a Map
 * hit.
 */
export interface LinkIndex {
  /** @see resolveLink */
  resolve(name: string, fromPath: string): string | null;
  /** Does this link point at a note that exists? */
  has(name: string, fromPath: string): boolean;
}

export function buildLinkIndex(allPaths: string[]): LinkIndex {
  // lowercased full path -> path, for [dir/name] links
  const byPath = new Map<string, string>();
  // lowercased basename -> paths that share it, for bare [name] links
  const byName = new Map<string, string[]>();
  for (const p of allPaths) {
    const lower = p.toLowerCase();
    if (!byPath.has(lower)) byPath.set(lower, p);
    const name = basename(lower);
    const same = byName.get(name);
    if (same) same.push(p);
    else byName.set(name, [p]);
  }
  // Shallowest then alphabetical, done once per bucket instead of per lookup.
  // The remaining preference — same folder as the linking note — is the only
  // part that varies by caller, and buckets are almost always one entry long.
  for (const same of byName.values()) {
    if (same.length > 1) {
      same.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    }
  }
  const resolve = (name: string, fromPath: string): string | null => {
    const lower = name.toLowerCase();
    if (lower.includes("/")) {
      return byPath.get(normalizePath(lower.endsWith(".md") ? lower : lower + ".md")) ?? null;
    }
    const same = byName.get(lower + ".md");
    if (!same) return null;
    if (same.length === 1) return same[0];
    const fromDir = dirOf(fromPath);
    return same.find((p) => dirOf(p) === fromDir) ?? same[0];
  };
  return { resolve, has: (name, fromPath) => resolve(name, fromPath) !== null };
}

/**
 * Resolve a wiki link name to a vault path.
 * [name] matches name.md anywhere in the vault (case-insensitive); when several
 * match, prefer the one in the same folder as the linking note, then the
 * shallowest, then alphabetical. [dir/name] matches that exact relative path.
 *
 * One-shot convenience: it builds an index for a single lookup, so anything
 * resolving more than a couple of links should hold a {@link LinkIndex}.
 */
export function resolveLink(name: string, fromPath: string, allPaths: string[]): string | null {
  return buildLinkIndex(allPaths).resolve(name, fromPath);
}

// Mirrors marked's GFM task detection exactly — checkbox N in the rendered
// DOM must map to task line N here, so the renderer and the toggler share
// this pattern. Parity details that matter: ordered markers cap at 9 digits;
// 1-4 spaces (or a tab) between marker and bracket, 5+ renders as code;
// space-or-tab plus non-space content required after the bracket. One
// deliberate extension: an empty "[]" also counts as an unchecked box
// (normalizeTasks hands marked the spec form).
const TASK_RE = /^((?:\s*>)*\s*(?:[-*+]|\d{1,9}[.)])(?: {1,4}|\t)\[)([ xX]?)(\][ \t]+(?=\S))/;

/** Checked state of the task on a single line, or null if it's not a task line. */
export function taskState(line: string): boolean | null {
  const m = line.match(TASK_RE);
  return m ? m[2].toLowerCase() === "x" : null;
}

/** Boolean per line: true when the line is prose, i.e. not part of a fenced code block. */
function proseLineMask(lines: string[]): boolean[] {
  const mask: boolean[] = [];
  let fence: FenceState | null = null;
  for (const line of lines) {
    const step = stepFence(line, fence);
    fence = step.fence;
    mask.push(!step.inFence);
  }
  return mask;
}

/**
 * Rewrite shorthand "- []" tasks to the spec form "- [ ]" that markdown
 * renderers recognize. Render-time only — files keep what was typed.
 */
export function normalizeTasks(src: string): string {
  const lines = src.split("\n");
  const mask = proseLineMask(lines);
  return lines
    .map((line, i) =>
      mask[i] ? line.replace(TASK_RE, (_, pre, mark, post) => pre + (mark || " ") + post) : line,
    )
    .join("\n");
}

/**
 * Absolute 0-based line numbers of every task line in the note, ascending.
 * Computed once per render: the per-block form below used to re-split and
 * re-mask the whole note for each block that held a checkbox, which is
 * quadratic in a long checklist (10 s on a phone for 4,000 items).
 */
export function taskLines(src: string): number[] {
  const lines = src.split("\n");
  const mask = proseLineMask(lines);
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (mask[i] && TASK_RE.test(lines[i])) out.push(i);
  }
  return out;
}

/** The slice of a {@link taskLines} map that falls within [start..end]. */
export function taskLinesInRange(all: number[], start: number, end: number): number[] {
  const from = lowerBound(all, Math.max(start, 0));
  const out: number[] = [];
  for (let i = from; i < all.length && all[i] <= end; i++) out.push(all[i]);
  return out;
}

/** First index whose value is >= target, in an ascending array. */
function lowerBound(sorted: number[], target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Absolute 0-based line numbers of task lines within [start..end], in order. */
export function taskLinesIn(src: string, start: number, end: number): number[] {
  return taskLinesInRange(taskLines(src), start, end);
}

/** Flip the task checkbox on a specific line. Returns the new source, or null. */
export function toggleTaskAtLine(src: string, line: number): string | null {
  const lines = src.split("\n");
  if (line < 0 || line >= lines.length) return null;
  const mask = proseLineMask(lines);
  if (!mask[line] || !TASK_RE.test(lines[line])) return null;
  lines[line] = lines[line].replace(
    TASK_RE,
    (_, pre, mark, post) => pre + (mark === "x" || mark === "X" ? " " : "x") + post,
  );
  return lines.join("\n");
}

/**
 * djb2-xor over UTF-8 bytes, hex-encoded. Used to detect on-disk changes
 * regardless of mtime games — MUST stay identical to djb2() in
 * src-tauri/src/lib.rs (both files carry the same test vectors).
 *
 * 64-bit, kept as two 32-bit halves because JS has no u64 and BigInt is far
 * too slow over a whole note. Width matters here: this is the authoritative
 * "did the file change under us" check, and a collision means silently
 * overwriting the other device's edit.
 */
export function contentHash(s: string): string {
  let hi = 0;
  let lo = 5381;
  for (const b of new TextEncoder().encode(s)) {
    // h *= 33, carrying from the low half into the high half
    const scaled = lo * 33; // < 2^37, still exact as a double
    hi = (hi * 33 + Math.floor(scaled / 4294967296)) >>> 0;
    lo = ((scaled >>> 0) ^ b) >>> 0;
  }
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

export function todayName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.md`;
}

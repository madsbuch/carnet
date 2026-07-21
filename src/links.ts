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

// Fence opener, allowing blockquote prefixes ("> ```") like markdown does.
const FENCE_LINE_RE = /^\s*(?:>\s*)*(`{3,}|~{3,})/;

/** Remove fenced code blocks and inline code spans so [links] inside them are ignored. */
export function stripCode(src: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of src.split("\n")) {
    const m = line.match(FENCE_LINE_RE);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      continue;
    }
    if (m) {
      fence = m[1];
      continue;
    }
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
 * Resolve a wiki link name to a vault path.
 * [name] matches name.md anywhere in the vault (case-insensitive); when several
 * match, prefer the one in the same folder as the linking note, then the
 * shallowest, then alphabetical. [dir/name] matches that exact relative path.
 */
export function resolveLink(name: string, fromPath: string, allPaths: string[]): string | null {
  const lower = name.toLowerCase();
  if (lower.includes("/")) {
    const target = normalizePath(lower.endsWith(".md") ? lower : lower + ".md");
    return allPaths.find((p) => p.toLowerCase() === target) ?? null;
  }
  const candidates = allPaths.filter((p) => basename(p).toLowerCase() === lower + ".md");
  if (candidates.length === 0) return null;
  const fromDir = dirOf(fromPath);
  candidates.sort(
    (a, b) =>
      (dirOf(a) === fromDir ? 0 : 1) - (dirOf(b) === fromDir ? 0 : 1) ||
      a.split("/").length - b.split("/").length ||
      a.localeCompare(b),
  );
  return candidates[0];
}

// Mirrors marked's GFM task detection — a space AND non-space content after
// the bracket are required (marked: /^\[[ xX]\] +\S/), tasks may sit inside
// blockquotes — plus one deliberate extension: an empty "[]" also counts as
// an unchecked box (normalizeTasks hands marked the spec form). Checkbox N in
// the rendered DOM must map to task line N here, so the renderer and the
// toggler share this exact pattern.
const TASK_RE = /^((?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+\[)([ xX]?)(\] +(?=\S))/;

/** Boolean per line: true when the line is prose, i.e. not part of a fenced code block. */
function proseLineMask(lines: string[]): boolean[] {
  const mask: boolean[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const fm = line.match(FENCE_LINE_RE);
    if (fence) {
      mask.push(false);
      if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length) fence = null;
    } else if (fm) {
      mask.push(false);
      fence = fm[1];
    } else {
      mask.push(true);
    }
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

/** Absolute 0-based line numbers of task lines within [start..end], in order. */
export function taskLinesIn(src: string, start: number, end: number): number[] {
  const lines = src.split("\n");
  const mask = proseLineMask(lines);
  const out: number[] = [];
  for (let i = Math.max(start, 0); i <= Math.min(end, lines.length - 1); i++) {
    if (mask[i] && TASK_RE.test(lines[i])) out.push(i);
  }
  return out;
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

export function todayName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.md`;
}

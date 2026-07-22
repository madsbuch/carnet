// Line-range block model over markdown source, for in-place block editing.
// Blocks tile the file exactly — concatenating all ranges reproduces the
// source line-for-line — so editing a block is a plain line splice. The
// segmentation tracks CommonMark closely; where marked might disagree (exotic
// nesting), the renderer verifies its own block↔DOM mapping and falls back to
// coarser blocks, so a mismatch can never corrupt an edit.

export type BlockType = "p" | "heading" | "item" | "quote" | "code" | "hr" | "blank";

export interface Block {
  type: BlockType;
  /** inclusive 0-based line range */
  start: number;
  end: number;
  // item-only:
  ordered?: boolean;
  task?: boolean;
  checked?: boolean;
  indent?: number;
  marker?: string;
}

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;
const HEADING_RE = /^ {0,3}#{1,6}\s/;
const HR_RE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
// max 3 spaces of indent — 4+ is indented code, not a fence (CommonMark)
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const QUOTE_RE = /^ {0,3}>/;
const SETEXT_RE = /^ {0,3}(=+|-+)\s*$/;
const TASK_MARK_RE = /^\[([ xX]?)\][ \t]+/;

function leadingWidth(line: string): number {
  let c = 0;
  for (const ch of line) {
    if (ch === " ") c += 1;
    else if (ch === "\t") c += 4;
    else break;
  }
  return c;
}

/** A line that lazily continues a paragraph-like block (not a new block starter). */
function isLazy(line: string): boolean {
  if (line.trim() === "") return false;
  if (HEADING_RE.test(line) || HR_RE.test(line) || FENCE_RE.test(line) || QUOTE_RE.test(line)) return false;
  const lm = line.match(LIST_RE);
  if (lm && lm[1].length <= 3) return false;
  return true;
}

export function segmentBlocks(src: string): Block[] {
  const lines = src.split("\n");
  const blocks: Block[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];

    if (line.trim() === "") {
      let j = i;
      while (j + 1 < n && lines[j + 1].trim() === "") j++;
      blocks.push({ type: "blank", start: i, end: j });
      i = j + 1;
      continue;
    }

    const fm = line.match(FENCE_RE);
    if (fm) {
      let j = i + 1;
      while (j < n) {
        const cm = lines[j].match(FENCE_RE);
        if (cm && cm[1][0] === fm[1][0] && cm[1].length >= fm[1].length) break;
        j++;
      }
      const end = Math.min(j, n - 1);
      blocks.push({ type: "code", start: i, end });
      i = end + 1;
      continue;
    }

    if (HEADING_RE.test(line)) {
      blocks.push({ type: "heading", start: i, end: i });
      i++;
      continue;
    }

    // thematic break beats a list item ("- - -")
    if (HR_RE.test(line)) {
      blocks.push({ type: "hr", start: i, end: i });
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      let j = i;
      while (j + 1 < n && (QUOTE_RE.test(lines[j + 1]) || isLazy(lines[j + 1]))) j++;
      blocks.push({ type: "quote", start: i, end: j });
      i = j + 1;
      continue;
    }

    const lm = line.match(LIST_RE);
    if (lm && lm[1].length <= 3) {
      const indent = lm[1].length;
      // content column: children must be indented at least this far
      const contIndent = indent + lm[2].length + 1;
      let j = i;
      while (j + 1 < n) {
        const next = lines[j + 1];
        if (next.trim() === "") {
          // a blank stays inside the item only when indented content follows
          if (j + 2 < n && lines[j + 2].trim() !== "" && leadingWidth(lines[j + 2]) >= contIndent) j++;
          else break;
        } else if (leadingWidth(next) >= contIndent) {
          j++; // nested item or indented continuation
        } else {
          const nlm = next.match(LIST_RE);
          if (nlm) break; // sibling or outdented item
          if (!isLazy(next)) break;
          j++; // lazy continuation
        }
      }
      const body = lm[4];
      const tm = body.match(TASK_MARK_RE);
      blocks.push({
        type: "item",
        start: i,
        end: j,
        ordered: /\d/.test(lm[2][0]),
        indent,
        marker: lm[2],
        task: tm !== null,
        checked: tm ? tm[1].toLowerCase() === "x" : undefined,
      });
      i = j + 1;
      continue;
    }

    // paragraph — possibly a setext heading once we see its underline
    let j = i;
    let setext = false;
    while (j + 1 < n) {
      const next = lines[j + 1];
      if (SETEXT_RE.test(next)) {
        j++;
        setext = true;
        break;
      }
      if (!isLazy(next)) break;
      j++;
    }
    blocks.push({ type: setext ? "heading" : "p", start: i, end: j });
    i = j + 1;
  }
  return blocks;
}

export type TargetType = "p" | "h1" | "h2" | "h3" | "bullet" | "task" | "quote";

/** Remove heading/list/task/quote dressing from a single block's text. */
export function stripBlockPrefixes(text: string): string {
  const lines = text.split("\n");
  if (lines.length > 1 && SETEXT_RE.test(lines[1]) && lines[0].trim() !== "") {
    return [lines[0], ...lines.slice(2)].join("\n");
  }
  if (QUOTE_RE.test(lines[0])) {
    return lines.map((l) => l.replace(/^ {0,3}> ?/, "")).join("\n");
  }
  const h = lines[0].match(/^ {0,3}(#{1,6})\s+/);
  if (h) {
    return [lines[0].slice(h[0].length), ...lines.slice(1)].join("\n");
  }
  const lm = lines[0].match(LIST_RE);
  if (lm) {
    const width = lm[1].length + lm[2].length + lm[3].length;
    let body = lm[4];
    const tm = body.match(TASK_MARK_RE);
    if (tm) body = body.slice(tm[0].length);
    const dedent = new RegExp(`^ {0,${width}}`);
    return [body, ...lines.slice(1).map((l) => l.replace(dedent, ""))].join("\n");
  }
  return text;
}

/** Rewrite one block's text to a new block type (operates on text, not the file). */
export function convertBlock(text: string, target: TargetType): string {
  const lines = stripBlockPrefixes(text).split("\n");
  switch (target) {
    case "p":
      return lines.join("\n");
    case "h1":
    case "h2":
    case "h3": {
      const hashes = "#".repeat(Number(target[1]));
      return lines.map((l, i) => (i === 0 ? `${hashes} ${l}` : l)).join("\n");
    }
    case "quote":
      return lines.map((l) => (l.trim() === "" ? ">" : `> ${l}`)).join("\n");
    case "bullet":
      return lines.map((l, i) => (i === 0 ? `- ${l}` : l.trim() === "" ? l : `  ${l}`)).join("\n");
    case "task":
      return lines.map((l, i) => (i === 0 ? `- [ ] ${l}` : l.trim() === "" ? l : `  ${l}`)).join("\n");
  }
}

/**
 * Split a block's text at pos and put a thematic break between the halves.
 * Returns the replacement lines and the index (into those lines) of the line
 * that should receive the caret — always the first line after the break, so
 * the flow is "tap separator, keep writing below it".
 */
export function insertSeparator(text: string, pos: number): { lines: string[]; caret: number } {
  const before = text.slice(0, pos);
  const after = text.slice(pos);
  const beforeLines = before.trim() === "" ? [] : before.split("\n");
  const afterLines = after.trim() === "" ? [""] : after.split("\n");
  const lines = [...beforeLines, ...(beforeLines.length > 0 ? [""] : []), "---", "", ...afterLines];
  return { lines, caret: lines.length - afterLines.length };
}

/** Column where an item line's text content starts (after marker and task box). */
export function itemContentStart(text: string): number {
  const firstLine = text.includes("\n") ? text.slice(0, text.indexOf("\n")) : text;
  const lm = firstLine.match(LIST_RE);
  if (!lm) return 0;
  let w = lm[1].length + lm[2].length + lm[3].length;
  const tm = lm[4].match(TASK_MARK_RE);
  if (tm) w += tm[0].length;
  return w;
}

/** The line prefix a new sibling of this item should get ("- ", "3. ", "- [ ] "…). */
export function nextItemPrefix(b: Block): string {
  const ind = " ".repeat(b.indent ?? 0);
  let marker = b.marker ?? "-";
  if (b.ordered) {
    marker = String(parseInt(marker, 10) + 1) + marker[marker.length - 1];
  }
  return `${ind}${marker} ${b.task ? "[ ] " : ""}`;
}

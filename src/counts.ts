// Word and character counts over markdown source — the numbers behind the
// faint counter under the note and under the block being edited.
//
// Counting is syntax-blind but marker-aware: a token counts as a word only if
// it holds a letter or a digit, so the dressing markdown needs ("#", "-",
// "[ ]", "```", "---") never inflates the count, while words inside a link or
// a code block do — that's text you wrote. Characters are code points of the
// raw source (an emoji is one, spaces and newlines count), so the number
// matches what the textarea in front of you holds.

export interface Counts {
  words: number;
  chars: number;
}

// Han and kana characters carry no spaces between them, so each one counts as
// a word — what CJK word counters do. Their punctuation (。、〜) is Script=Common
// but shares their script extension, hence the lookahead. Everything else is a
// run of letters/digits, kept whole across in-word apostrophes, hyphens and
// underscores ("don't", "well-known", "2026-07-21" are one word each).
const WORD_RE =
  /(?![\p{P}\p{S}])[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]|[\p{L}\p{N}]+(?:['’\-_][\p{L}\p{N}]+)*/gu;

// A task box is dressing, so its "x" must not read as a word. Only boxes behind
// a list marker are stripped — a bare "[x]" in prose is text like any other.
const TASK_BOX_RE = /^((?:\s*>)*\s*(?:[-*+]|\d{1,9}[.)])(?: {1,4}|\t))\[[ xX]?\]/gm;

export function countText(text: string): Counts {
  const prose = text.replace(TASK_BOX_RE, "$1");
  return { words: prose.match(WORD_RE)?.length ?? 0, chars: [...text].length };
}

/** "12 words · 68 chars", or "" when there is nothing worth counting. */
export function countLabel(text: string): string {
  if (text.trim() === "") return "";
  const { words, chars } = countText(text);
  const n = (v: number): string => v.toLocaleString();
  return `${n(words)} ${words === 1 ? "word" : "words"} · ${n(chars)} ${chars === 1 ? "char" : "chars"}`;
}

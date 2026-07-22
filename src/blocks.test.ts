import { describe, expect, test } from "bun:test";
import {
  convertBlock,
  insertSeparator,
  itemContentStart,
  nextItemPrefix,
  segmentBlocks,
  stripBlockPrefixes,
  type Block,
} from "./blocks";

/** Blocks must tile the source exactly — that's what makes line-splice edits safe. */
function expectTiling(src: string) {
  const blocks = segmentBlocks(src);
  const n = src.split("\n").length;
  let expected = 0;
  for (const b of blocks) {
    expect(b.start).toBe(expected);
    expect(b.end).toBeGreaterThanOrEqual(b.start);
    expected = b.end + 1;
  }
  expect(expected).toBe(n);
  return blocks;
}

describe("segmentBlocks", () => {
  test("tiles typical daily-note content exactly", () => {
    const src = [
      "# 2026-07-21",
      "",
      "Some thought about [carnet].",
      "It continues here.",
      "",
      "- [ ] pay taxes",
      "- [] shorthand box",
      "- plain item",
      "  - nested child",
      "",
      "> a quote",
      "```",
      "- [ ] not a task",
      "```",
      "---",
    ].join("\n");
    const blocks = expectTiling(src);
    const types = blocks.map((b) => b.type);
    expect(types).toEqual([
      "heading", "blank", "p", "blank",
      "item", "item", "item", "blank",
      "quote", "code", "hr",
    ]);
  });

  test("keeps a nested child inside its parent item", () => {
    const blocks = segmentBlocks("- parent\n  - child\n- sibling");
    const items = blocks.filter((b) => b.type === "item");
    expect(items).toHaveLength(2);
    expect(items[0].start).toBe(0);
    expect(items[0].end).toBe(1);
    expect(items[1].start).toBe(2);
  });

  test("absorbs lazy continuation lines into items and paragraphs", () => {
    const blocks = segmentBlocks("- item\nlazy line\n\npara\nlazy too");
    expect(blocks[0]).toMatchObject({ type: "item", start: 0, end: 1 });
    expect(blocks[2]).toMatchObject({ type: "p", start: 3, end: 4 });
  });

  test("detects task metadata including the [] shorthand", () => {
    const blocks = segmentBlocks("- [ ] open\n- [x] done\n- [] shorthand\n- not a task");
    const items = blocks.filter((b) => b.type === "item");
    expect(items.map((b) => b.task)).toEqual([true, true, true, false]);
    expect(items.map((b) => b.checked)).toEqual([false, true, false, undefined]);
  });

  test("setext underline joins its paragraph as a heading", () => {
    const blocks = segmentBlocks("Title\n---\nbody");
    expect(blocks[0]).toMatchObject({ type: "heading", start: 0, end: 1 });
    expect(blocks[1]).toMatchObject({ type: "p", start: 2 });
  });

  test("hr wins over list for - - -", () => {
    expect(segmentBlocks("- - -")[0].type).toBe("hr");
  });

  test("unclosed fence swallows the rest of the file", () => {
    const blocks = segmentBlocks("```js\ncode\nmore");
    expect(blocks).toEqual([{ type: "code", start: 0, end: 2 }]);
  });

  test("ordered items carry marker info", () => {
    const items = segmentBlocks("1. first\n2. second").filter((b) => b.type === "item");
    expect(items[0]).toMatchObject({ ordered: true, marker: "1." });
  });

  test("a 2-space-indented bullet under an ordered item is a new block (CommonMark)", () => {
    const blocks = segmentBlocks("1. a\n  - b");
    expect(blocks.filter((b) => b.type === "item")).toHaveLength(2);
  });
});

describe("convertBlock / stripBlockPrefixes", () => {
  test("paragraph to heading and back", () => {
    expect(convertBlock("hello", "h2")).toBe("## hello");
    expect(convertBlock("## hello", "p")).toBe("hello");
  });

  test("paragraph to task and bullet", () => {
    expect(convertBlock("buy milk", "task")).toBe("- [ ] buy milk");
    expect(convertBlock("- [ ] buy milk", "bullet")).toBe("- buy milk");
    expect(convertBlock("- buy milk", "p")).toBe("buy milk");
  });

  test("item with nested child keeps the child indented under the new type", () => {
    expect(convertBlock("- parent\n  - child", "task")).toBe("- [ ] parent\n  - child");
  });

  test("quote round trip", () => {
    expect(convertBlock("a line", "quote")).toBe("> a line");
    expect(convertBlock("> a line", "p")).toBe("a line");
  });

  test("setext heading strips to its text", () => {
    expect(stripBlockPrefixes("Title\n---")).toBe("Title");
  });
});

describe("itemContentStart", () => {
  test("finds where item text begins, past marker and task box", () => {
    expect(itemContentStart("- foo")).toBe(2);
    expect(itemContentStart("- [ ] foo")).toBe(6);
    expect(itemContentStart("- [] foo")).toBe(5);
    expect(itemContentStart("  3. [x] bar")).toBe(9);
    expect(itemContentStart("plain text")).toBe(0);
    expect(itemContentStart("- multi\n  line")).toBe(2);
  });
});

describe("nextItemPrefix", () => {
  test("bullet, task, and ordered items", () => {
    const item = (over: Partial<Block>): Block => ({ type: "item", start: 0, end: 0, ...over });
    expect(nextItemPrefix(item({ marker: "-", indent: 0 }))).toBe("- ");
    expect(nextItemPrefix(item({ marker: "-", indent: 0, task: true }))).toBe("- [ ] ");
    expect(nextItemPrefix(item({ marker: "3.", indent: 0, ordered: true }))).toBe("4. ");
    expect(nextItemPrefix(item({ marker: "1)", indent: 2, ordered: true }))).toBe("  2) ");
  });
});

describe("insertSeparator", () => {
  test("empty block becomes a separator with a fresh line below", () => {
    const { lines, caret } = insertSeparator("", 0);
    expect(lines).toEqual(["---", "", ""]);
    expect(lines[caret]).toBe("");
    expect(caret).toBe(2);
  });

  test("caret at end of text puts the break after it", () => {
    const text = "some thought";
    const { lines, caret } = insertSeparator(text, text.length);
    expect(lines).toEqual(["some thought", "", "---", "", ""]);
    expect(caret).toBe(4);
  });

  test("caret mid-text splits into two blocks around the break", () => {
    const text = "before after";
    const { lines, caret } = insertSeparator(text, "before ".length);
    expect(lines).toEqual(["before ", "", "---", "", "after"]);
    expect(lines[caret]).toBe("after");
  });

  test("the produced lines segment as p / hr / p", () => {
    const { lines } = insertSeparator("before after", "before ".length);
    const types = segmentBlocks(lines.join("\n")).map((b) => b.type);
    expect(types).toEqual(["p", "blank", "hr", "blank", "p"]);
  });
});

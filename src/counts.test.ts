import { describe, expect, test } from "bun:test";
import { countLabel, countText } from "./counts";

describe("countText", () => {
  test("counts plain prose", () => {
    expect(countText("Some thought about notes.")).toEqual({ words: 4, chars: 25 });
  });

  test("markdown dressing is not words", () => {
    expect(countText("# Heading").words).toBe(1);
    expect(countText("- [ ] pay taxes").words).toBe(2);
    expect(countText("- [x] done").words).toBe(1);
    expect(countText("> a quote").words).toBe(2);
    expect(countText("---").words).toBe(0);
    expect(countText("- - -").words).toBe(0);
    expect(countText("* * *\n\n***").words).toBe(0);
  });

  test("wiki and markdown links count their text", () => {
    expect(countText("see [carnet]").words).toBe(2);
    // no URL parsing: a link target counts like the rest of the text
    expect(countText("[the docs](https://example.com)").words).toBe(5);
  });

  test("apostrophes, hyphens and underscores stay inside one word", () => {
    expect(countText("don't").words).toBe(1);
    expect(countText("don’t").words).toBe(1);
    expect(countText("well-known snake_case 2026-07-21").words).toBe(3);
  });

  test("trailing punctuation and dashes are not words of their own", () => {
    expect(countText("yes — really, no?").words).toBe(3);
  });

  test("CJK counts per character, Korean per space-separated word", () => {
    expect(countText("日本語のノート").words).toBe(7);
    expect(countText("日本語です。メモ").words).toBe(7); // the full stop is not a word
    expect(countText("메모 두 개").words).toBe(3);
  });

  test("characters are code points, including spaces and newlines", () => {
    expect(countText("a b\nc").chars).toBe(5);
    expect(countText("🚀").chars).toBe(1);
    expect(countText("🚀 go").chars).toBe(4);
  });

  test("empty text counts nothing", () => {
    expect(countText("")).toEqual({ words: 0, chars: 0 });
  });

  test("code inside a fence still counts as text", () => {
    expect(countText("```js\nlet x = 1\n```").words).toBe(4); // js let x 1
  });
});

describe("countLabel", () => {
  test("words and chars, singular and plural", () => {
    expect(countLabel("hi")).toBe("1 word · 2 chars");
    expect(countLabel("two words")).toBe("2 words · 9 chars");
  });

  test("nothing to count reads as nothing at all", () => {
    expect(countLabel("")).toBe("");
    expect(countLabel("\n\n  \n")).toBe("");
  });

  test("a markers-only block still shows its characters", () => {
    expect(countLabel("---")).toBe("0 words · 3 chars");
  });
});

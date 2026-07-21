import { describe, expect, test } from "bun:test";
import {
  contentHash,
  extractLinks,
  normalizePath,
  normalizeTasks,
  resolveLink,
  taskLinesIn,
  taskState,
  todayName,
  toggleTaskAtLine,
} from "./links";

describe("extractLinks", () => {
  test("finds simple wiki links", () => {
    expect(extractLinks("see [carnet] and [tax-2025]")).toEqual(["carnet", "tax-2025"]);
  });

  test("supports names with spaces and paths", () => {
    expect(extractLinks("[my note] and [projects/carnet]")).toEqual(["my note", "projects/carnet"]);
  });

  test("ignores standard markdown links, images and references", () => {
    const src = [
      "[text](https://example.com)",
      "![alt](img.png)",
      "[ref link][ref]",
      "[ref]: https://example.com",
    ].join("\n");
    expect(extractLinks(src)).toEqual([]);
  });

  test("ignores task checkboxes, footnotes and bare numbers", () => {
    const src = "- [ ] todo\n- [x] done\nsee note[^1] and [1] citation\n[^1]: foot";
    expect(extractLinks(src)).toEqual([]);
  });

  test("ignores links inside fenced code blocks and inline code", () => {
    const src = "```\n[not-a-link]\n```\nuse `[also-not]` but [yes-link]";
    expect(extractLinks(src)).toEqual(["yes-link"]);
  });

  test("dedupes repeated links", () => {
    expect(extractLinks("[a] then [a] again")).toEqual(["a"]);
  });

  test("treats [[obsidian-style]] as a link too", () => {
    expect(extractLinks("[[foo]]")).toEqual(["foo"]);
  });

  test("counts a link right after an exclamation mark, like the renderer does", () => {
    expect(extractLinks("Wow![Note] here")).toEqual(["Note"]);
  });

  test("skips names that have a reference-link definition", () => {
    expect(extractLinks("see [docs] and [real-note]\n\n[docs]: https://example.com")).toEqual(["real-note"]);
  });
});

describe("resolveLink", () => {
  const paths = [
    "2026-07-20.md",
    "carnet.md",
    "projects/carnet/carnet.md",
    "projects/carnet/carnet-tasks.md",
    "projects/other/notes.md",
  ];

  test("matches by basename anywhere in the vault", () => {
    expect(resolveLink("carnet-tasks", "2026-07-20.md", paths)).toBe("projects/carnet/carnet-tasks.md");
  });

  test("prefers the linking note's own folder", () => {
    expect(resolveLink("carnet", "projects/carnet/carnet-tasks.md", paths)).toBe("projects/carnet/carnet.md");
  });

  test("prefers the shallowest match otherwise", () => {
    expect(resolveLink("carnet", "2026-07-20.md", paths)).toBe("carnet.md");
  });

  test("is case-insensitive", () => {
    expect(resolveLink("Carnet-Tasks", "2026-07-20.md", paths)).toBe("projects/carnet/carnet-tasks.md");
  });

  test("resolves path-style links from the root", () => {
    expect(resolveLink("projects/other/notes", "2026-07-20.md", paths)).toBe("projects/other/notes.md");
  });

  test("returns null for unknown names", () => {
    expect(resolveLink("nope", "2026-07-20.md", paths)).toBeNull();
  });
});

describe("task line detection", () => {
  const src = "# Day\n- [ ] first\ntext\n- [x] second\n1. [ ] third";

  test("finds bullet and ordered task lines, skipping prose", () => {
    expect(taskLinesIn(src, 0, 4)).toEqual([1, 3, 4]);
  });

  test("checks and unchecks via the line address", () => {
    expect(toggleTaskAtLine(src, 1)).toContain("- [x] first");
    expect(toggleTaskAtLine(src, 3)).toContain("- [ ] second");
    expect(toggleTaskAtLine(src, 4)).toContain("1. [x] third");
  });

  test("skips fake tasks inside code fences", () => {
    const fenced = "```\n- [ ] not real\n```\n- [ ] real";
    expect(taskLinesIn(fenced, 0, 3)).toEqual([3]);
    expect(toggleTaskAtLine(fenced, 1)).toBeNull();
  });

  test("skips empty tasks ('- [ ] ' with no text) exactly like marked does", () => {
    expect(taskLinesIn("- [ ] \n- [ ] real", 0, 1)).toEqual([1]);
  });

  test("skips fake tasks inside blockquoted code fences", () => {
    const s = "> ```\n> - [ ] in code\n> ```\n\n- [ ] real";
    expect(taskLinesIn(s, 0, 4)).toEqual([4]);
  });

  test("a quoted fence ends with its blockquote, like marked closes it", () => {
    expect(taskLinesIn("> ```\n\n- [ ] a\n- [ ] b", 0, 3)).toEqual([2, 3]);
  });

  test("4-space-indented backticks are indented code, not a fence", () => {
    expect(taskLinesIn("    ```\n- [ ] real", 0, 1)).toEqual([1]);
  });

  test("marked parity: tab after bracket counts, huge markers and wide gaps don't", () => {
    expect(taskLinesIn("- [x]\tdone", 0, 0)).toEqual([0]);
    expect(taskLinesIn("1234567890. [ ] ten-digit marker", 0, 0)).toEqual([]);
    expect(taskLinesIn("-     [ ] five-space gap", 0, 0)).toEqual([]);
  });
});

describe("taskState", () => {
  test("reports checked, unchecked, and non-task lines", () => {
    expect(taskState("- [x] done")).toBe(true);
    expect(taskState("- [ ] open")).toBe(false);
    expect(taskState("- [] shorthand")).toBe(false);
    expect(taskState("plain text")).toBeNull();
  });
});

describe("contentHash", () => {
  test("is stable and content-sensitive", () => {
    expect(contentHash("")).toBe("00001505");
    expect(contentHash("hello")).toBe(contentHash("hello"));
    expect(contentHash("hello")).not.toBe(contentHash("hello!"));
    expect(contentHash("æøå")).toHaveLength(8);
  });
});

describe("line-addressed tasks", () => {
  const src = "# Day\n- [ ] first\n- [x] second\ntext\n- [] third";

  test("taskLinesIn finds task lines in a range", () => {
    expect(taskLinesIn(src, 0, 4)).toEqual([1, 2, 4]);
    expect(taskLinesIn(src, 2, 4)).toEqual([2, 4]);
  });

  test("toggleTaskAtLine flips exactly that line", () => {
    expect(toggleTaskAtLine(src, 1)).toContain("- [x] first");
    expect(toggleTaskAtLine(src, 2)).toContain("- [ ] second");
    expect(toggleTaskAtLine(src, 4)).toContain("- [x] third");
  });

  test("toggleTaskAtLine refuses non-task lines", () => {
    expect(toggleTaskAtLine(src, 3)).toBeNull();
    expect(toggleTaskAtLine(src, 99)).toBeNull();
  });
});

describe("shorthand [] tasks", () => {
  test("normalizeTasks turns - [] into - [ ] for rendering", () => {
    expect(normalizeTasks("- [] Hvad med edtte?\n- [x] done")).toBe("- [ ] Hvad med edtte?\n- [x] done");
  });

  test("normalizeTasks leaves code fences and prose brackets alone", () => {
    const src = "```\n- [] nope\n```\ntext [] here\n- [] yes";
    expect(normalizeTasks(src)).toBe("```\n- [] nope\n```\ntext [] here\n- [ ] yes");
  });

  test("toggleTaskAtLine checks a shorthand [] box", () => {
    expect(toggleTaskAtLine("- [] foo", 0)).toBe("- [x] foo");
  });

  test("shorthand and spec boxes are all detected together", () => {
    const src = "- [] a\n- [ ] b\n- [x] c";
    expect(taskLinesIn(src, 0, 2)).toEqual([0, 1, 2]);
    expect(toggleTaskAtLine(src, 1)).toBe("- [] a\n- [x] b\n- [x] c");
    expect(toggleTaskAtLine(src, 2)).toBe("- [] a\n- [ ] b\n- [ ] c");
  });
});

describe("misc", () => {
  test("todayName formats as yyyy-MM-dd.md", () => {
    expect(todayName(new Date(2026, 6, 21))).toBe("2026-07-21.md");
  });

  test("normalizePath collapses .. safely", () => {
    expect(normalizePath("a/b/../c.md")).toBe("a/c.md");
    expect(normalizePath("../../etc/passwd")).toBe("etc/passwd");
  });
});

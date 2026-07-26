// Differential tests: the fast paths checked against independent, obviously
// correct reference implementations over generated input.
//
// Three of the performance fixes replaced something simple with something
// clever, and a silent disagreement in any of them is a data problem rather
// than a speed one:
//   - buildLinkIndex replaced a per-link scan of the whole vault. If it
//     resolves a link differently, links point at the wrong note.
//   - VaultIndex is edited in place instead of rebuilt. If an edit leaves it
//     out of step, backlinks and the graph are wrong.
//   - contentHash went 64-bit using two 32-bit halves. If the arithmetic is
//     off, it disagrees with the Rust side and every save looks like a
//     conflict.
import { describe, expect, test } from "bun:test";
import { basename, buildLinkIndex, contentHash, dirOf, normalizePath } from "./links";
import { buildGraph, type NoteDoc } from "./graph-data";
import { VaultIndex } from "./vault-index";

/** Deterministic PRNG so a failure is reproducible. */
function rng(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

/**
 * resolveLink exactly as it was written before the index existed, transcribed
 * from git history. resolveLink() itself now delegates to the index, so it
 * cannot disagree — this is the real independent reference.
 */
function referenceResolve(name: string, fromPath: string, allPaths: string[]): string | null {
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

describe("buildLinkIndex vs the original per-link scan", () => {
  test("agrees on generated vaults where basenames collide constantly", () => {
    // Few distinct names over many folders of differing depth, so almost every
    // lookup has several candidates and the tie-breaking actually matters.
    const names = ["note", "index", "plan", "Plan", "a", "readme"];
    const folders = ["", "p/", "p/q/", "p/q/r/", "other/", "Other/", "p/other/"];
    let checked = 0;

    for (let seed = 1; seed <= 40; seed++) {
      const rand = rng(seed);
      const paths: string[] = [];
      for (const f of folders) {
        for (const n of names) {
          if (rand() < 0.55) paths.push(`${f}${n}.md`);
        }
      }
      if (paths.length === 0) continue;
      // deliberately NOT sorted: the original preferred array order on ties
      const index = buildLinkIndex(paths);

      const queries = [...names, ...names.map((n) => n.toUpperCase())];
      for (const f of folders) for (const n of names) queries.push(`${f}${n}`);
      queries.push("missing", "p/missing", "note.md", "p/note.md");

      for (const from of paths) {
        for (const q of queries) {
          checked++;
          expect(index.resolve(q, from)).toBe(referenceResolve(q, from, paths));
        }
      }
    }
    expect(checked).toBeGreaterThan(50_000);
  });

  test("agrees on the awkward shapes", () => {
    const vaults = [
      [],
      ["a.md"],
      ["a.md", "A.md"], // case-only difference
      ["a.md", "b/a.md", "c/a.md", "b/c/a.md"],
      ["x/y.md", "y.md"],
      ["deep/deep/deep/deep/n.md", "n.md"],
      ["with space.md", "dir with space/n.md"],
      ["ünïcode.md", "dir/ünïcode.md"],
      ["a.MD", "a.md"], // extension case
    ];
    for (const paths of vaults) {
      const index = buildLinkIndex(paths);
      const names = ["a", "A", "n", "y", "with space", "ünïcode", "x/y", "dir/n", "nope"];
      for (const from of [...paths, "elsewhere.md"]) {
        for (const n of names) {
          expect(index.resolve(n, from)).toBe(referenceResolve(n, from, paths));
        }
      }
    }
  });
});

describe("VaultIndex incremental edits vs a full rebuild", () => {
  /** Order-insensitive comparison of two graphs. */
  const shape = (g: ReturnType<VaultIndex["graph"]>) => ({
    nodes: g.nodes.map((n) => `${n.id}${n.missing ? "!" : ""}`).sort(),
    edges: g.edges.map((e) => `${e.source}>${e.target}`).sort(),
  });

  test("random edit sequences never drift from a rebuild", () => {
    const targets = ["alpha", "beta", "gamma", "ghost", "phantom", "self"];
    for (let seed = 1; seed <= 60; seed++) {
      const rand = rng(seed);
      const notes: NoteDoc[] = [
        { path: "alpha.md", content: "" },
        { path: "beta.md", content: "" },
        { path: "gamma.md", content: "" },
        { path: "dir/alpha.md", content: "" },
        { path: "self.md", content: "" },
      ];
      const body = (): string => {
        const n = Math.floor(rand() * 4);
        const out: string[] = [];
        for (let i = 0; i < n; i++) out.push(`[${targets[Math.floor(rand() * targets.length)]}]`);
        // sometimes repeat a link, sometimes add a fenced block that must be ignored
        if (rand() < 0.3 && out.length > 0) out.push(out[0]);
        if (rand() < 0.2) out.push("```", "[ignored]", "```");
        return out.join("\n");
      };
      for (const note of notes) note.content = body();

      const index = new VaultIndex(notes);
      for (let step = 0; step < 25; step++) {
        const victim = notes[Math.floor(rand() * notes.length)];
        victim.content = body();
        index.setContent(victim.path, victim.content);
        expect(shape(index.graph())).toEqual(shape(new VaultIndex(notes).graph()));
      }
      // and backlinks agree with the edges buildGraph derives independently
      const reference = buildGraph(notes);
      for (const note of notes) {
        const expected = [
          ...new Set(reference.edges.filter((e) => e.target === note.path).map((e) => e.source)),
        ].sort();
        expect(index.backlinks(note.path)).toEqual(expected);
      }
    }
  });
});

describe("contentHash 64-bit arithmetic", () => {
  /** The same djb2-xor, with BigInt doing the width for us. */
  function reference(s: string): string {
    let h = 5381n;
    const mask = (1n << 64n) - 1n;
    for (const b of new TextEncoder().encode(s)) {
      h = ((h * 33n) & mask) ^ BigInt(b);
    }
    return h.toString(16).padStart(16, "0");
  }

  test("matches a BigInt reference on inputs that stress the carry", () => {
    const cases = [
      "",
      "a",
      "\0",
      "\0\0\0\0\0\0\0\0",
      "\u{10FFFF}",
      "Grüße 👋",
      "ü".repeat(300),
      "# Note\r\n\r\nbody\r\n",
      "��",
      String.fromCharCode(...Array.from({ length: 256 }, (_, i) => i)),
    ];
    for (const s of cases) expect(contentHash(s)).toBe(reference(s));
  });

  test("matches on generated text, including a megabyte", () => {
    const rand = rng(7);
    for (let i = 0; i < 400; i++) {
      const len = Math.floor(rand() * 200);
      let s = "";
      for (let j = 0; j < len; j++) s += String.fromCharCode(Math.floor(rand() * 0x2000));
      expect(contentHash(s)).toBe(reference(s));
    }
    const big = "lorem ipsum dolor sit amet ".repeat(40_000); // ~1 MB
    expect(contentHash(big)).toBe(reference(big));
  });

  test("is always 16 hex digits, whatever the input", () => {
    const rand = rng(11);
    for (let i = 0; i < 500; i++) {
      let s = "";
      for (let j = 0; j < Math.floor(rand() * 40); j++) s += String.fromCharCode(Math.floor(rand() * 0x110000 - 1) + 1);
      expect(contentHash(s)).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

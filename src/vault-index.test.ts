import { describe, expect, test } from "bun:test";
import { buildGraph, type NoteDoc } from "./graph-data";
import { VaultIndex } from "./vault-index";

/** Compare graphs ignoring the order nodes and edges happen to come out in. */
function shape(g: { nodes: { id: string; missing?: boolean }[]; edges: { source: string; target: string }[] }) {
  return {
    nodes: g.nodes.map((n) => `${n.id}${n.missing ? " (missing)" : ""}`).sort(),
    edges: g.edges.map((e) => `${e.source} -> ${e.target}`).sort(),
  };
}

const vault: NoteDoc[] = [
  { path: "index.md", content: "# Index\n[carnet] and [projects/atlas/plan] and [nothing-here]" },
  { path: "carnet.md", content: "# Carnet\nlinks to [index] and [index] again and to [itself-missing]" },
  { path: "projects/atlas/plan.md", content: "# Plan\n[carnet]\n[plan]" },
  { path: "orphan.md", content: "no links at all" },
];

describe("VaultIndex", () => {
  test("produces the same graph as buildGraph", () => {
    expect(shape(new VaultIndex(vault).graph())).toEqual(shape(buildGraph(vault)));
  });

  test("backlinks match the edges buildGraph produces", () => {
    const index = new VaultIndex(vault);
    const reference = buildGraph(vault);
    for (const note of vault) {
      const expected = [
        ...new Set(reference.edges.filter((e) => e.target === note.path).map((e) => e.source)),
      ].sort();
      expect(index.backlinks(note.path)).toEqual(expected);
    }
  });

  test("editing a note updates backlinks without a rebuild", () => {
    const index = new VaultIndex(vault);
    expect(index.backlinks("carnet.md")).toEqual(["index.md", "projects/atlas/plan.md"]);

    // orphan.md starts linking to carnet
    index.setContent("orphan.md", "now I link to [carnet]");
    expect(index.backlinks("carnet.md")).toEqual(["index.md", "orphan.md", "projects/atlas/plan.md"]);

    // ...and stops again
    index.setContent("orphan.md", "never mind");
    expect(index.backlinks("carnet.md")).toEqual(["index.md", "projects/atlas/plan.md"]);
  });

  test("incremental edits land in the same state as a full rebuild", () => {
    const index = new VaultIndex(vault);
    const edited = vault.map((n) =>
      n.path === "index.md" ? { ...n, content: "# Index\nonly [orphan] now, plus [brand-new]" } : n,
    );
    index.setContent("index.md", edited[0].content);
    expect(shape(index.graph())).toEqual(shape(buildGraph(edited)));
  });

  test("a missing node disappears when the last link to it goes", () => {
    const index = new VaultIndex(vault);
    expect(index.graph().nodes.some((n) => n.id === "missing:nothing-here")).toBe(true);
    index.setContent("index.md", "# Index\nnothing linked");
    expect(index.graph().nodes.some((n) => n.id === "missing:nothing-here")).toBe(false);
  });

  test("a missing node survives while another note still links to it", () => {
    const notes: NoteDoc[] = [
      { path: "a.md", content: "[ghost]" },
      { path: "b.md", content: "[ghost]" },
    ];
    const index = new VaultIndex(notes);
    index.setContent("a.md", "no link");
    expect(index.backlinks("missing:ghost")).toEqual(["b.md"]);
    expect(index.graph().nodes.some((n) => n.id === "missing:ghost")).toBe(true);
  });

  test("self-links and duplicate links are not edges", () => {
    const notes: NoteDoc[] = [{ path: "solo.md", content: "[solo] [solo] and [solo]" }];
    expect(new VaultIndex(notes).graph().edges).toEqual([]);
  });

  test("an empty vault is harmless", () => {
    const index = new VaultIndex([]);
    expect(index.graph()).toEqual({ nodes: [], edges: [] });
    expect(index.backlinks("anything.md")).toEqual([]);
    expect(index.resolve("x", "y.md")).toBeNull();
  });

  test("repeated edits do not leak stale sources", () => {
    const index = new VaultIndex(vault);
    for (let i = 0; i < 50; i++) {
      index.setContent("orphan.md", i % 2 === 0 ? "[carnet]" : "[index]");
    }
    index.setContent("orphan.md", "[carnet]");
    expect(index.backlinks("carnet.md")).toEqual(["index.md", "orphan.md", "projects/atlas/plan.md"]);
    expect(index.backlinks("index.md")).toEqual(["carnet.md"]);
  });
});

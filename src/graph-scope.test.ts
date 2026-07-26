import { describe, expect, test } from "bun:test";
import type { GraphData } from "./graph-data";
import { scopeAround } from "./client/graph";

/** A chain a—b—c—…: distance from the head is the index. */
function chain(n: number): GraphData {
  const nodes = Array.from({ length: n }, (_, i) => ({ id: `n${i}`, title: `n${i}`, group: "" }));
  const edges = Array.from({ length: n - 1 }, (_, i) => ({ source: `n${i}`, target: `n${i + 1}` }));
  return { nodes, edges };
}

/** One hub linked to `n` leaves. */
function star(n: number): GraphData {
  const nodes = [{ id: "hub", title: "hub", group: "" }];
  const edges: GraphData["edges"] = [];
  for (let i = 0; i < n; i++) {
    nodes.push({ id: `leaf${i}`, title: `leaf${i}`, group: "" });
    edges.push({ source: "hub", target: `leaf${i}` });
  }
  return { nodes, edges };
}

describe("scopeAround", () => {
  test("a vault small enough to show whole is untouched", () => {
    const g = chain(50);
    const { data, reachedAll } = scopeAround(g, "n0", 2);
    expect(data).toBe(g); // same object: no filtering at all
    expect(reachedAll).toBe(true);
  });

  test("a large vault opens on the note you're in, not everything", () => {
    const g = chain(2000);
    const { data } = scopeAround(g, "n500", 2);
    const ids = data.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["n498", "n499", "n500", "n501", "n502"].sort());
  });

  test("depth walks one more link out each step", () => {
    const g = chain(2000);
    expect(scopeAround(g, "n500", 1).data.nodes).toHaveLength(3);
    expect(scopeAround(g, "n500", 2).data.nodes).toHaveLength(5);
    expect(scopeAround(g, "n500", 3).data.nodes).toHaveLength(7);
  });

  test("only edges between kept nodes come along", () => {
    const g = chain(2000);
    const { data } = scopeAround(g, "n500", 1);
    const kept = new Set(data.nodes.map((n) => n.id));
    for (const e of data.edges) {
      expect(kept.has(e.source)).toBe(true);
      expect(kept.has(e.target)).toBe(true);
    }
    expect(data.edges).toHaveLength(2); // n499—n500 and n500—n501
  });

  test("the node cap holds however wide you go", () => {
    const g = star(5000);
    for (const depth of [1, 2, 3, 10]) {
      const { data, truncated } = scopeAround(g, "hub", depth);
      expect(data.nodes.length).toBeLessThanOrEqual(400);
      expect(truncated).toBe(true);
    }
  });

  test("with no note open it starts from the best-connected note", () => {
    const g = star(5000);
    const { data } = scopeAround(g, null, 1);
    expect(data.nodes.some((n) => n.id === "hub")).toBe(true);
  });

  test("an origin that isn't in the graph falls back rather than showing nothing", () => {
    const g = star(5000);
    const { data } = scopeAround(g, "not-a-note.md", 1);
    expect(data.nodes.length).toBeGreaterThan(1);
    expect(data.nodes.some((n) => n.id === "hub")).toBe(true);
  });

  test("reachedAll is set once there is nothing further out", () => {
    // a big vault whose components are small: walking out runs dry quickly
    const nodes = Array.from({ length: 1000 }, (_, i) => ({ id: `n${i}`, title: "", group: "" }));
    const edges = [{ source: "n0", target: "n1" }];
    const g: GraphData = { nodes, edges };
    const scoped = scopeAround(g, "n0", 5);
    expect(scoped.data.nodes.map((n) => n.id)).toEqual(["n0", "n1"]);
    expect(scoped.reachedAll).toBe(true);
    expect(scoped.truncated).toBe(false);
  });

  // Pressing `g` on a note with no links is the DEFAULT launch path: the app
  // opens today's daily note, and a fresh one has no links in it. Anchoring on
  // it showed a single dot with Wider greyed out and no way to see anything.
  test("a note with no links falls back to something worth looking at", () => {
    const g = star(5000);
    g.nodes.push({ id: "fresh-daily.md", title: "today", group: "" });
    const { data } = scopeAround(g, "fresh-daily.md", 2);
    expect(data.nodes.length).toBeGreaterThan(1);
    expect(data.nodes.some((n) => n.id === "hub")).toBe(true);
  });

  test("Wider is only offered when there is actually more to reach", () => {
    // a large vault whose reachable component is a short chain
    const nodes = Array.from({ length: 1000 }, (_, i) => ({ id: `n${i}`, title: "", group: "" }));
    const g: GraphData = {
      nodes,
      edges: [
        { source: "n0", target: "n1" },
        { source: "n1", target: "n2" },
      ],
    };
    // one step out still has n2 to find
    expect(scopeAround(g, "n0", 1).reachedAll).toBe(false);
    // two steps out has the whole component; going wider would add nothing, so
    // offering it just resets the user's pan and zoom for an identical graph
    expect(scopeAround(g, "n0", 2).reachedAll).toBe(true);
    expect(scopeAround(g, "n0", 5).reachedAll).toBe(true);
  });

  test("links are followed in both directions", () => {
    const g: GraphData = {
      nodes: Array.from({ length: 1000 }, (_, i) => ({ id: `n${i}`, title: "", group: "" })),
      edges: [{ source: "n1", target: "n0" }], // n0 is only ever a target
    };
    expect(scopeAround(g, "n0", 1).data.nodes.map((n) => n.id).sort()).toEqual(["n0", "n1"]);
  });
});

import { describe, expect, test } from "bun:test";
import { buildGraph, dailyPath, searchNotes } from "./graph-data";

const notes = [
  { path: "2026-07-20.md", content: "- [ ] pay [tax-2025]\nworking on [carnet]" },
  { path: "projects/carnet/carnet.md", content: "# Carnet\ntasks in [carnet-tasks]" },
  { path: "projects/carnet/carnet-tasks.md", content: "- [ ] graph view" },
];

describe("buildGraph", () => {
  const g = buildGraph(notes);

  test("has a node per note plus missing-link phantoms", () => {
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain("2026-07-20.md");
    expect(ids).toContain("projects/carnet/carnet.md");
    expect(ids).toContain("missing:tax-2025");
    expect(g.nodes.find((n) => n.id === "missing:tax-2025")?.missing).toBe(true);
  });

  test("resolves edges through subfolders", () => {
    expect(g.edges).toContainEqual({ source: "2026-07-20.md", target: "projects/carnet/carnet.md" });
    expect(g.edges).toContainEqual({
      source: "projects/carnet/carnet.md",
      target: "projects/carnet/carnet-tasks.md",
    });
  });

  test("groups nodes by top-level folder", () => {
    expect(g.nodes.find((n) => n.id === "projects/carnet/carnet.md")?.group).toBe("projects");
    expect(g.nodes.find((n) => n.id === "2026-07-20.md")?.group).toBe("");
  });
});

describe("searchNotes", () => {
  test("finds content matches with a snippet", () => {
    const hits = searchNotes(notes, "graph view");
    expect(hits).toEqual([{ path: "projects/carnet/carnet-tasks.md", snippet: "- [ ] graph view" }]);
  });

  test("finds filename matches without content hit", () => {
    const hits = searchNotes(notes, "carnet-tasks");
    expect(hits.map((h) => h.path)).toContain("projects/carnet/carnet-tasks.md");
  });
});

describe("dailyPath", () => {
  test("returns the existing daily note", () => {
    expect(dailyPath(notes.map((n) => n.path), "2026-07-20.md")).toEqual({
      path: "2026-07-20.md",
      exists: true,
    });
  });

  test("suggests today's note in the folder of the latest daily note", () => {
    const paths = ["daily/2026-07-19.md", "daily/2026-07-20.md", "other.md"];
    expect(dailyPath(paths, "2026-07-21.md")).toEqual({ path: "daily/2026-07-21.md", exists: false });
  });

  test("defaults to the vault root when no daily notes exist", () => {
    expect(dailyPath(["other.md"], "2026-07-21.md")).toEqual({ path: "2026-07-21.md", exists: false });
  });
});

// The cache's job is to stay TRUE, not just fast. A bug here shows up as wrong
// backlinks or a wiki link drawn the wrong colour, never as a crash, so the
// sequences are driven directly.
import { describe, expect, test } from "bun:test";
import { VaultCache, type CachedNote, type NoteMeta, type VaultSource } from "./vault-cache";

class FakeVault implements VaultSource {
  files = new Map<string, { content: string; mtime: number }>();
  metaCalls = 0;
  readAllCalls = 0;
  failNextReadAll = false;
  /** Resolves the pending readAll manually, to test in-flight races. */
  gate: (() => void) | null = null;

  constructor(seed: Record<string, string> = {}) {
    let t = 1000;
    for (const [path, content] of Object.entries(seed)) {
      this.files.set(path, { content, mtime: t++ });
    }
  }

  put(path: string, content: string, mtime?: number): void {
    const prev = this.files.get(path);
    this.files.set(path, { content, mtime: mtime ?? (prev ? prev.mtime + 1 : 9000) });
  }

  remove(path: string): void {
    this.files.delete(path);
  }

  async listMeta(): Promise<NoteMeta[]> {
    this.metaCalls++;
    return [...this.files.entries()]
      .map(([path, f]) => ({ path, mtime: f.mtime }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async readAll(): Promise<CachedNote[]> {
    this.readAllCalls++;
    if (this.failNextReadAll) {
      this.failNextReadAll = false;
      throw new Error("vault unreadable");
    }
    if (this.gate) {
      await new Promise<void>((resolve) => (this.gate = resolve));
    }
    return [...this.files.entries()]
      .map(([path, f]) => ({ path, content: f.content, mtime: f.mtime }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
}

/** A cache already pointed at the fake's current contents. */
async function ready(
  source: FakeVault,
  pause?: () => Promise<void>,
  sliceMs?: number,
): Promise<VaultCache> {
  const cache = new VaultCache(source, pause, sliceMs);
  cache.adopt(await source.listMeta());
  return cache;
}

const SEED = {
  "index.md": "# Index\n[alpha] and [beta] and [nowhere]",
  "alpha.md": "# Alpha\nlinks to [beta]",
  "beta.md": "# Beta\nno links",
};

describe("VaultCache", () => {
  test("paths and link resolution are available without reading any bodies", async () => {
    const src = new FakeVault(SEED);
    const cache = await ready(src);
    expect(cache.paths()).toEqual(["alpha.md", "beta.md", "index.md"]);
    expect(cache.links().resolve("alpha", "index.md")).toBe("alpha.md");
    expect(cache.links().has("nowhere", "index.md")).toBe(false);
    expect(src.readAllCalls).toBe(0); // the renderer never waits on bodies
  });

  test("concurrent callers share one whole-vault read", async () => {
    const src = new FakeVault(SEED);
    const cache = await ready(src);
    await Promise.all([cache.allNotes(), cache.allNotes(), cache.vaultIndex(), cache.backlinks("beta.md")]);
    expect(src.readAllCalls).toBe(1);
  });

  test("the index is built once and reused", async () => {
    const src = new FakeVault(SEED);
    const cache = await ready(src);
    const a = await cache.vaultIndex();
    const b = await cache.vaultIndex();
    expect(a).toBe(b);
    expect(src.readAllCalls).toBe(1);
  });

  test("a failed read does not poison the cache", async () => {
    const src = new FakeVault(SEED);
    const cache = await ready(src);
    src.failNextReadAll = true;
    await expect(cache.allNotes()).rejects.toThrow("vault unreadable");
    // the retry must actually retry
    const notes = await cache.allNotes();
    expect(notes).toHaveLength(3);
    expect(src.readAllCalls).toBe(2);
  });

  test("saving a note updates backlinks without re-reading the vault", async () => {
    const src = new FakeVault(SEED);
    const cache = await ready(src);
    expect(await cache.backlinks("beta.md")).toEqual(["alpha.md", "index.md"]);

    cache.noteSaved("alpha.md", "# Alpha\nnothing now", 1234);
    expect(await cache.backlinks("beta.md")).toEqual(["index.md"]);

    cache.noteSaved("beta.md", "# Beta\nnow links to [alpha]", 1235);
    expect(await cache.backlinks("alpha.md")).toEqual(["beta.md", "index.md"]);

    expect(src.readAllCalls).toBe(1); // one read for the whole sequence
  });

  test("saving keeps the body cache in step, so search sees the new text", async () => {
    const src = new FakeVault(SEED);
    const cache = await ready(src);
    await cache.allNotes();
    cache.noteSaved("beta.md", "# Beta\nfindable phrase", 1234);
    const notes = await cache.allNotes();
    expect(notes.find((n) => n.path === "beta.md")!.content).toContain("findable phrase");
    expect(notes.find((n) => n.path === "beta.md")!.mtime).toBe(1234);
  });

  // The property that makes focus cheap: our own save must not read as an
  // outside change, or every save would cost a whole-vault re-read on focus.
  test("our own save does not look like an outside change", async () => {
    const src = new FakeVault(SEED);
    const cache = await ready(src);
    await cache.vaultIndex();

    src.put("beta.md", "# Beta\nedited", 5555); // the write really happened
    cache.noteSaved("beta.md", "# Beta\nedited", 5555); // and we know about it

    expect(await cache.refresh()).toEqual({ changed: false, pathsMoved: false });
    expect(src.readAllCalls).toBe(1);
  });

  test("an outside edit is noticed and drops what was derived from bodies", async () => {
    const src = new FakeVault(SEED);
    const cache = await ready(src);
    await cache.vaultIndex();

    src.put("beta.md", "# Beta\nnow links to [alpha]", 7777); // another device
    expect(await cache.refresh()).toEqual({ changed: true, pathsMoved: false });
    expect(await cache.backlinks("alpha.md")).toEqual(["beta.md", "index.md"]);
    expect(src.readAllCalls).toBe(2);
  });

  test("a new file appearing outside the app moves the paths", async () => {
    const src = new FakeVault(SEED);
    const cache = await ready(src);
    src.put("gamma.md", "# Gamma\n[alpha]");
    expect(await cache.refresh()).toEqual({ changed: true, pathsMoved: true });
    expect(cache.paths()).toContain("gamma.md");
    expect(cache.links().resolve("gamma", "index.md")).toBe("gamma.md");
    expect(await cache.backlinks("alpha.md")).toEqual(["gamma.md", "index.md"]);
  });

  test("a deleted file disappears from the paths and the graph", async () => {
    const src = new FakeVault(SEED);
    const cache = await ready(src);
    await cache.vaultIndex();
    src.remove("alpha.md");
    expect(await cache.refresh()).toEqual({ changed: true, pathsMoved: true });
    expect(cache.paths()).not.toContain("alpha.md");
    expect(cache.links().has("alpha", "index.md")).toBe(false);
    // index.md's link to it becomes a missing node rather than an edge
    expect((await cache.vaultIndex()).graph().nodes.some((n) => n.id === "missing:alpha")).toBe(true);
  });

  test("creating a note makes links to it resolve immediately", async () => {
    const src = new FakeVault(SEED);
    const cache = await ready(src);
    expect(cache.links().has("nowhere", "index.md")).toBe(false);
    src.put("nowhere.md", "", 4242);
    cache.addPath("nowhere.md", 4242);
    expect(cache.links().resolve("nowhere", "index.md")).toBe("nowhere.md");
    expect(await cache.backlinks("nowhere.md")).toEqual(["index.md"]);
    // and it doesn't then read as an outside change
    expect(await cache.refresh()).toEqual({ changed: false, pathsMoved: false });
  });

  test("adding a path twice is harmless", async () => {
    const src = new FakeVault(SEED);
    const cache = await ready(src);
    cache.addPath("alpha.md", 1);
    expect(cache.paths().filter((p) => p === "alpha.md")).toHaveLength(1);
  });

  // The race the extracted version exists to get right: a save landing while a
  // read or a build is in flight must not leave a half-patched structure.
  test("a save during an in-flight read drops the caches instead of half-patching", async () => {
    const src = new FakeVault(SEED);
    const cache = await ready(src);
    src.gate = () => {};

    const pending = cache.allNotes();
    cache.noteSaved("beta.md", "# Beta\nlinks to [alpha]", 999);
    src.put("beta.md", "# Beta\nlinks to [alpha]", 999);
    (src.gate as unknown as () => void)();
    src.gate = null;
    await pending;

    // whatever the read saw, the next look must reflect the save
    expect(await cache.backlinks("alpha.md")).toEqual(["beta.md", "index.md"]);
  });

  test("a save during an in-flight index build drops the caches", async () => {
    const src = new FakeVault(SEED);
    let paused = 0;
    // sliceMs 0 makes it yield after every note, so the save lands mid-build
    const cache: VaultCache = await ready(
      src,
      async () => {
        paused++;
        if (paused === 1) {
          // slip a save in exactly where it would really happen
          cache.noteSaved("beta.md", "# Beta\nlinks to [alpha]", 888);
          src.put("beta.md", "# Beta\nlinks to [alpha]", 888);
        }
      },
      0,
    );
    await cache.vaultIndex();
    expect(paused).toBeGreaterThan(0); // the build really did slice
    expect(await cache.backlinks("alpha.md")).toEqual(["beta.md", "index.md"]);
  });

  test("changing vault empties everything", async () => {
    const src = new FakeVault(SEED);
    const cache = await ready(src);
    await cache.vaultIndex();
    cache.adopt([]);
    expect(cache.paths()).toEqual([]);
    expect(cache.links().has("alpha", "index.md")).toBe(false);
    expect(cache.knownMtime("alpha.md")).toBeUndefined();
  });

  test("knownMtime tracks what was last seen", async () => {
    const src = new FakeVault(SEED);
    const cache = await ready(src);
    const before = cache.knownMtime("beta.md");
    expect(before).toBeDefined();
    cache.noteSaved("beta.md", "x", 31337);
    expect(cache.knownMtime("beta.md")).toBe(31337);
    expect(cache.knownMtime("not-a-note.md")).toBeUndefined();
  });

  test("refresh is a no-op on an unchanged vault, however often it runs", async () => {
    const src = new FakeVault(SEED);
    const cache = await ready(src);
    await cache.vaultIndex();
    for (let i = 0; i < 5; i++) {
      expect((await cache.refresh()).changed).toBe(false);
    }
    expect(src.readAllCalls).toBe(1); // never re-read
    expect(src.metaCalls).toBe(6); // one listing per refresh, plus the adopt
  });
});

describe("VaultIndex.build slicing", () => {
  test("yields while building and gives the same answer as building in one go", async () => {
    const src = new FakeVault(SEED);
    let yields = 0;
    const sliced = await ready(src, async () => {
      yields++;
    }, 0);
    const a = await sliced.vaultIndex();

    // the same vault built without ever yielding
    const oneGo = await ready(src, async () => {}, 1_000_000);
    const b = await oneGo.vaultIndex();

    const shape = (g: ReturnType<typeof a.graph>) => ({
      nodes: g.nodes.map((n) => n.id).sort(),
      edges: g.edges.map((e) => `${e.source}>${e.target}`).sort(),
    });
    expect(shape(a.graph())).toEqual(shape(b.graph()));
    expect(yields).toBe(3); // one per note, at sliceMs 0
  });

  test("a big vault yields many times rather than blocking once", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 4000; i++) {
      files[`n${i}.md`] = `# n${i}\n[n${(i * 7) % 4000}] and [n${(i * 13) % 4000}]`;
    }
    const src = new FakeVault(files);
    let yields = 0;
    const cache = await ready(src, async () => {
      yields++;
    }, 0);
    const index = await cache.vaultIndex();
    expect(index.graph().nodes).toHaveLength(4000);
    expect(yields).toBe(4000);
  });
});

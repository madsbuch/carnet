import { expect, test, describe } from "bun:test";
import {
  CursorReset,
  DropboxAuthError,
  DropboxClient,
  DropboxError,
  WriteConflict,
  authorizeUrl,
  challengeFor,
  exchangeCode,
  isMarkdown,
  normalizeFolder,
  randomVerifier,
  toDropbox,
  toRel,
  type FetchLike,
  type Tokens,
} from "./client/dropbox";
import {
  CachedStore,
  DropboxSync,
  backoffMs,
  type Mirror,
  type Store,
} from "./client/dropboxsync";

/* ---------------- test doubles ---------------- */

/** A canned-response fetch that records the requests it received. */
function fakeFetch(handler: (url: string, init?: RequestInit) => Response): {
  fetch: FetchLike;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch: FetchLike = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  }) as FetchLike;
  return { fetch, calls };
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

class MemStore implements Store {
  map = new Map<string, string>();
  get(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  set(k: string, v: string): void {
    this.map.set(k, v);
  }
  remove(k: string): void {
    this.map.delete(k);
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
}

class MemMirror implements Mirror {
  files = new Map<string, string>();
  writes = 0;
  async write(rel: string, content: string): Promise<void> {
    this.writes++;
    this.files.set(rel, content);
  }
  async remove(rel: string): Promise<void> {
    this.files.delete(rel);
  }
  async read(rel: string): Promise<string | null> {
    return this.files.get(rel) ?? null;
  }
}

const tokens = (): Tokens => ({ accessToken: "at", refreshToken: "rt", expiresAt: 1e15 });
const noSleep = () => Promise.resolve();

/* ---------------- PKCE / auth ---------------- */

describe("PKCE", () => {
  test("verifier is base64url and long enough", () => {
    const v = randomVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(v.length).toBeGreaterThanOrEqual(43);
  });

  test("challenge is the base64url SHA-256 of the verifier (RFC 7636 vector)", async () => {
    // The canonical example from RFC 7636 Appendix B.
    const challenge = await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("authorize url carries offline access + S256", () => {
    const url = new URL(authorizeUrl("APPKEY", "CHAL"));
    expect(url.searchParams.get("client_id")).toBe("APPKEY");
    expect(url.searchParams.get("code_challenge")).toBe("CHAL");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("token_access_type")).toBe("offline");
    expect(url.searchParams.has("redirect_uri")).toBe(false); // copy-paste flow
  });

  test("exchangeCode posts the verifier and returns tokens with an absolute expiry", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({ access_token: "AT", refresh_token: "RT", expires_in: 14400 }),
    );
    const t = await exchangeCode("APPKEY", "CODE", "VERIFIER", fetch, () => 1000);
    expect(t).toEqual({ accessToken: "AT", refreshToken: "RT", expiresAt: 1000 + 14400 * 1000 });
    const body = (calls[0]!.init!.body as URLSearchParams).toString();
    expect(body).toContain("code_verifier=VERIFIER");
    expect(body).toContain("grant_type=authorization_code");
  });
});

/* ---------------- path mapping ---------------- */

describe("path mapping", () => {
  test("dropbox <-> vault-relative round trip", () => {
    expect(toRel("/projects/carnet.md")).toBe("projects/carnet.md");
    expect(toDropbox("projects/carnet.md")).toBe("/projects/carnet.md");
    expect(toRel(toDropbox("a/b.md"))).toBe("a/b.md");
  });
  test("markdown detection is case-insensitive", () => {
    expect(isMarkdown("a.MD")).toBe(true);
    expect(isMarkdown("a.md")).toBe(true);
    expect(isMarkdown("a.txt")).toBe(false);
  });
  test("a base folder is stripped and re-applied, case-insensitively", () => {
    expect(toRel("/notes/a/b.md", "/notes")).toBe("a/b.md");
    expect(toDropbox("a/b.md", "/notes")).toBe("/notes/a/b.md");
    expect(toRel("/Notes/a.md", "/notes")).toBe("a.md"); // display case may differ
    expect(toRel(toDropbox("x.md", "/notes"), "/notes")).toBe("x.md");
  });
  test("normalizeFolder yields '' or a leading-slash, no-trailing-slash path", () => {
    expect(normalizeFolder("")).toBe("");
    expect(normalizeFolder("/")).toBe("");
    expect(normalizeFolder("notes")).toBe("/notes");
    expect(normalizeFolder("/notes/")).toBe("/notes");
    expect(normalizeFolder("  /a/b/  ")).toBe("/a/b");
  });
});

/* ---------------- client behaviour ---------------- */

describe("DropboxClient", () => {
  test("refreshes the access token when it is expired, then calls the RPC", async () => {
    let clock = 100_000;
    const { fetch, calls } = fakeFetch((url) => {
      if (url.endsWith("/oauth2/token")) return json({ access_token: "NEW", expires_in: 3600 });
      return json({ entries: [], cursor: "cur", has_more: false });
    });
    const expired: Tokens = { accessToken: "old", refreshToken: "rt", expiresAt: 0 };
    const c = new DropboxClient(expired, "APPKEY", "", fetch, () => clock);
    await c.listFolder();
    expect(calls[0]!.url).toContain("/oauth2/token");
    // the RPC used the refreshed bearer token
    const auth = (calls[1]!.init!.headers as Record<string, string>).authorization;
    expect(auth).toBe("Bearer NEW");
    expect(c.currentTokens().accessToken).toBe("NEW");
  });

  test("the default fetch is called with the global as its receiver", async () => {
    // Browsers reject `fetch` invoked with anything but Window/WorkerGlobalScope
    // as the receiver ("Illegal invocation"), which is what happens if the
    // default is stored unbound on the instance and called as `this.fetch(...)`.
    // Bun's fetch does not enforce that, so stand in a receiver-checking one.
    const real = globalThis.fetch;
    globalThis.fetch = function (this: unknown) {
      if (this !== globalThis && this !== undefined) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      return Promise.resolve(json({ entries: [], cursor: "C", has_more: false }));
    } as unknown as typeof fetch;
    try {
      const c = new DropboxClient(tokens(), "APPKEY", "");
      expect(await c.listFolder()).toEqual({ deltas: [], cursor: "C", hasMore: false });
    } finally {
      globalThis.fetch = real;
    }
  });

  test("list_folder keeps only markdown files and deletions", async () => {
    const { fetch } = fakeFetch(() =>
      json({
        entries: [
          { ".tag": "file", path_display: "/a.md", rev: "r1" },
          { ".tag": "file", path_display: "/pic.png", rev: "r2" },
          { ".tag": "folder", path_display: "/sub" },
          { ".tag": "deleted", path_display: "/old.md" },
        ],
        cursor: "C",
        has_more: false,
      }),
    );
    const c = new DropboxClient(tokens(), "APPKEY", "", fetch);
    const page = await c.listFolder();
    expect(page.deltas).toEqual([
      { kind: "file", rel: "a.md", rev: "r1" },
      { kind: "deleted", rel: "old.md" },
    ]);
  });

  test("download returns content and rev from the API-Result header", async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response("hello", {
          status: 200,
          headers: { "Dropbox-API-Result": JSON.stringify({ rev: "r9" }) },
        }),
    );
    const c = new DropboxClient(tokens(), "APPKEY", "", fetch);
    expect(await c.download("a.md")).toEqual({ content: "hello", rev: "r9" });
  });

  test("conditional upload maps a 409 conflict to WriteConflict", async () => {
    const { fetch } = fakeFetch(
      () => new Response('{"error_summary":"path/conflict/..."}', { status: 409 }),
    );
    const c = new DropboxClient(tokens(), "APPKEY", "", fetch);
    await expect(c.upload("a.md", "x", "baseRev")).rejects.toBeInstanceOf(WriteConflict);
  });

  test("upload sends update mode with the base rev when given", async () => {
    const { fetch, calls } = fakeFetch(() => json({ rev: "r2" }));
    const c = new DropboxClient(tokens(), "APPKEY", "", fetch);
    const out = await c.upload("a.md", "x", "r1");
    expect(out).toEqual({ rev: "r2" });
    const arg = JSON.parse((calls[0]!.init!.headers as Record<string, string>)["Dropbox-API-Arg"]!);
    expect(arg.mode).toEqual({ ".tag": "update", update: "r1" });
  });

  test("upload with no base rev claims the file is new instead of overwriting", async () => {
    const { fetch, calls } = fakeFetch(() => json({ rev: "r2" }));
    const c = new DropboxClient(tokens(), "APPKEY", "", fetch);
    await c.upload("a.md", "x", undefined);
    const arg = JSON.parse((calls[0]!.init!.headers as Record<string, string>)["Dropbox-API-Arg"]!);
    // "overwrite" here silently destroyed the remote note whenever the local
    // rev had been lost (killed app, torn state blob, half-synced mirror).
    expect(arg.mode).toEqual({ ".tag": "add" });
    expect(arg.autorename).toBe(false);
  });

  test("an unconditional upload onto an existing file is a conflict, not a clobber", async () => {
    const { fetch } = fakeFetch(
      () => new Response('{"error_summary":"path/conflict/file/..."}', { status: 409 }),
    );
    const c = new DropboxClient(tokens(), "APPKEY", "", fetch);
    await expect(c.upload("a.md", "x", undefined)).rejects.toBeInstanceOf(WriteConflict);
  });

  test("longpoll uses the notify host with no auth header", async () => {
    const { fetch, calls } = fakeFetch(() => json({ changes: true }));
    const c = new DropboxClient(tokens(), "APPKEY", "", fetch);
    const r = await c.longpoll("cur");
    expect(r).toEqual({ changed: true, backoff: 0 });
    expect(calls[0]!.url).toContain("notify.dropboxapi.com");
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBeUndefined();
  });

  test("a client scoped to a folder lists and maps paths under it", async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.endsWith("/list_folder")) return json({ entries: [], cursor: "c", has_more: false });
      return json({ rev: "r" });
    });
    const c = new DropboxClient(tokens(), "APPKEY", "/notes", fetch);
    await c.listFolder();
    expect(JSON.parse(calls[0]!.init!.body as string).path).toBe("/notes");
    await c.upload("a.md", "x", undefined);
    const arg = JSON.parse((calls[1]!.init!.headers as Record<string, string>)["Dropbox-API-Arg"]!);
    expect(arg.path).toBe("/notes/a.md");
  });

  test("a 429 surfaces the server's Retry-After on the error", async () => {
    const { fetch } = fakeFetch(
      () => new Response("rate limited", { status: 429, headers: { "retry-after": "7" } }),
    );
    const c = new DropboxClient(tokens(), "APPKEY", "", fetch);
    const err = await c.listFolder().then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(DropboxError);
    expect((err as DropboxError).retryAfterMs).toBe(7000);
  });

  test("a 401 is classified as an auth error", async () => {
    const { fetch } = fakeFetch(() => new Response("bad token", { status: 401 }));
    const c = new DropboxClient(tokens(), "APPKEY", "", fetch);
    const err = await c.download("a.md").then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(DropboxAuthError);
  });

  test("a dead refresh token (400 invalid_grant) is an auth error", async () => {
    const { fetch } = fakeFetch(() => new Response('{"error":"invalid_grant"}', { status: 400 }));
    const expired: Tokens = { accessToken: "x", refreshToken: "rt", expiresAt: 0 };
    const c = new DropboxClient(expired, "APPKEY", "", fetch);
    const err = await c.listFolder().then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(DropboxAuthError);
  });

  test("an invalidated cursor is classified as a reset", async () => {
    const { fetch } = fakeFetch(
      () => new Response('{"error_summary":"reset/...","error":{".tag":"reset"}}', { status: 409 }),
    );
    const c = new DropboxClient(tokens(), "APPKEY", "", fetch);
    const err = await c.listFolderContinue("stale").then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(CursorReset);
  });
});

/* ---------------- sync engine ---------------- */

describe("DropboxSync", () => {
  function harness(handler: (url: string, init?: RequestInit) => Response) {
    const { fetch, calls } = fakeFetch(handler);
    const client = new DropboxClient(tokens(), "APPKEY", "", fetch);
    const mirror = new MemMirror();
    const store = new MemStore();
    const errors: string[] = [];
    let changed = 0;
    const sync = new DropboxSync(
      client,
      mirror,
      store,
      { onChanged: () => changed++, onError: (m) => errors.push(m) },
      noSleep,
    );
    return { sync, mirror, store, calls, errors, changedCount: () => changed };
  }

  test("initialSync downloads every markdown file and records the cursor", async () => {
    const h = harness((url) => {
      if (url.endsWith("/list_folder"))
        return json({
          entries: [
            { ".tag": "file", path_display: "/a.md", rev: "r1" },
            { ".tag": "file", path_display: "/b.md", rev: "r2" },
          ],
          cursor: "C1",
          has_more: false,
        });
      if (url.endsWith("/download"))
        return new Response("body", {
          status: 200,
          headers: { "Dropbox-API-Result": JSON.stringify({ rev: "r1" }) },
        });
      return json({});
    });
    await h.sync.initialSync();
    expect(h.mirror.files.get("a.md")).toBe("body");
    expect(h.mirror.files.get("b.md")).toBe("body");
    expect(h.store.get("carnet.dropbox.cursor")).toBe("C1");
    expect(h.changedCount()).toBe(1);
  });

  test("a delta at a rev we already hold is skipped (no redundant download)", async () => {
    const h = harness((url) => {
      if (url.endsWith("/list_folder"))
        return json({
          entries: [{ ".tag": "file", path_display: "/a.md", rev: "r1" }],
          cursor: "C1",
          has_more: false,
        });
      return new Response("body", {
        status: 200,
        headers: { "Dropbox-API-Result": JSON.stringify({ rev: "r1" }) },
      });
    });
    await h.sync.initialSync();
    expect(h.mirror.writes).toBe(1);
    // second pass over the same rev must not re-download
    await h.sync.initialSync();
    expect(h.mirror.writes).toBe(1);
  });

  test("the longpoll loop applies a remote deletion to the mirror", async () => {
    // Pre-seed: we already hold a.md@r1 with a cursor, so run() skips the
    // initial sync and goes straight to longpoll.
    const { fetch } = fakeFetch((url) => {
      if (url.endsWith("/list_folder/longpoll")) return json({ changes: true });
      if (url.endsWith("/list_folder/continue"))
        return json({
          entries: [{ ".tag": "deleted", path_display: "/a.md" }],
          cursor: "C2",
          has_more: false,
        });
      return json({});
    });
    const client = new DropboxClient(tokens(), "APPKEY", "", fetch);
    const mirror = new MemMirror();
    mirror.files.set("a.md", "old");
    const store = new MemStore();
    store.set("carnet.dropbox.cursor", "C1");
    store.set("carnet.dropbox.rev.a.md", "r1");
    const sync = new DropboxSync(
      client,
      mirror,
      store,
      { onChanged: () => sync.stop(), onError: () => {} }, // stop after one batch
      noSleep,
    );
    await sync.run();
    expect(mirror.files.has("a.md")).toBe(false);
    expect(store.get("carnet.dropbox.cursor")).toBe("C2");
    // the dead rev key is removed, not left as an empty string
    expect(store.get("carnet.dropbox.rev.a.md")).toBeNull();
  });

  test("a push that fails offline stays owed and is re-sent later", async () => {
    let online = false;
    const h = harness((url) => {
      if (url.endsWith("/upload")) {
        if (!online) throw new Error("network down");
        return json({ rev: "r9" });
      }
      return json({});
    });
    await h.mirror.write("a.md", "written offline");
    await expect(h.sync.pushNote("a.md", "written offline", undefined)).rejects.toThrow();
    // the edit is the only copy of that text — it must not simply be forgotten
    expect(h.sync.pendingUploads()).toBe(1);

    online = true;
    await h.sync.drainOutbox();
    expect(h.sync.pendingUploads()).toBe(0);
    expect(h.sync.revOf("a.md")).toBe("r9");
  });

  test("draining forgets a note that is gone locally rather than retrying forever", async () => {
    const h = harness((url) => {
      if (url.endsWith("/upload")) throw new Error("network down");
      return json({});
    });
    // never written to the mirror, so there is nothing left to send
    await expect(h.sync.pushNote("ghost.md", "x", undefined)).rejects.toThrow();
    expect(h.sync.pendingUploads()).toBe(1);
    await h.sync.drainOutbox();
    expect(h.sync.pendingUploads()).toBe(0);
  });

  test("a drained note that also moved on Dropbox is reported, never overwritten", async () => {
    const h = harness((url) => {
      if (url.endsWith("/upload")) {
        if (uploads++ === 0) throw new Error("network down");
        return new Response('{"error_summary":"path/conflict"}', { status: 409 });
      }
      return json({});
    });
    let uploads = 0;
    await h.mirror.write("a.md", "my offline edit");
    await expect(h.sync.pushNote("a.md", "my offline edit", undefined)).rejects.toThrow();

    await h.sync.drainOutbox();
    // the local text is the only copy of that edit: leave it alone and say so
    expect(await h.mirror.read("a.md")).toBe("my offline edit");
    expect(h.sync.pendingUploads()).toBe(1);
    expect(h.errors.join(" ")).toContain("a.md");
  });

  test("one unsendable note does not block the rest of the queue forever", async () => {
    const h = harness((url) => {
      if (url.endsWith("/upload")) throw new Error("network down");
      return json({});
    });
    await h.mirror.write("a.md", "one");
    await h.mirror.write("b.md", "two");
    await expect(h.sync.pushNote("a.md", "one", undefined)).rejects.toThrow();
    await expect(h.sync.pushNote("b.md", "two", undefined)).rejects.toThrow();
    expect(h.sync.pendingUploads()).toBe(2);
    await h.sync.drainOutbox(); // still offline: both stay owed, nothing is lost
    expect(h.sync.pendingUploads()).toBe(2);
  });

  test("a pull will not overwrite a note whose upload is still owed", async () => {
    const h = harness((url) => {
      if (url.endsWith("/upload")) throw new Error("network down");
      if (url.endsWith("/list_folder"))
        return json({
          entries: [{ ".tag": "file", path_display: "/a.md", rev: "rServer" }],
          cursor: "C1",
          has_more: false,
        });
      return new Response("the server's version", {
        status: 200,
        headers: { "Dropbox-API-Result": '{"rev":"rServer"}' },
      });
    });
    await h.mirror.write("a.md", "my only copy of this edit");
    await expect(h.sync.pushNote("a.md", "my only copy of this edit", undefined)).rejects.toThrow();

    // a remote change to the same note arrives before the edit could be sent
    await h.sync.initialSync();

    expect(await h.mirror.read("a.md")).toBe("my only copy of this edit");
    expect(h.sync.pendingUploads()).toBe(1);
    expect(h.errors.join(" ")).toContain("a.md");
  });

  test("a re-send carries the newest local text, not the text that failed", async () => {
    const uploaded: string[] = [];
    const h = harness((url, init) => {
      if (url.endsWith("/upload")) {
        if (uploaded.length === 0 && !online) throw new Error("network down");
        uploaded.push(init!.body as string);
        return json({ rev: "rNew" });
      }
      return json({});
    });
    let online = false;
    await h.mirror.write("a.md", "first attempt");
    await expect(h.sync.pushNote("a.md", "first attempt", undefined)).rejects.toThrow();

    // the user keeps writing while offline; the mirror holds the newer text
    await h.mirror.write("a.md", "second, newer attempt");
    online = true;
    await h.sync.drainOutbox();

    expect(uploaded).toEqual(["second, newer attempt"]);
    expect(h.sync.pendingUploads()).toBe(0);
  });

  test("an incomplete initial sync leaves no cursor, so nothing claims to be synced", async () => {
    let downloads = 0;
    const h = harness((url) => {
      if (url.endsWith("/list_folder"))
        return json({
          entries: [
            { ".tag": "file", path_display: "/a.md", rev: "r1" },
            { ".tag": "file", path_display: "/b.md", rev: "r2" },
          ],
          cursor: "C1",
          has_more: false,
        });
      if (++downloads === 2) throw new Error("connection dropped mid-sync");
      return new Response("body", { status: 200, headers: { "Dropbox-API-Result": '{"rev":"r1"}' } });
    });
    await expect(h.sync.initialSync()).rejects.toThrow();
    // half the vault is on disk; claiming "synced" here is what let the app
    // create an empty note over a real one
    expect(h.sync.isSynced()).toBe(false);
  });

  test("a partial second page does not advance the cursor either", async () => {
    let pages = 0;
    let downloads = 0;
    const h = harness((url) => {
      if (url.endsWith("/list_folder") || url.endsWith("/list_folder/continue")) {
        pages++;
        return json({
          entries: [{ ".tag": "file", path_display: `/p${pages}.md`, rev: `r${pages}` }],
          cursor: `C${pages}`,
          has_more: pages < 3,
        });
      }
      if (++downloads === 2) throw new Error("dropped");
      return new Response("body", { status: 200, headers: { "Dropbox-API-Result": '{"rev":"rX"}' } });
    });
    await expect(h.sync.initialSync()).rejects.toThrow();
    expect(h.sync.isSynced()).toBe(false);
  });

  test("progress is reported per note, so a long first sync isn't silent", async () => {
    const { fetch } = fakeFetch((url) => {
      if (url.endsWith("/list_folder"))
        return json({
          entries: [
            { ".tag": "file", path_display: "/a.md", rev: "r1" },
            { ".tag": "file", path_display: "/b.md", rev: "r2" },
            { ".tag": "file", path_display: "/c.md", rev: "r3" },
          ],
          cursor: "C1",
          has_more: false,
        });
      return new Response("body", { status: 200, headers: { "Dropbox-API-Result": '{"rev":"r"}' } });
    });
    const progress: number[] = [];
    const sync = new DropboxSync(
      new DropboxClient(tokens(), "APPKEY", "", fetch),
      new MemMirror(),
      new MemStore(),
      { onChanged: () => {}, onError: () => {}, onProgress: (n) => progress.push(n) },
      noSleep,
    );
    await sync.initialSync();
    expect(progress).toEqual([1, 2, 3]);
    expect(sync.fetchedCount()).toBe(3);
  });

  test("isSynced only becomes true once a full listing has landed", async () => {
    const h = harness((url) => {
      if (url.endsWith("/list_folder"))
        return json({
          entries: [{ ".tag": "file", path_display: "/a.md", rev: "r1" }],
          cursor: "C1",
          has_more: false,
        });
      return new Response("body", { status: 200, headers: { "Dropbox-API-Result": '{"rev":"r1"}' } });
    });
    expect(h.sync.isSynced()).toBe(false);
    await h.sync.initialSync();
    expect(h.sync.isSynced()).toBe(true);
  });

  test("pushNote records the returned rev on success", async () => {
    const h = harness(() => json({ rev: "rNEW" }));
    const out = await h.sync.pushNote("a.md", "content", undefined);
    expect(out).toEqual({ status: "ok" });
    expect(h.store.get("carnet.dropbox.rev.a.md")).toBe("rNEW");
  });

  /** Conflicts on upload, and serves "server-wins" at rev rServer. */
  function conflicting(onUpload?: (body: string) => Response) {
    return harness((url, init) => {
      if (url.endsWith("/upload")) {
        const r = onUpload?.(init!.body as string);
        if (r) return r;
        return new Response('{"error_summary":"path/conflict"}', { status: 409 });
      }
      if (url.endsWith("/download"))
        return new Response("server-wins", {
          status: 200,
          headers: { "Dropbox-API-Result": JSON.stringify({ rev: "rServer" }) },
        });
      return json({});
    });
  }

  test("a conflict reports the server copy but leaves the local file alone", async () => {
    const h = conflicting();
    await h.mirror.write("a.md", "mine");
    h.store.set("carnet.dropbox.rev.a.md", "rOld");

    const out = await h.sync.pushNote("a.md", "mine", "rOld");
    expect(out).toEqual({ status: "conflict", content: "server-wins" });
    // the user hasn't been asked yet — their text must still be the local copy
    expect(await h.mirror.read("a.md")).toBe("mine");
    // and it stays owed, so dying with the dialog open doesn't lose it
    expect(h.sync.pendingUploads()).toBe(1);
  });

  test("resolving 'keep mine' re-uploads against the rev that was just fetched", async () => {
    const bases: (string | undefined)[] = [];
    let first = true;
    const h = conflicting((body) => {
      if (first) {
        first = false;
        return undefined as unknown as Response; // let it 409 once
      }
      return json({ rev: "rMine", _body: body } as never);
    });
    await h.mirror.write("a.md", "mine");
    h.store.set("carnet.dropbox.rev.a.md", "rOld");
    await h.sync.pushNote("a.md", "mine", "rOld");

    // record what the winning upload was conditioned on
    const spy = h.calls.filter((c) => c.url.endsWith("/upload"));
    const out = await h.sync.resolveConflict("a.md", "mine", "mine");
    for (const c of h.calls.filter((x) => x.url.endsWith("/upload")).slice(spy.length)) {
      bases.push(JSON.parse((c.init!.headers as Record<string, string>)["Dropbox-API-Arg"]!).mode.update);
    }
    expect(out.status).toBe("ok");
    expect(bases).toEqual(["rServer"]); // not rOld, which would collide again
    expect(await h.mirror.read("a.md")).toBe("mine");
    expect(h.sync.pendingUploads()).toBe(0);
  });

  test("resolving 'take theirs' is the only thing that overwrites the local file", async () => {
    const h = conflicting();
    await h.mirror.write("a.md", "mine");
    h.store.set("carnet.dropbox.rev.a.md", "rOld");
    const out = await h.sync.pushNote("a.md", "mine", "rOld");
    expect(await h.mirror.read("a.md")).toBe("mine");

    await h.sync.resolveConflict("a.md", "theirs", (out as { content: string }).content);
    expect(await h.mirror.read("a.md")).toBe("server-wins");
    expect(h.sync.revOf("a.md")).toBe("rServer");
    expect(h.sync.pendingUploads()).toBe(0);
  });

  test("a note deleted on another device is not removed while its edit is owed", async () => {
    const h = harness((url) => {
      if (url.endsWith("/upload")) throw new Error("network down");
      if (url.endsWith("/list_folder"))
        return json({
          entries: [{ ".tag": "deleted", path_display: "/ideas.md" }],
          cursor: "C1",
          has_more: false,
        });
      return json({});
    });
    await h.mirror.write("ideas.md", "a page written on a train");
    h.store.set("carnet.dropbox.rev.ideas.md", "r1");
    await expect(h.sync.pushNote("ideas.md", "a page written on a train", "r1")).rejects.toThrow();

    await h.sync.initialSync(); // the delete arrives before the edit got out

    expect(await h.mirror.read("ideas.md")).toBe("a page written on a train");
    expect(h.sync.pendingUploads()).toBe(1);
  });

  test("pushNote uploads against the snapshotted base rev, not the stored one", async () => {
    const seen: string[] = [];
    const h = harness((url, init) => {
      if (url.endsWith("/upload")) {
        const arg = JSON.parse((init!.headers as Record<string, string>)["Dropbox-API-Arg"]!);
        seen.push(arg.mode.update);
        return json({ rev: "rNEW" });
      }
      return json({});
    });
    // The store rev has moved (a pull landed) but the edit was based on rOld.
    h.store.set("carnet.dropbox.rev.a.md", "rMoved");
    await h.sync.pushNote("a.md", "mine", "rOld");
    expect(seen).toEqual(["rOld"]); // conditioned on the caller's snapshot
  });

  test("revOf returns the last-synced rev", () => {
    const h = harness(() => json({}));
    h.store.set("carnet.dropbox.rev.a.md", "r7");
    expect(h.sync.revOf("a.md")).toBe("r7");
    expect(h.sync.revOf("missing.md")).toBeUndefined();
  });

  test("an invalidated cursor is dropped and the loop re-lists from scratch", async () => {
    const { fetch } = fakeFetch((url) => {
      if (url.endsWith("/list_folder/longpoll")) return json({ changes: true });
      if (url.endsWith("/list_folder/continue"))
        return new Response('{"error":{".tag":"reset"}}', { status: 409 });
      if (url.endsWith("/list_folder"))
        return json({
          entries: [{ ".tag": "file", path_display: "/a.md", rev: "r1" }],
          cursor: "C2",
          has_more: false,
        });
      return new Response("body", {
        status: 200,
        headers: { "Dropbox-API-Result": JSON.stringify({ rev: "r1" }) },
      });
    });
    const mirror = new MemMirror();
    const store = new MemStore();
    store.set("carnet.dropbox.cursor", "C1"); // stale cursor
    const sync = new DropboxSync(
      new DropboxClient(tokens(), "APPKEY", "", fetch),
      mirror,
      store,
      { onChanged: () => sync.stop(), onError: () => {} }, // stop after the re-list
      noSleep,
    );
    await sync.run();
    expect(mirror.files.get("a.md")).toBe("body");
    expect(store.get("carnet.dropbox.cursor")).toBe("C2");
  });

  test("dead auth stops the loop and calls onAuthExpired", async () => {
    let authExpired = 0;
    const { fetch } = fakeFetch((url) => {
      if (url.endsWith("/list_folder/longpoll")) return json({ changes: true });
      if (url.endsWith("/list_folder/continue")) return new Response("nope", { status: 401 });
      return json({});
    });
    const store = new MemStore();
    store.set("carnet.dropbox.cursor", "C1");
    const sync = new DropboxSync(
      new DropboxClient(tokens(), "APPKEY", "", fetch),
      new MemMirror(),
      store,
      { onChanged: () => {}, onError: () => {}, onAuthExpired: () => authExpired++ },
      noSleep,
    );
    await sync.run(); // resolves because the loop breaks on auth failure
    expect(authExpired).toBe(1);
  });

  test("the loop waits the server's Retry-After after a 429", async () => {
    const slept: number[] = [];
    const { fetch } = fakeFetch((url) => {
      if (url.endsWith("/list_folder/longpoll"))
        return new Response("slow down", { status: 429, headers: { "retry-after": "5" } });
      return json({});
    });
    const store = new MemStore();
    store.set("carnet.dropbox.cursor", "C1");
    const sync = new DropboxSync(
      new DropboxClient(tokens(), "APPKEY", "", fetch),
      new MemMirror(),
      store,
      { onChanged: () => {}, onError: () => sync.stop() }, // stop after the first failure
      (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    );
    await sync.run();
    expect(slept).toContain(5000); // honored Retry-After, not the 1s default backoff
  });
});

describe("CachedStore", () => {
  /** A blob "file" plus a defer that runs the flush on demand. */
  function harness(initial: string | null = null) {
    let blob = initial;
    const writes: (string | null)[] = [];
    let deferred: (() => void) | null = null;
    const store = new CachedStore(
      () => Promise.resolve(blob),
      (b) => {
        blob = b;
        writes.push(b);
        return Promise.resolve();
      },
      (fn) => {
        deferred = fn;
      },
    );
    return { store, writes, blob: () => blob, tick: () => deferred?.() };
  }

  test("survives a restart: what was set comes back", async () => {
    const a = harness();
    a.store.set("carnet.dropbox.cursor", "CUR");
    a.tick();
    const b = harness(a.blob());
    await b.store.load();
    expect(b.store.get("carnet.dropbox.cursor")).toBe("CUR");
    expect(b.store.get("nope")).toBeNull();
  });

  test("coalesces a burst of sets into one write", async () => {
    const h = harness();
    for (let i = 0; i < 50; i++) h.store.set("k" + i, String(i));
    expect(h.writes).toHaveLength(0); // nothing until the deferred flush runs
    h.tick();
    await Promise.resolve();
    expect(h.writes).toHaveLength(1);
    expect(JSON.parse(h.blob() ?? "{}")).toMatchObject({ k0: "0", k49: "49" });
    h.store.set("later", "1"); // a new burst schedules again
    h.tick();
    await Promise.resolve();
    expect(h.writes).toHaveLength(2);
  });

  test("a corrupt or unreadable blob starts empty instead of throwing", async () => {
    const h = harness("{not json");
    await h.store.load();
    expect(h.store.get("carnet.dropbox.cursor")).toBeNull();

    const failing = new CachedStore(
      () => Promise.reject(new Error("no such file")),
      () => Promise.resolve(),
    );
    await failing.load();
    expect(failing.get("carnet.dropbox.cursor")).toBeNull();
  });

  test("clear drops the blob so a reconnect starts clean", async () => {
    const h = harness();
    h.store.set("carnet.dropbox.rev.a.md", "r1");
    h.tick();
    await h.store.clear();
    expect(h.blob()).toBeNull();
    expect(h.store.get("carnet.dropbox.rev.a.md")).toBeNull();
  });

  test("drives the engine: a second run resumes from the persisted cursor", async () => {
    const h = harness();
    let listCalls = 0;
    const { fetch } = fakeFetch((url) => {
      if (url.endsWith("/list_folder")) {
        listCalls++;
        return json({ entries: [], cursor: "C1", has_more: false });
      }
      return json({});
    });
    const sync = new DropboxSync(
      new DropboxClient(tokens(), "APPKEY", "", fetch),
      new MemMirror(),
      h.store,
      { onChanged: () => {}, onError: () => {} },
      noSleep,
    );
    await sync.initialSync();
    h.tick();
    expect(listCalls).toBe(1);

    const restarted = harness(h.blob());
    await restarted.store.load();
    expect(restarted.store.get("carnet.dropbox.cursor")).toBe("C1");
  });
});

describe("backoff", () => {
  test("doubles per failure, capped at a minute", () => {
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(2)).toBe(2000);
    expect(backoffMs(3)).toBe(4000);
    expect(backoffMs(99)).toBe(60_000);
  });
});

import { expect, test, describe } from "bun:test";
import {
  DropboxClient,
  WriteConflict,
  authorizeUrl,
  challengeFor,
  exchangeCode,
  isMarkdown,
  randomVerifier,
  toDropbox,
  toRel,
  type FetchLike,
  type Tokens,
} from "./client/dropbox";
import { DropboxSync, backoffMs, type Mirror, type Store } from "./client/dropboxsync";

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
    const c = new DropboxClient(expired, "APPKEY", fetch, () => clock);
    await c.listFolder("");
    expect(calls[0]!.url).toContain("/oauth2/token");
    // the RPC used the refreshed bearer token
    const auth = (calls[1]!.init!.headers as Record<string, string>).authorization;
    expect(auth).toBe("Bearer NEW");
    expect(c.currentTokens().accessToken).toBe("NEW");
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
    const c = new DropboxClient(tokens(), "APPKEY", fetch);
    const page = await c.listFolder("");
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
    const c = new DropboxClient(tokens(), "APPKEY", fetch);
    expect(await c.download("a.md")).toEqual({ content: "hello", rev: "r9" });
  });

  test("conditional upload maps a 409 conflict to WriteConflict", async () => {
    const { fetch } = fakeFetch(
      () => new Response('{"error_summary":"path/conflict/..."}', { status: 409 }),
    );
    const c = new DropboxClient(tokens(), "APPKEY", fetch);
    await expect(c.upload("a.md", "x", "baseRev")).rejects.toBeInstanceOf(WriteConflict);
  });

  test("upload sends update mode with the base rev when given", async () => {
    const { fetch, calls } = fakeFetch(() => json({ rev: "r2" }));
    const c = new DropboxClient(tokens(), "APPKEY", fetch);
    const out = await c.upload("a.md", "x", "r1");
    expect(out).toEqual({ rev: "r2" });
    const arg = JSON.parse((calls[0]!.init!.headers as Record<string, string>)["Dropbox-API-Arg"]!);
    expect(arg.mode).toEqual({ ".tag": "update", update: "r1" });
  });

  test("longpoll uses the notify host with no auth header", async () => {
    const { fetch, calls } = fakeFetch(() => json({ changes: true }));
    const c = new DropboxClient(tokens(), "APPKEY", fetch);
    const r = await c.longpoll("cur");
    expect(r).toEqual({ changed: true, backoff: 0 });
    expect(calls[0]!.url).toContain("notify.dropboxapi.com");
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBeUndefined();
  });
});

/* ---------------- sync engine ---------------- */

describe("DropboxSync", () => {
  function harness(handler: (url: string, init?: RequestInit) => Response) {
    const { fetch, calls } = fakeFetch(handler);
    const client = new DropboxClient(tokens(), "APPKEY", fetch);
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
    const client = new DropboxClient(tokens(), "APPKEY", fetch);
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
  });

  test("pushNote records the returned rev on success", async () => {
    const h = harness(() => json({ rev: "rNEW" }));
    const out = await h.sync.pushNote("a.md", "content");
    expect(out).toEqual({ status: "ok" });
    expect(h.store.get("carnet.dropbox.rev.a.md")).toBe("rNEW");
  });

  test("pushNote surfaces a conflict and pulls the server copy into the mirror", async () => {
    const h = harness((url) => {
      if (url.endsWith("/upload")) return new Response('{"error_summary":"path/conflict"}', { status: 409 });
      if (url.endsWith("/download"))
        return new Response("server-wins", {
          status: 200,
          headers: { "Dropbox-API-Result": JSON.stringify({ rev: "rServer" }) },
        });
      return json({});
    });
    h.store.set("carnet.dropbox.rev.a.md", "rOld");
    const out = await h.sync.pushNote("a.md", "mine");
    expect(out).toEqual({ status: "conflict", content: "server-wins" });
    expect(h.mirror.files.get("a.md")).toBe("server-wins");
    expect(h.store.get("carnet.dropbox.rev.a.md")).toBe("rServer");
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

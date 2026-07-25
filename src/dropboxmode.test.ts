// The connect flow end-to-end, with the Rust file commands and the network
// faked. This is the part that survives app restarts and mobile copy-paste, so
// it's worth testing away from a phone.

import { expect, test, describe, beforeEach, mock } from "bun:test";

/** stand-in for the app's data dir (read_state / write_state) */
const files = new Map<string, string>();
/** URLs handed to the browser */
const opened: string[] = [];

mock.module("./client/backend", () => ({
  readState: (name: string) => Promise.resolve(files.get(name) ?? null),
  writeState: (name: string, content: string | null) => {
    if (content === null) files.delete(name);
    else files.set(name, content);
    return Promise.resolve();
  },
  openUrl: (url: string) => {
    opened.push(url);
    return Promise.resolve();
  },
  writeNote: () => Promise.resolve(),
  deleteNote: () => Promise.resolve(),
  ensureDir: () => Promise.resolve(),
  setVault: () => {},
  dropboxMirrorDir: () => Promise.resolve("/tmp/carnet-mirror"),
}));

// The migration path reads the webview storage the credentials used to live
// in. Entries are own enumerable properties, as on the real thing, so the
// Object.keys() sweep in disconnect() behaves the same here.
const memStorage: Record<string, string> = {};
Object.defineProperties(memStorage, {
  getItem: { value: (k: string) => memStorage[k] ?? null },
  setItem: { value: (k: string, v: string) => void (memStorage[k] = String(v)) },
  removeItem: { value: (k: string) => void delete memStorage[k] },
});
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memStorage });

const dropbox = await import("./client/dropboxmode");

/** Token endpoint that only honours codes minted for `good` verifiers. */
function tokenServer(good: string[], seen: URLSearchParams[] = []) {
  return async (url: string | URL | Request, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body));
    seen.push(body);
    expect(String(url)).toBe("https://api.dropboxapi.com/oauth2/token");
    if (!good.includes(body.get("code_verifier") ?? "")) {
      return new Response(
        '{"error": "invalid_grant", "error_description": "code doesn\'t exist or has expired"}',
        { status: 400 },
      );
    }
    return new Response(
      JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 14400 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

/** The verifiers currently on disk, oldest first. */
function storedVerifiers(): string[] {
  const raw = files.get("dropbox.json");
  return raw ? ((JSON.parse(raw) as { verifiers?: string[] }).verifiers ?? []) : [];
}

const realFetch = globalThis.fetch;

beforeEach(async () => {
  files.clear();
  for (const k of Object.keys(memStorage)) delete memStorage[k];
  opened.length = 0;
  globalThis.fetch = realFetch;
  await dropbox.load(); // fresh state, as after a reinstall
});

describe("authorize", () => {
  test("persists the verifier before handing off to the browser", async () => {
    await dropbox.beginAuth("  APPKEY  ");
    // The app may be killed while the user is in the browser: whatever the
    // code will be exchanged against has to be on disk by now.
    expect(storedVerifiers()).toHaveLength(1);
    expect(dropbox.appKey()).toBe("APPKEY");
    expect(dropbox.awaitingCode()).toBe(true);

    const url = new URL(opened[0] ?? "");
    expect(url.origin + url.pathname).toBe("https://www.dropbox.com/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("APPKEY");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("token_access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
  });

  test("keeps the last few handshakes, so a code from an older tab still works", async () => {
    await dropbox.beginAuth("APPKEY");
    const first = storedVerifiers()[0] ?? "";
    await dropbox.beginAuth("APPKEY");
    await dropbox.beginAuth("APPKEY");
    expect(storedVerifiers()).toHaveLength(3);
    expect(storedVerifiers()[0]).toBe(first);

    globalThis.fetch = tokenServer([first]) as typeof fetch;
    await dropbox.completeAuth("CODE-FROM-THE-FIRST-TAB");
    expect(dropbox.isConnected()).toBe(true);
  });

  test("only the newest few are kept", async () => {
    for (let i = 0; i < 5; i++) await dropbox.beginAuth("APPKEY");
    expect(storedVerifiers()).toHaveLength(3);
  });
});

describe("completing the handshake", () => {
  test("strips whitespace the paste picked up", async () => {
    await dropbox.beginAuth("APPKEY");
    const seen: URLSearchParams[] = [];
    globalThis.fetch = tokenServer(storedVerifiers(), seen) as typeof fetch;
    await dropbox.completeAuth("  AB CD\n");
    expect(seen[0]?.get("code")).toBe("ABCD");
    expect(seen[0]?.get("grant_type")).toBe("authorization_code");
    expect(seen[0]?.get("client_id")).toBe("APPKEY");
  });

  test("success clears the pending handshake and stores the tokens", async () => {
    await dropbox.beginAuth("APPKEY");
    globalThis.fetch = tokenServer(storedVerifiers()) as typeof fetch;
    await dropbox.completeAuth("CODE");
    expect(dropbox.isConnected()).toBe(true);
    expect(dropbox.awaitingCode()).toBe(false);
    const saved = JSON.parse(files.get("dropbox.json") ?? "{}") as {
      tokens?: { refreshToken?: string };
    };
    expect(saved.tokens?.refreshToken).toBe("RT");
  });

  test("a rejected code explains itself and leaves the handshake retryable", async () => {
    await dropbox.beginAuth("APPKEY");
    globalThis.fetch = tokenServer(["something-else"]) as typeof fetch;
    await expect(dropbox.completeAuth("STALE")).rejects.toThrow(/single-use and expire/);
    expect(dropbox.isConnected()).toBe(false);
    expect(dropbox.awaitingCode()).toBe(true); // the next code can still be pasted
  });

  test("pasting before authorizing says which step is missing", async () => {
    await expect(dropbox.completeAuth("CODE")).rejects.toThrow(/Authorize Dropbox/);
  });

  test("a server or network problem is not blamed on the code", async () => {
    await dropbox.beginAuth("APPKEY");
    globalThis.fetch = (() =>
      Promise.resolve(new Response("bad gateway", { status: 502 }))) as unknown as typeof fetch;
    await expect(dropbox.completeAuth("CODE")).rejects.toThrow(/502/);
  });
});

describe("persistence across a restart", () => {
  test("a handshake started before the app was killed can still be finished", async () => {
    await dropbox.beginAuth("APPKEY");
    const verifier = storedVerifiers()[0] ?? "";
    await dropbox.load(); // relaunch: in-memory state comes back from disk

    expect(dropbox.awaitingCode()).toBe(true);
    expect(dropbox.appKey()).toBe("APPKEY"); // setup screen refills the field
    globalThis.fetch = tokenServer([verifier]) as typeof fetch;
    await dropbox.completeAuth("CODE");
    expect(dropbox.isConnected()).toBe(true);
  });

  test("a connection made before credentials moved off localStorage is migrated", async () => {
    memStorage["carnet.dropbox.appKey"] = "OLDKEY";
    memStorage["carnet.dropbox.tokens"] = JSON.stringify({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 1,
    });
    await dropbox.load();
    expect(dropbox.isConnected()).toBe(true);
    expect(dropbox.appKey()).toBe("OLDKEY");
    expect(files.has("dropbox.json")).toBe(true); // written through to disk
  });

  test("a half-finished handshake in the old single-verifier layout still works", async () => {
    files.set("dropbox.json", JSON.stringify({ appKey: "APPKEY", verifier: "V-OLD" }));
    await dropbox.load();
    expect(dropbox.awaitingCode()).toBe(true);
    globalThis.fetch = tokenServer(["V-OLD"]) as typeof fetch;
    await dropbox.completeAuth("CODE");
    expect(dropbox.isConnected()).toBe(true);
  });

  test("corrupt state doesn't wedge the setup screen", async () => {
    files.set("dropbox.json", "{ truncated");
    await dropbox.load();
    expect(dropbox.isConnected()).toBe(false);
    expect(dropbox.awaitingCode()).toBe(false);
  });

  test("disconnect forgets everything", async () => {
    await dropbox.beginAuth("APPKEY");
    globalThis.fetch = tokenServer(storedVerifiers()) as typeof fetch;
    await dropbox.completeAuth("CODE");
    await dropbox.disconnect();
    expect(dropbox.isConnected()).toBe(false);
    expect(files.has("dropbox.json")).toBe(false);
    expect(files.has("dropbox-sync.json")).toBe(false);
  });
});

test("credentials never travel through the query string", async () => {
  await dropbox.beginAuth("APPKEY");
  expect(opened[0]).not.toContain("code_verifier"); // only the S256 challenge goes out
});

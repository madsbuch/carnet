// Dropbox HTTP API client — pure logic, no Tauri/DOM dependencies so it can be
// unit-tested with an injected `fetch`. Used only in Android's real-time mode;
// desktop keeps talking to a plain folder.
//
// Auth is OAuth2 with PKCE and no redirect URI: Dropbox shows the user an
// authorization code to copy back, so the app needs no registered callback and
// no server. `token_access_type=offline` yields a refresh token we keep.

const AUTHORIZE = "https://www.dropbox.com/oauth2/authorize";
const TOKEN = "https://api.dropboxapi.com/oauth2/token";
const RPC = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";
// The longpoll endpoint lives on a separate host and takes NO auth header.
const NOTIFY = "https://notify.dropboxapi.com/2";

export type FetchLike = typeof fetch;

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** epoch ms after which accessToken should be refreshed */
  expiresAt: number;
}

/** A file that exists on Dropbox (added or modified since the cursor). */
export interface RemoteFile {
  /** vault-relative path, e.g. "projects/carnet.md" (no leading slash) */
  rel: string;
  rev: string;
}

/** One change from a list_folder delta. */
export type Delta =
  | { kind: "file"; rel: string; rev: string }
  | { kind: "deleted"; rel: string };

export interface ListPage {
  deltas: Delta[];
  cursor: string;
  hasMore: boolean;
}

/* ---------------- PKCE ---------------- */

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomVerifier(): string {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(digest);
}

export function authorizeUrl(appKey: string, challenge: string): string {
  const q = new URLSearchParams({
    client_id: appKey,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    token_access_type: "offline",
  });
  return `${AUTHORIZE}?${q}`;
}

/* ---------------- path mapping ---------------- */

/** Dropbox "/A/B.md" -> vault-relative "A/B.md". Root "" stays "". */
export function toRel(dropboxPath: string): string {
  return dropboxPath.replace(/^\/+/, "");
}

/** vault-relative "A/B.md" -> Dropbox "/A/B.md". */
export function toDropbox(rel: string): string {
  return "/" + rel.replace(/^\/+/, "");
}

export function isMarkdown(rel: string): boolean {
  return rel.toLowerCase().endsWith(".md");
}

/* ---------------- error typing ---------------- */

export class DropboxError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`dropbox ${status}: ${body}`);
    this.name = "DropboxError";
  }
}

/** A rev-conditional upload rejected because the file moved on the server. */
export class WriteConflict extends Error {
  constructor() {
    super("write conflict");
    this.name = "WriteConflict";
  }
}

/* ---------------- client ---------------- */

export class DropboxClient {
  private fetch: FetchLike;

  constructor(
    private tokens: Tokens,
    private appKey: string,
    fetchImpl?: FetchLike,
    /** injectable clock so token-expiry logic is testable */
    private now: () => number = () => Date.now(),
  ) {
    this.fetch = fetchImpl ?? fetch;
  }

  currentTokens(): Tokens {
    return this.tokens;
  }

  /** Refresh the access token if it is within 60s of expiry. */
  private async freshAccess(): Promise<string> {
    if (this.now() < this.tokens.expiresAt - 60_000) return this.tokens.accessToken;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.tokens.refreshToken,
      client_id: this.appKey,
    });
    const res = await this.fetch(TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) throw new DropboxError(res.status, await res.text());
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.tokens = {
      ...this.tokens,
      accessToken: json.access_token,
      expiresAt: this.now() + json.expires_in * 1000,
    };
    return this.tokens.accessToken;
  }

  private async rpc<T>(path: string, arg: unknown): Promise<T> {
    const token = await this.freshAccess();
    const res = await this.fetch(`${RPC}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(arg),
    });
    if (!res.ok) throw new DropboxError(res.status, await res.text());
    return (await res.json()) as T;
  }

  /** Initial recursive listing; returns the first page + cursor. */
  listFolder(root = ""): Promise<ListPage> {
    return this.rpc<RawListResult>("/files/list_folder", {
      path: root,
      recursive: true,
      include_deleted: false,
    }).then(parseListResult);
  }

  listFolderContinue(cursor: string): Promise<ListPage> {
    return this.rpc<RawListResult>("/files/list_folder/continue", { cursor }).then(parseListResult);
  }

  /**
   * Block until Dropbox reports a change under `cursor` (or `timeout` seconds
   * elapse). Unauthenticated by design. Returns whether anything changed and an
   * optional server-requested backoff.
   */
  async longpoll(cursor: string, timeout = 480): Promise<{ changed: boolean; backoff: number }> {
    const res = await this.fetch(`${NOTIFY}/files/list_folder/longpoll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cursor, timeout }),
    });
    if (!res.ok) throw new DropboxError(res.status, await res.text());
    const json = (await res.json()) as { changes: boolean; backoff?: number };
    return { changed: json.changes, backoff: json.backoff ?? 0 };
  }

  /** Download a file's bytes as text plus its current rev. */
  async download(rel: string): Promise<{ content: string; rev: string }> {
    const token = await this.freshAccess();
    const res = await this.fetch(`${CONTENT}/files/download`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "Dropbox-API-Arg": apiArg({ path: toDropbox(rel) }),
      },
    });
    if (!res.ok) throw new DropboxError(res.status, await res.text());
    const meta = JSON.parse(res.headers.get("Dropbox-API-Result") ?? "{}") as { rev?: string };
    return { content: await res.text(), rev: meta.rev ?? "" };
  }

  /**
   * Upload text. When `baseRev` is given the write is conditional: Dropbox
   * rejects it (throwing WriteConflict) if the file's rev no longer matches,
   * which is how we detect a collision with another device. With no baseRev the
   * write overwrites unconditionally.
   */
  async upload(rel: string, content: string, baseRev?: string): Promise<{ rev: string }> {
    const token = await this.freshAccess();
    const mode = baseRev ? { ".tag": "update", update: baseRev } : { ".tag": "overwrite" };
    const res = await this.fetch(`${CONTENT}/files/upload`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
        "Dropbox-API-Arg": apiArg({ path: toDropbox(rel), mode, autorename: false, mute: true }),
      },
      body: content,
    });
    if (res.status === 409) {
      const text = await res.text();
      if (text.includes("conflict")) throw new WriteConflict();
      throw new DropboxError(409, text);
    }
    if (!res.ok) throw new DropboxError(res.status, await res.text());
    const json = (await res.json()) as { rev: string };
    return { rev: json.rev };
  }
}

/* ---------------- token exchange (module fns: no tokens yet) ---------------- */

export async function exchangeCode(
  appKey: string,
  code: string,
  verifier: string,
  fetchImpl: FetchLike = fetch,
  now: () => number = () => Date.now(),
): Promise<Tokens> {
  const body = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    client_id: appKey,
    code_verifier: verifier,
  });
  const res = await fetchImpl(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new DropboxError(res.status, await res.text());
  const json = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: now() + json.expires_in * 1000,
  };
}

/* ---------------- list_folder parsing ---------------- */

interface RawEntry {
  ".tag": "file" | "folder" | "deleted";
  path_display?: string;
  path_lower?: string;
  rev?: string;
}
interface RawListResult {
  entries: RawEntry[];
  cursor: string;
  has_more: boolean;
}

function parseListResult(r: RawListResult): ListPage {
  const deltas: Delta[] = [];
  for (const e of r.entries) {
    const path = e.path_display ?? e.path_lower ?? "";
    const rel = toRel(path);
    if (!isMarkdown(rel)) continue; // notes only, matching the folder backend
    if (e[".tag"] === "file") deltas.push({ kind: "file", rel, rev: e.rev ?? "" });
    else if (e[".tag"] === "deleted") deltas.push({ kind: "deleted", rel });
  }
  return { deltas, cursor: r.cursor, hasMore: r.has_more };
}

function apiArg(obj: unknown): string {
  // Dropbox-API-Arg must be HTTP-header safe: escape non-ASCII as \uXXXX.
  return JSON.stringify(obj).replace(/[\u0080-\uffff]/g, (c) =>
    "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

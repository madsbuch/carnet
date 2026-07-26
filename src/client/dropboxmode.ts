// Wires the pure Dropbox engine (dropbox.ts / dropboxsync.ts) to the running
// app: OAuth copy-paste flow, token persistence, and a mirror backed by the
// existing Rust file commands. Android-only; desktop never touches this.
//
// Everything here persists through the Rust `read_state`/`write_state`
// commands rather than localStorage. That matters for the OAuth handshake:
// authorizing leaves Carnet for the browser, and Android is free to kill the
// app while it's in the background. When it comes back the webview is a fresh
// page — and web storage may be gone with it — so a PKCE verifier kept in
// localStorage can vanish between "Authorize" and pasting the code, leaving
// the user with a code that can never be redeemed.

import * as backend from "./backend";
import {
  DropboxClient,
  DropboxError,
  authorizeUrl,
  challengeFor,
  exchangeCode,
  normalizeFolder,
  randomVerifier,
  type Tokens,
} from "./dropbox";
import { CachedStore, DropboxSync, type Mirror, type SyncHooks } from "./dropboxsync";

const AUTH_FILE = "dropbox.json";
const SYNC_FILE = "dropbox-sync.json";
/** where credentials used to live; migrated on first load */
const OLD_APP_KEY = "carnet.dropbox.appKey";
const OLD_TOKENS_KEY = "carnet.dropbox.tokens";

interface Auth {
  appKey?: string;
  tokens?: Tokens;
  /** Dropbox folder to sync, normalized ("" = whole account / app folder). */
  folder?: string;
  /**
   * PKCE verifiers for handshakes that were started but never finished, oldest
   * first. There can be several: tapping "Authorize" again issues a code bound
   * to the new challenge, but the code the user actually pastes may be the one
   * still sitting in the older browser tab. Keeping the last few means the
   * paste works either way instead of failing as `invalid_grant`.
   */
  verifiers?: string[];
  /** single-verifier layout this replaced */
  verifier?: string;
}

const KEEP_VERIFIERS = 3;

let auth: Auth = {};

async function persist(): Promise<void> {
  await backend.writeState(AUTH_FILE, JSON.stringify(auth));
}

/** The engine's cursor + per-file revs. A restart resumes from the cursor
 *  instead of re-downloading every note. */
const cache = new CachedStore(
  () => backend.readState(SYNC_FILE),
  (blob) => backend.writeState(SYNC_FILE, blob),
);

/** The mirror is just the plain-folder backend pointed at the mirror dir. */
const mirror: Mirror = {
  write: async (rel, content) => {
    // remote wins: force-write (no base rev/hash) into the mirror.
    await backend.writeNote(rel, content);
  },
  remove: (rel) => backend.deleteNote(rel),
  read: async (rel) => (await backend.readNote(rel))?.content ?? null,
};

/** The running engine, so callers can ask whether the mirror is complete.
 *  Until it is, a note that simply hasn't downloaded yet is indistinguishable
 *  from one that doesn't exist, and creating it would later push an empty file
 *  over the real one. */
let engine: DropboxSync | null = null;

export function isSynced(): boolean {
  return engine?.isSynced() ?? false;
}

/** Boot step: load persisted credentials, migrating a connection made before
 *  they moved out of localStorage. Must run before {@link isConnected}. */
export async function load(): Promise<void> {
  auth = {}; // whatever is on disk is the truth, including nothing
  const raw = await backend.readState(AUTH_FILE).catch(() => null);
  if (raw) {
    try {
      auth = JSON.parse(raw) as Auth;
    } catch {
      auth = {};
    }
  } else {
    const key = localStorage.getItem(OLD_APP_KEY);
    const tokens = localStorage.getItem(OLD_TOKENS_KEY);
    try {
      if (key || tokens) {
        auth = {
          appKey: key ?? undefined,
          tokens: tokens ? (JSON.parse(tokens) as Tokens) : undefined,
        };
        await persist();
      }
    } catch {
      auth = {}; // nothing usable to migrate — the user reconnects
    }
  }
  await cache.load();
}

export function appKey(): string | null {
  return auth.appKey ?? null;
}

/** The Dropbox folder to sync, normalized ("" = whole account / app folder). */
export function folder(): string {
  return normalizeFolder(auth.folder ?? "");
}

/** Persisted alongside the credentials so it survives an app kill. */
export async function setFolder(input: string): Promise<void> {
  auth = { ...auth, folder: normalizeFolder(input) };
  await persist();
}

export function isConnected(): boolean {
  return auth.appKey !== undefined && auth.tokens !== undefined;
}

/** Pending verifiers, newest first — the order worth trying a code against. */
function pending(): string[] {
  const list = [...(auth.verifiers ?? [])];
  if (auth.verifier) list.push(auth.verifier); // carried over from the old layout
  return list.reverse();
}

/** Whether {@link beginAuth} ran and is waiting for a code to be pasted. */
export function awaitingCode(): boolean {
  return pending().length > 0;
}

/** Step 1 of connecting: open Dropbox's consent page. The user will get an
 *  authorization code to paste back into {@link completeAuth}. The verifier is
 *  on disk before we hand off to the browser, since the app may not survive
 *  being in the background while the user is over there. */
export async function beginAuth(key: string): Promise<void> {
  const appKey = key.trim();
  const verifier = randomVerifier();
  const challenge = await challengeFor(verifier);
  const verifiers = [...pending().reverse(), verifier].slice(-KEEP_VERIFIERS);
  auth = { ...auth, appKey, verifiers, verifier: undefined };
  await persist();
  await backend.openUrl(authorizeUrl(appKey, challenge));
}

/**
 * Step 2: exchange the pasted code for tokens. Dropbox shows the code on a web
 * page, so what arrives here has been through a mobile copy-paste: strip any
 * whitespace it picked up on the way.
 */
export async function completeAuth(code: string): Promise<void> {
  const appKey = auth.appKey;
  const verifiers = pending();
  if (!appKey || verifiers.length === 0) {
    throw new Error('tap "Authorize Dropbox…" first, then paste the code Dropbox shows you');
  }
  const clean = code.replace(/\s+/g, "");
  let failure: unknown;
  for (const verifier of verifiers) {
    try {
      const tokens = await exchangeCode(appKey, clean, verifier);
      auth = { appKey, tokens, folder: auth.folder }; // keep folder, drop verifiers
      await persist();
      return;
    } catch (e) {
      if (!isBadGrant(e)) throw e; // network/server trouble: not the code's fault
      failure ??= e;
    }
  }
  throw badGrantHelp(failure);
}

/** Dropbox's "that code is no good" response, as opposed to a transport error. */
function isBadGrant(e: unknown): boolean {
  return e instanceof DropboxError && e.status === 400 && e.body.includes("invalid_grant");
}

/** invalid_grant covers expired, already-used, and wrong-handshake codes, and
 *  the raw JSON says none of that usefully. */
function badGrantHelp(e: unknown): Error {
  if (!isBadGrant(e)) return e instanceof Error ? e : new Error(String(e));
  return new Error(
    "Dropbox rejected that code. Codes are single-use and expire quickly — tap " +
      '"Authorize Dropbox…" for a fresh one, copy the whole code, and paste it straight away.',
  );
}

export async function disconnect(): Promise<void> {
  auth = {};
  engine = null;
  await backend.writeState(AUTH_FILE, null).catch(() => {});
  await cache.clear();
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith("carnet.dropbox.")) localStorage.removeItem(k);
  }
}

/** Absolute path of the local mirror the vault points at in Dropbox mode. */
export function mirrorDir(): Promise<string> {
  return backend.dropboxMirrorDir();
}

/**
 * Build and start the sync engine. Ensures the mirror dir exists, points the
 * vault at it, does an initial sync, then kicks off the longpoll loop (not
 * awaited — it runs for the life of the session). Returns the engine so the
 * caller can push saves and stop it later.
 */
export async function start(hooks: SyncHooks): Promise<DropboxSync> {
  const { appKey, tokens } = auth;
  if (!appKey || !tokens) throw new Error("Dropbox not connected");

  const dir = await mirrorDir();
  await backend.ensureDir(dir);
  backend.setVault(dir);

  // Self-heal: if the mirror was wiped (storage cleared) but the cache still
  // holds a cursor + revs, a normal sync would skip re-downloading everything
  // (the rev guard). Drop the cache so the initial sync repopulates.
  const notes = await backend.listNotes().catch(() => [] as string[]);
  if (notes.length === 0 && cache.get("carnet.dropbox.cursor") !== null) await cache.clear();

  const client = new DropboxClient(tokens, appKey, folder());
  const persisting: SyncHooks = {
    onChanged: () => {
      // capture the refreshed access token/expiry
      auth = { ...auth, tokens: client.currentTokens() };
      void persist().catch(() => {});
      hooks.onChanged();
    },
    onError: hooks.onError,
    onAuthExpired: hooks.onAuthExpired,
  };
  const sync = new DropboxSync(client, mirror, cache, persisting);
  engine = sync;
  // The loop does the initial sync itself when there's no cursor, and it is NOT
  // awaited here. Awaiting it meant the app rendered nothing at all until the
  // whole vault had downloaded — one HTTP request per note, six at a time, so
  // minutes of blank screen on a large vault, with the app looking hung. The UI
  // comes up against whatever the mirror already holds and fills in as notes
  // arrive; onChanged refreshes it, and isSynced() still gates note creation.
  void sync.run();
  return sync;
}

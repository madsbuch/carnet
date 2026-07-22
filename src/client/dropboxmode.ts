// Wires the pure Dropbox engine (dropbox.ts / dropboxsync.ts) to the running
// app: OAuth copy-paste flow, token persistence, and a mirror backed by the
// existing Rust file commands. Android-only; desktop never touches this.

import * as backend from "./backend";
import {
  DropboxClient,
  authorizeUrl,
  challengeFor,
  exchangeCode,
  randomVerifier,
  type Tokens,
} from "./dropbox";
import { DropboxSync, type Mirror, type Store, type SyncHooks } from "./dropboxsync";

const APP_KEY = "carnet.dropbox.appKey";
const TOKENS_KEY = "carnet.dropbox.tokens";
const VERIFIER_KEY = "carnet.dropbox.verifier";

/** localStorage as the engine's durable key/value store. */
const store: Store = {
  get: (k) => localStorage.getItem(k),
  set: (k, v) => localStorage.setItem(k, v),
};

/** The mirror is just the plain-folder backend pointed at the mirror dir. */
const mirror: Mirror = {
  write: async (rel, content) => {
    // remote wins: force-write (no base rev/hash) into the mirror.
    await backend.writeNote(rel, content);
  },
  remove: (rel) => backend.deleteNote(rel),
};

export function appKey(): string | null {
  return localStorage.getItem(APP_KEY);
}

export function setAppKey(key: string): void {
  localStorage.setItem(APP_KEY, key.trim());
}

export function isConnected(): boolean {
  return appKey() !== null && localStorage.getItem(TOKENS_KEY) !== null;
}

function loadTokens(): Tokens | null {
  const raw = localStorage.getItem(TOKENS_KEY);
  return raw ? (JSON.parse(raw) as Tokens) : null;
}

function saveTokens(t: Tokens): void {
  localStorage.setItem(TOKENS_KEY, JSON.stringify(t));
}

/** Step 1 of connecting: open Dropbox's consent page. The user will get an
 *  authorization code to paste back into {@link completeAuth}. */
export async function beginAuth(key: string): Promise<void> {
  setAppKey(key);
  const verifier = randomVerifier();
  localStorage.setItem(VERIFIER_KEY, verifier);
  const url = authorizeUrl(key, await challengeFor(verifier));
  await backend.openUrl(url);
}

/** Step 2: exchange the pasted code for tokens. */
export async function completeAuth(code: string): Promise<void> {
  const key = appKey();
  const verifier = localStorage.getItem(VERIFIER_KEY);
  if (!key || !verifier) throw new Error("start the Dropbox connection first");
  const tokens = await exchangeCode(key, code.trim(), verifier);
  saveTokens(tokens);
  localStorage.removeItem(VERIFIER_KEY);
}

export function disconnect(): void {
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
  const key = appKey();
  const tokens = loadTokens();
  if (!key || !tokens) throw new Error("Dropbox not connected");

  const dir = await mirrorDir();
  await backend.ensureDir(dir);
  backend.setVault(dir);

  const client = new DropboxClient(tokens, key);
  const persisting: SyncHooks = {
    onChanged: () => {
      saveTokens(client.currentTokens()); // capture refreshed access token/expiry
      hooks.onChanged();
    },
    onError: hooks.onError,
  };
  const sync = new DropboxSync(client, mirror, store, persisting);
  await sync.initialSync();
  void sync.run();
  return sync;
}

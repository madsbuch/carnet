// Real-time sync engine (Android). Keeps a local mirror folder in lockstep with
// Dropbox: pulls changes via a longpoll loop and pushes local saves back.
//
// The orchestration here is pure — filesystem writes, persistence, and the UI
// refresh are all injected — so the delta-application and loop logic can be
// unit-tested without Tauri or the network.

import {
  CursorReset,
  DropboxAuthError,
  DropboxClient,
  DropboxError,
  WriteConflict,
  isMarkdown,
  type Delta,
  type ListPage,
} from "./dropbox";

/** Writes into the local mirror. On Android these are the existing Rust IPC
 *  commands (write_note / delete_note) pointed at the mirror directory. */
export interface Mirror {
  write(rel: string, content: string): Promise<void>;
  remove(rel: string): Promise<void>;
  /** Current text of a mirrored note, or null if it isn't there. Used to
   *  re-send a save whose upload failed. */
  read(rel: string): Promise<string | null>;
}

/** Durable key/value for cursor and per-file revs (a persisted blob in the app). */
export interface Store {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  /** Every key currently held, for scanning the outbox. */
  keys(): string[];
}

export interface SyncHooks {
  /** Called after a batch of remote changes lands in the mirror. */
  onChanged(): void;
  /** Notes fetched so far. A first sync of a large vault takes minutes, and
   *  without this the app has nothing to say for the whole of it. */
  onProgress?(fetched: number): void;
  /** Non-fatal problem worth surfacing (e.g. a toast). */
  onError(message: string): void;
  /** Auth died (token revoked/expired); the loop has stopped and the user must
   *  reconnect. Falls back to onError if not provided. */
  onAuthExpired?(): void;
}

const CURSOR_KEY = "carnet.dropbox.cursor";
const REV_PREFIX = "carnet.dropbox.rev.";
/** Notes saved locally whose upload hasn't succeeded yet. Persisted, because
 *  the usual reason a push fails is that the phone is offline — and the usual
 *  thing that happens next is the app being killed. */
const OUTBOX_PREFIX = "carnet.dropbox.outbox.";

/** How many files to download at once during a large sync. */
const DOWNLOAD_CONCURRENCY = 6;

/**
 * A {@link Store} held in memory and persisted as one JSON blob. Reads stay
 * synchronous (the engine wants them that way) while writes go through an
 * async sink — a file, in the app — and are coalesced, since applying a delta
 * touches the store once per file.
 *
 * The blob is only a cache: if it's missing or unparseable the engine just
 * re-lists the vault and refills it.
 */
export class CachedStore implements Store {
  private data: Record<string, string> = {};
  private pending = false;

  constructor(
    private read: () => Promise<string | null>,
    private write: (blob: string | null) => Promise<void>,
    /** injected so tests don't wait on a real timer */
    private defer: (fn: () => void) => void = (fn) => void setTimeout(fn, 500),
  ) {}

  /** Load the persisted blob. Call before handing the store to the engine. */
  async load(): Promise<void> {
    let raw: string | null = null;
    try {
      raw = await this.read();
    } catch {
      return; // unreadable cache: start empty
    }
    if (raw === null) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") this.data = parsed as Record<string, string>;
    } catch {
      /* corrupt cache: start empty */
    }
  }

  get(key: string): string | null {
    return this.data[key] ?? null;
  }

  set(key: string, value: string): void {
    this.data[key] = value;
    this.schedule();
  }

  remove(key: string): void {
    delete this.data[key];
    this.schedule();
  }

  keys(): string[] {
    return Object.keys(this.data);
  }

  private schedule(): void {
    if (this.pending) return;
    this.pending = true;
    this.defer(() => {
      this.pending = false;
      void this.flush();
    });
  }

  flush(): Promise<void> {
    return this.write(JSON.stringify(this.data)).catch(() => {});
  }

  /** Drop everything, on disk too (disconnecting from Dropbox). */
  async clear(): Promise<void> {
    this.data = {};
    await this.write(null).catch(() => {});
  }
}

/** revs are stored one key per path so a huge vault doesn't need a bespoke
 *  serialization step on every save. */
class RevMap {
  constructor(private store: Store) {}
  get(rel: string): string | undefined {
    return this.store.get(REV_PREFIX + rel) ?? undefined;
  }
  set(rel: string, rev: string): void {
    this.store.set(REV_PREFIX + rel, rev);
  }
  forget(rel: string): void {
    this.store.remove(REV_PREFIX + rel);
  }
}

export class DropboxSync {
  private revs: RevMap;
  /** Server rev fetched while reporting a conflict, so the user's "keep mine"
   *  uploads against it instead of colliding again. In memory only: an
   *  unresolved conflict is re-detected from scratch next time. */
  private serverRevs = new Map<string, string>();
  /** Notes downloaded this session, for progress reporting. */
  private fetched = 0;
  private running = false;
  private stopped = false;
  /** aborts the in-flight longpoll so stop() takes effect immediately */
  private poll: AbortController | null = null;

  constructor(
    private client: DropboxClient,
    private mirror: Mirror,
    private store: Store,
    private hooks: SyncHooks,
    /** injected so tests don't actually wait between longpolls */
    private sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {
    this.revs = new RevMap(store);
  }

  private cursor(): string | null {
    return this.store.get(CURSOR_KEY);
  }
  private setCursor(c: string): void {
    this.store.set(CURSOR_KEY, c);
  }

  /** Pull the whole vault into the mirror once, establishing a cursor. Safe to
   *  call repeatedly; only downloads files whose rev we don't already have. */
  async initialSync(): Promise<void> {
    let page: ListPage = await this.client.listFolder();
    await this.applyPage(page);
    while (page.hasMore) {
      page = await this.client.listFolderContinue(page.cursor);
      await this.applyPage(page);
    }
    this.setCursor(page.cursor);
    this.hooks.onChanged();
  }

  private async applyPage(page: ListPage): Promise<void> {
    // Deletions are cheap and touch the store; do them inline. Downloads are
    // the slow part, so run them with bounded concurrency.
    const files: Delta[] = [];
    for (const d of page.deltas) {
      if (d.kind === "deleted") await this.applyDelta(d);
      else files.push(d);
    }
    await mapPool(files, DOWNLOAD_CONCURRENCY, (d) => this.applyDelta(d));
  }

  private async applyDelta(d: Delta): Promise<void> {
    // A pull must never touch a note whose own edit hasn't been delivered yet —
    // that local text is the only copy of it. This has to come before the
    // deletion branch as well as the download: a note deleted or renamed on
    // another device arrives here as a delete, and removing the mirror file
    // would take the un-uploaded edit with it. Leaving the rev unrecorded means
    // the delta is applied later, once the edit is out.
    if (this.store.get(OUTBOX_PREFIX + d.rel) !== null) {
      this.hooks.onError(`${d.rel} changed in Dropbox but has unsent local edits`);
      return;
    }
    if (d.kind === "deleted") {
      if (this.revs.get(d.rel) !== undefined) {
        await this.mirror.remove(d.rel);
        this.revs.forget(d.rel);
      }
      return;
    }
    // A file we already have at this exact rev needs no download — this makes
    // the loop idempotent and ignores the echo of our own uploads.
    if (this.revs.get(d.rel) === d.rev) return;
    const { content, rev } = await this.client.download(d.rel);
    await this.mirror.write(d.rel, content);
    this.revs.set(d.rel, rev);
    this.fetched++;
    this.hooks.onProgress?.(this.fetched);
  }

  /** How many notes this session has pulled down. */
  fetchedCount(): number {
    return this.fetched;
  }

  /** Longpoll loop: block until Dropbox reports a change, drain the deltas into
   *  the mirror, repeat. Runs until stop(). */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    let failures = 0;
    while (!this.stopped) {
      try {
        // Anything a previous save couldn't deliver goes first: it is the only
        // copy of that edit, and the pull below may overwrite the mirror.
        await this.drainOutbox();
        if (this.stopped) break;
        const cursor = this.cursor();
        if (!cursor) {
          await this.initialSync();
          continue;
        }
        this.poll = new AbortController();
        const { changed, backoff } = await this.client.longpoll(cursor, 480, this.poll.signal);
        if (this.stopped) break;
        if (backoff > 0) await this.sleep(backoff * 1000);
        if (changed) {
          let page = await this.client.listFolderContinue(cursor);
          await this.applyPage(page);
          while (page.hasMore) {
            page = await this.client.listFolderContinue(page.cursor);
            await this.applyPage(page);
          }
          this.setCursor(page.cursor);
          this.hooks.onChanged();
        }
        failures = 0;
      } catch (e) {
        if (this.stopped) break;
        // Dead auth: stop and hand off to the user, don't retry forever.
        if (e instanceof DropboxAuthError) {
          if (this.hooks.onAuthExpired) this.hooks.onAuthExpired();
          else this.hooks.onError("Dropbox access expired — reconnect to keep syncing");
          break;
        }
        // Invalidated cursor: drop it and re-list from scratch next iteration.
        if (e instanceof CursorReset) {
          this.store.remove(CURSOR_KEY);
          failures = 0;
          continue;
        }
        failures++;
        this.hooks.onError("Dropbox sync: " + (e instanceof Error ? e.message : String(e)));
        // Honor a server-requested Retry-After (429/503); otherwise exponential
        // backoff capped at ~1 min so a blip doesn't hammer the API.
        const wait = e instanceof DropboxError && e.retryAfterMs ? e.retryAfterMs : backoffMs(failures);
        await this.sleep(wait);
      }
    }
    this.running = false;
  }

  stop(): void {
    this.stopped = true;
    this.poll?.abort();
  }

  /** The last-synced rev of a note, for the caller to snapshot before editing
   *  so a racing pull can't silently move the upload's base out from under it. */
  revOf(rel: string): string | undefined {
    return this.revs.get(rel);
  }

  /**
   * Push a locally-saved note to Dropbox. `baseRev` is the rev the edit was
   * based on — pass the value snapshotted with {@link revOf} *before* the local
   * write, NOT a value read at push time, so that a pull landing mid-save turns
   * into a real conflict instead of a silent overwrite (undefined = a new file,
   * uploaded unconditionally). Returns the outcome so the caller can reuse
   * Carnet's existing conflict UI:
   *  - "ok": uploaded, rev recorded.
   *  - "conflict": the file moved on the server; `content` is the server copy
   *    now in the mirror, for the user to reconcile.
   */
  async pushNote(
    rel: string,
    content: string,
    baseRev: string | undefined,
  ): Promise<{ status: "ok" } | { status: "conflict"; content: string }> {
    if (!isMarkdown(rel)) throw new Error("only .md notes sync to Dropbox");
    // Queued up front: if this throws (offline, dead Wi-Fi) the save is still
    // recorded as owed, and drainOutbox re-sends it when the network is back.
    this.store.set(OUTBOX_PREFIX + rel, "1");
    try {
      const { rev } = await this.client.upload(rel, content, baseRev || undefined);
      this.revs.set(rel, rev);
      this.store.remove(OUTBOX_PREFIX + rel);
      return { status: "ok" };
    } catch (e) {
      if (e instanceof WriteConflict) {
        // Fetch the server's version but leave the mirror alone: the local file
        // still holds the user's text, and this function has no idea which of
        // the two they want. Writing the server copy here destroyed their edit
        // before the dialog had even opened — and if the app died with the
        // dialog up, it was gone. The entry stays owed for the same reason;
        // resolveConflict() clears it once a choice has actually been made.
        const server = await this.client.download(rel);
        this.serverRevs.set(rel, server.rev);
        return { status: "conflict", content: server.content };
      }
      throw e;
    }
  }

  /**
   * Commit the user's answer to a conflict {@link pushNote} reported.
   *
   * "mine" re-uploads against the rev that was just fetched, so it wins rather
   * than colliding again. "theirs" is the only path that overwrites the mirror,
   * and it happens only because the user asked for it.
   */
  async resolveConflict(
    rel: string,
    choice: "mine" | "theirs",
    content: string,
  ): Promise<{ status: "ok" } | { status: "conflict"; content: string }> {
    const serverRev = this.serverRevs.get(rel);
    if (choice === "theirs") {
      await this.mirror.write(rel, content);
      if (serverRev !== undefined) this.revs.set(rel, serverRev);
      this.serverRevs.delete(rel);
      this.store.remove(OUTBOX_PREFIX + rel);
      return { status: "ok" };
    }
    const out = await this.pushNote(rel, content, serverRev);
    if (out.status === "ok") this.serverRevs.delete(rel);
    return out;
  }

  /** Paths whose upload never landed. */
  private owed(): string[] {
    return this.store
      .keys()
      .filter((k) => k.startsWith(OUTBOX_PREFIX))
      .map((k) => k.slice(OUTBOX_PREFIX.length));
  }

  /**
   * Re-send saves whose upload failed. Runs on every loop pass, so coming back
   * into coverage is enough to deliver them. A note that has *also* changed on
   * Dropbox is left queued and reported rather than resolved silently — the
   * local text is the only copy of that edit, so nothing here may overwrite it.
   */
  async drainOutbox(): Promise<void> {
    for (const rel of this.owed()) {
      if (this.stopped) return;
      const content = await this.mirror.read(rel).catch(() => null);
      if (content === null) {
        this.store.remove(OUTBOX_PREFIX + rel); // gone locally; nothing to send
        continue;
      }
      try {
        const { rev } = await this.client.upload(rel, content, this.revs.get(rel));
        this.revs.set(rel, rev);
        this.store.remove(OUTBOX_PREFIX + rel);
      } catch (e) {
        if (e instanceof WriteConflict) {
          this.hooks.onError(`${rel} changed in Dropbox too — open it to resolve`);
          continue;
        }
        return; // still offline: everything else is owed too, try again later
      }
    }
  }

  /** How many saves are still waiting to reach Dropbox. */
  pendingUploads(): number {
    return this.owed().length;
  }

  /** True once a listing has run to completion, i.e. the mirror holds every
   *  note Dropbox has. The cursor is only stored after a full drain, so its
   *  presence is exactly that guarantee. */
  isSynced(): boolean {
    return this.cursor() !== null;
  }
}

/* ---------------- helpers ---------------- */

export function backoffMs(failures: number): number {
  return Math.min(60_000, 1000 * 2 ** (failures - 1));
}

/** Run `fn` over `items` with at most `n` in flight. Rejects if any does. */
async function mapPool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < items.length) {
      const item = items[i++]!;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

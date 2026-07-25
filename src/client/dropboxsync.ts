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
}

/** Durable key/value for cursor and per-file revs (a persisted blob in the app). */
export interface Store {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface SyncHooks {
  /** Called after a batch of remote changes lands in the mirror. */
  onChanged(): void;
  /** Non-fatal problem worth surfacing (e.g. a toast). */
  onError(message: string): void;
  /** Auth died (token revoked/expired); the loop has stopped and the user must
   *  reconnect. Falls back to onError if not provided. */
  onAuthExpired?(): void;
}

const CURSOR_KEY = "carnet.dropbox.cursor";
const REV_PREFIX = "carnet.dropbox.rev.";

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
    try {
      const { rev } = await this.client.upload(rel, content, baseRev || undefined);
      this.revs.set(rel, rev);
      return { status: "ok" };
    } catch (e) {
      if (e instanceof WriteConflict) {
        const server = await this.client.download(rel);
        await this.mirror.write(rel, server.content);
        this.revs.set(rel, server.rev);
        return { status: "conflict", content: server.content };
      }
      throw e;
    }
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

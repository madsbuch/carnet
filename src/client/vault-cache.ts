// Everything the app knows about the vault, and the rules for keeping it true.
//
// Three things are cached, with three different lifetimes:
//
//  - `links` answers "does [x] exist?" from the path list alone. The renderer
//    needs that answer synchronously for every wiki link, so it can't wait on
//    note bodies.
//  - the note bodies, fetched once and then PATCHED on save. Dropping them per
//    save meant re-reading and re-parsing the whole vault before the next
//    backlinks render.
//  - the link structure over those bodies, edited in place on save so a save
//    costs O(links in that note) rather than O(vault).
//
// This lives apart from app.ts because getting it wrong shows up as wrong
// backlinks and wrong link colours rather than as a crash, and the only way to
// be sure is to drive the sequences directly. The source is injected, so the
// tests need no Tauri and no DOM.
import { buildLinkIndex, type LinkIndex } from "../links";
import { VaultIndex } from "../vault-index";

export interface CachedNote {
  path: string;
  content: string;
  mtime: number;
}

export interface NoteMeta {
  path: string;
  mtime: number;
}

/** The filesystem, as this cache needs it. */
export interface VaultSource {
  listMeta(): Promise<NoteMeta[]>;
  readAll(): Promise<CachedNote[]>;
}

/** Yield to the event loop, so a long build doesn't block painting. */
const defaultPause = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

export interface RefreshResult {
  /** Something on disk moved since the last look. */
  changed: boolean;
  /** The set of note paths itself moved (not just their contents). */
  pathsMoved: boolean;
}

export class VaultCache {
  private pathList: string[] = [];
  private linkIndex: LinkIndex = buildLinkIndex([]);
  /** Resolved note bodies, once loaded. A plain array, so a save can patch it
   *  synchronously without awaiting anything. */
  private notes: CachedNote[] | null = null;
  /** The read in flight, shared so concurrent callers don't each start one. */
  private inFlight: Promise<CachedNote[]> | null = null;
  private index: VaultIndex | null = null;
  private building: Promise<VaultIndex> | null = null;
  /** Path + mtime of every note as last seen. */
  private meta: NoteMeta[] = [];
  /** Bumped by every invalidation. A read or a build that started before the
   *  bump is answering a question about a vault that no longer exists, so its
   *  result must not be published — it would otherwise overwrite the cleared
   *  cache with a stale snapshot, after the clearing. */
  private generation = 0;

  constructor(
    private source: VaultSource,
    private pause: () => Promise<void> = defaultPause,
    /** How long the index build may run before yielding. */
    private sliceMs = 8,
  ) {}

  /* ---------- paths (always available synchronously) ---------- */

  paths(): string[] {
    return this.pathList;
  }

  /** Resolve/`has` for wiki links. Needs only the path list. */
  links(): LinkIndex {
    return this.linkIndex;
  }

  /** Adopt a listing as the current truth. Anything derived only from paths is
   *  rebuilt here; anything derived from bodies is dropped. */
  adopt(meta: NoteMeta[]): void {
    this.meta = meta;
    this.setPaths(meta.map((m) => m.path));
    this.invalidate();
  }

  private setPaths(next: string[]): void {
    this.pathList = next;
    this.linkIndex = buildLinkIndex(next);
  }

  /** A note was just created. */
  addPath(path: string, mtime: number): void {
    if (this.pathList.includes(path)) return;
    this.setPaths([...this.pathList, path].sort());
    this.meta = [...this.meta, { path, mtime }].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    this.invalidate(); // a new path can make links elsewhere resolve
  }

  /** The set of notes changed, so links may resolve differently. */
  invalidate(): void {
    this.generation++;
    this.notes = null;
    this.inFlight = null;
    this.index = null;
    this.building = null;
  }

  /* ---------- bodies and the link structure ---------- */

  allNotes(): Promise<CachedNote[]> {
    if (this.notes) return Promise.resolve(this.notes);
    const gen = this.generation;
    return (this.inFlight ??= this.source.readAll().then(
      (loaded) => {
        if (gen === this.generation) {
          this.notes = loaded;
          this.inFlight = null;
        }
        return loaded;
      },
      (e: unknown) => {
        if (gen === this.generation) this.inFlight = null; // don't cache a failure
        throw e;
      },
    ));
  }

  /**
   * The link structure. Built in slices the first time, so the build doesn't
   * land as one freeze; shared, so two callers don't build it twice.
   *
   * If the vault moved while this was building, the result describes the old
   * vault: hand it back for this one render but don't keep it, so the next
   * caller rebuilds. Keeping it was how a single mid-read save could leave the
   * backlinks and the graph wrong for the rest of the session.
   */
  vaultIndex(): Promise<VaultIndex> {
    if (this.index) return Promise.resolve(this.index);
    const gen = this.generation;
    return (this.building ??= this.allNotes()
      .then((notes) => VaultIndex.build(notes, this.pause, this.sliceMs))
      .then((built) => {
        if (gen === this.generation) {
          this.index = built;
          this.building = null;
        }
        return built;
      })
      .catch((e: unknown) => {
        if (gen === this.generation) this.building = null;
        throw e;
      }));
  }

  /** Backlinks, or an empty list while nothing is loaded yet. */
  async backlinks(path: string): Promise<string[]> {
    return (await this.vaultIndex()).backlinks(path);
  }

  /**
   * A note was written. Patch what's cached rather than dropping it: only this
   * note's own links can have moved, and the file's new mtime is ours, not a
   * change from another device.
   */
  noteSaved(path: string, content: string, mtime: number): void {
    if (this.inFlight || this.building) {
      // A read or a build is in flight and may or may not have seen this write.
      // Not worth reconciling: drop it all and let it be rebuilt on demand.
      //
      // Deliberately WITHOUT recording the new mtime. Recording it here would
      // tell refresh() that this note is already accounted for, and refresh()
      // is the only thing that would ever notice the caches are missing this
      // edit — so a save landing during a read used to leave the backlinks, the
      // graph and full-text search wrong for the rest of the session. Leaving
      // the mtime behind costs one extra listing-triggered re-read instead.
      this.invalidate();
      return;
    }
    const known = this.meta.find((m) => m.path === path);
    if (known) known.mtime = mtime;
    if (!this.notes) return;
    const hit = this.notes.find((n) => n.path === path);
    if (hit) {
      hit.content = content;
      hit.mtime = mtime;
    }
    if (this.index?.knows(path)) this.index.setContent(path, content);
  }

  /* ---------- picking up outside changes ---------- */

  /**
   * Compare the vault against what we last saw. The listing is cheap (one
   * directory walk, no file bodies), so the common case — nothing changed while
   * the app was away — costs that and nothing else.
   */
  async refresh(): Promise<RefreshResult> {
    const fresh = await this.source.listMeta();
    if (sameMeta(fresh, this.meta)) return { changed: false, pathsMoved: false };
    const nextPaths = fresh.map((m) => m.path);
    const pathsMoved =
      nextPaths.length !== this.pathList.length ||
      nextPaths.some((p, i) => p !== this.pathList[i]);
    this.meta = fresh;
    this.invalidate(); // some note's text moved, so the link structure may have
    if (pathsMoved) this.setPaths(nextPaths);
    return { changed: true, pathsMoved };
  }

  /** The mtime we last saw for a note, or undefined if we don't know it. */
  knownMtime(path: string): number | undefined {
    return this.meta.find((m) => m.path === path)?.mtime;
  }
}

export function sameMeta(a: NoteMeta[], b: NoteMeta[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].path !== b[i].path || a[i].mtime !== b[i].mtime) return false;
  }
  return true;
}

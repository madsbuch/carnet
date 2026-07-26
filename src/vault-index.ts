// The vault's link structure, kept up to date in place.
//
// Backlinks and the graph both need "who links to what" over the whole vault.
// Rebuilding that from scratch is O(vault); doing it after every save — which
// is what invalidating the cache amounted to — made writing a note cost a
// full re-resolve of every link in every note. Here the structure is built
// once and then *edited*: saving a note re-resolves only that note's own
// links, which is O(links in the note) no matter how large the vault is.
//
// Pure: no DOM, no filesystem, no Tauri.
import { buildLinkIndex, extractLinks, noteTitle, topFolder, type LinkIndex } from "./links";
import type { GraphData, GraphEdge, GraphNode, NoteDoc } from "./graph-data";

/** Id of a node for a link that doesn't resolve to a real note yet. */
const missingId = (name: string): string => "missing:" + name.toLowerCase();

export class VaultIndex {
  private links: LinkIndex = buildLinkIndex([]);
  private paths: string[] = [];
  /** note -> the node ids it links to, deduped, in source order */
  private outgoing = new Map<string, string[]>();
  /** node id -> the notes that link to it */
  private incoming = new Map<string, Set<string>>();
  /** missing node id -> the name as it was written, for the graph label */
  private missing = new Map<string, string>();

  constructor(notes: NoteDoc[] = []) {
    this.rebuild(notes);
  }

  /** Throw the structure away and build it again. Needed when the set of paths
   *  changes, since a link that was missing may now resolve (and vice versa). */
  rebuild(notes: NoteDoc[]): void {
    this.reset(notes);
    for (const note of notes) this.addLinks(note.path, note.content);
  }

  /**
   * The same result as the constructor, built in time-boxed slices with an
   * `await pause()` between them. Extracting links from every note in a
   * 10,000-note vault is ~180 ms of straight-line work on a desktop and closer
   * to a second on a phone; done in one go it lands as a visible freeze the
   * first time a note's backlinks are wanted. Sliced, the webview keeps
   * painting through it.
   */
  static async build(
    notes: NoteDoc[],
    pause: () => Promise<void>,
    sliceMs = 8,
  ): Promise<VaultIndex> {
    const index = new VaultIndex();
    index.reset(notes);
    let sliceStart = Date.now();
    for (const note of notes) {
      index.addLinks(note.path, note.content);
      if (Date.now() - sliceStart >= sliceMs) {
        await pause();
        sliceStart = Date.now();
      }
    }
    return index;
  }

  private reset(notes: NoteDoc[]): void {
    this.paths = notes.map((n) => n.path);
    this.links = buildLinkIndex(this.paths);
    this.outgoing = new Map();
    this.incoming = new Map();
    this.missing = new Map();
  }

  /** One note's text changed. Only its own links move. */
  setContent(path: string, content: string): void {
    this.dropLinks(path);
    this.addLinks(path, content);
  }

  /** Does the vault know this path? */
  knows(path: string): boolean {
    return this.outgoing.has(path);
  }

  resolve(name: string, fromPath: string): string | null {
    return this.links.resolve(name, fromPath);
  }

  has(name: string, fromPath: string): boolean {
    return this.links.has(name, fromPath);
  }

  /** Notes linking to this one, sorted. O(backlinks), not O(vault). */
  backlinks(path: string): string[] {
    const sources = this.incoming.get(path);
    return sources ? [...sources].sort() : [];
  }

  /** The whole link graph, in the shape the graph view wants. */
  graph(): GraphData {
    const nodes: GraphNode[] = this.paths.map((p) => ({
      id: p,
      title: noteTitle(p),
      group: topFolder(p),
    }));
    for (const [id, name] of this.missing) {
      nodes.push({ id, title: name, group: "", missing: true });
    }
    const edges: GraphEdge[] = [];
    for (const [source, targets] of this.outgoing) {
      for (const target of targets) edges.push({ source, target });
    }
    return { nodes, edges };
  }

  private addLinks(path: string, content: string): void {
    const targets: string[] = [];
    const seen = new Set<string>();
    for (const name of extractLinks(content)) {
      const resolved = this.links.resolve(name, path);
      const target = resolved ?? missingId(name);
      // a note linking to itself is not an edge, and [a] twice is one edge
      if (target === path || seen.has(target)) continue;
      seen.add(target);
      targets.push(target);
      if (!resolved) this.missing.set(target, name);
      let sources = this.incoming.get(target);
      if (!sources) this.incoming.set(target, (sources = new Set()));
      sources.add(path);
    }
    this.outgoing.set(path, targets);
  }

  private dropLinks(path: string): void {
    for (const target of this.outgoing.get(path) ?? []) {
      const sources = this.incoming.get(target);
      if (!sources) continue;
      sources.delete(path);
      if (sources.size === 0) {
        this.incoming.delete(target);
        // a missing node only exists because something pointed at it
        this.missing.delete(target);
      }
    }
    this.outgoing.delete(path);
  }
}

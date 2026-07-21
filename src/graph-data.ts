// Pure vault-level logic: link graph, search, daily notes.
// Works on plain {path, content} objects — no filesystem, no DOM.
import { DAILY_RE, basename, dirOf, extractLinks, noteTitle, resolveLink, todayName, topFolder } from "./links";

export interface NoteDoc {
  path: string;
  content: string;
}

export interface GraphNode {
  id: string;
  title: string;
  group: string;
  missing?: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Build the full link graph. Links to notes that don't exist yet become "missing" nodes. */
export function buildGraph(notes: NoteDoc[]): GraphData {
  const paths = notes.map((n) => n.path);
  const nodes: GraphNode[] = paths.map((p) => ({ id: p, title: noteTitle(p), group: topFolder(p) }));
  const missing = new Map<string, string>();
  const edgeKeys = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const note of notes) {
    for (const name of extractLinks(note.content)) {
      let target = resolveLink(name, note.path, paths);
      if (!target) {
        target = "missing:" + name.toLowerCase();
        missing.set(target, name);
      }
      if (target === note.path) continue;
      const key = note.path + " " + target;
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        edges.push({ source: note.path, target });
      }
    }
  }
  for (const [id, name] of missing) nodes.push({ id, title: name, group: "", missing: true });
  return { nodes, edges };
}

export function searchNotes(
  notes: NoteDoc[],
  q: string,
  limit = 50,
): { path: string; snippet: string | null }[] {
  const needle = q.toLowerCase();
  const results: { path: string; snippet: string | null }[] = [];
  for (const note of notes) {
    let snippet: string | null = null;
    const idx = note.content.toLowerCase().indexOf(needle);
    if (idx >= 0) {
      const start = note.content.lastIndexOf("\n", idx) + 1;
      let end = note.content.indexOf("\n", idx);
      if (end < 0) end = note.content.length;
      snippet = note.content.slice(start, end).trim().slice(0, 160);
    }
    if (snippet !== null || note.path.toLowerCase().includes(needle)) results.push({ path: note.path, snippet });
    if (results.length >= limit) break;
  }
  return results;
}

/**
 * Today's daily note: the existing yyyy-MM-dd.md if present anywhere,
 * otherwise a path in the folder holding the most recent daily note.
 */
export function dailyPath(paths: string[], today = todayName()): { path: string; exists: boolean } {
  const hit = paths.find((p) => basename(p) === today);
  if (hit) return { path: hit, exists: true };
  const dailies = paths.filter((p) => DAILY_RE.test(basename(p)));
  dailies.sort((a, b) => basename(b).localeCompare(basename(a)));
  const folder = dailies.length > 0 ? dirOf(dailies[0]) : "";
  return { path: folder + today, exists: false };
}

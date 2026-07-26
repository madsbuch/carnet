// Force-directed graph of the vault, rendered on canvas.
// Mouse: wheel zoom, drag to pan, drag nodes, click to open.
// Touch: one finger pans (or drags a node), two fingers pinch-zoom.
//
// Scope, not everything. A whole 10,000-note vault is ~50,000 edges: the
// simulation cost is superlinear in how densely packed the nodes are, and at
// that size it settles at well under a frame a second on a phone while drawing
// a hairball nobody can read anyway. So the view starts at the note you are in
// and walks outwards a link at a time (BFS), stopping at MAX_NODES. "Wider"
// takes one more step out. A vault small enough to show whole still shows
// whole — depth grows until it stops adding anything.
import type { GraphData } from "../graph-data";

/** Past this the layout is a hairball and the frame budget is gone. */
const MAX_NODES = 400;
const DEFAULT_DEPTH = 2;

interface SimNode {
  id: string;
  title: string;
  group: string;
  missing: boolean;
  deg: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number | null;
  fy: number | null;
}

const CELL = 180; // repulsion cutoff / spatial grid size

function hue(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

/**
 * The subgraph within `depth` links of `origin`, breadth-first and capped at
 * MAX_NODES. A vault that fits under the cap comes back whole, so small vaults
 * behave exactly as before.
 *
 * `truncated` means the cap stopped it; `reachedAll` means there was nothing
 * further to reach. Either way there is no point offering "Wider".
 */
export function scopeAround(
  full: GraphData,
  origin: string | null,
  depth: number,
): { data: GraphData; truncated: boolean; reachedAll: boolean } {
  if (full.nodes.length <= MAX_NODES) {
    return { data: full, truncated: false, reachedAll: true };
  }
  const neighbours = new Map<string, string[]>();
  const add = (a: string, b: string): void => {
    const list = neighbours.get(a);
    if (list) list.push(b);
    else neighbours.set(a, [b]);
  };
  for (const e of full.edges) {
    add(e.source, e.target);
    add(e.target, e.source);
  }
  // No note open, no such note, or a note with no links: start from the
  // best-connected note, so the view opens on something worth looking at.
  // The link-less case is the one that matters — the app opens today's daily
  // note on launch and a fresh one has no links, so anchoring on it drew a
  // single dot with no way to reach the rest of the vault.
  const usable =
    origin !== null &&
    (neighbours.get(origin)?.length ?? 0) > 0 &&
    full.nodes.some((n) => n.id === origin);
  let start: string;
  if (usable) {
    start = origin;
  } else {
    let best = "";
    let bestDeg = -1;
    for (const n of full.nodes) {
      const d = neighbours.get(n.id)?.length ?? 0;
      if (d > bestDeg) {
        bestDeg = d;
        best = n.id;
      }
    }
    start = best;
  }
  const keep = new Set<string>([start]);
  let frontier = [start];
  let truncated = false;
  for (let step = 0; step < depth && frontier.length > 0 && !truncated; step++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const other of neighbours.get(id) ?? []) {
        if (keep.has(other)) continue;
        if (keep.size >= MAX_NODES) {
          truncated = true;
          break;
        }
        keep.add(other);
        next.push(other);
      }
      if (truncated) break;
    }
    frontier = next;
  }
  const data: GraphData = {
    nodes: full.nodes.filter((n) => keep.has(n.id)),
    edges: full.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  };
  // "Nothing further out" means nothing on the frontier has an unvisited
  // neighbour — not merely that the walk stopped. Reading it off the walk left
  // Wider enabled when it would add nothing, and pressing it re-fitted and
  // re-simulated the identical graph, throwing away the user's pan and zoom.
  const reachedAll =
    !truncated && !frontier.some((id) => (neighbours.get(id) ?? []).some((o) => !keep.has(o)));
  return { data, truncated, reachedAll };
}

export class GraphView {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private nodes: SimNode[] = [];
  private edges: [SimNode, SimNode][] = [];
  private adj = new Map<string, Set<string>>();
  private byId = new Map<string, SimNode>();
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private alpha = 0;
  private raf = 0;
  private visible = false;
  private hovered: SimNode | null = null;
  private currentId: string | null = null;
  private dark = matchMedia("(prefers-color-scheme: dark)");
  private pointers = new Map<number, { x: number; y: number }>();
  private dragNode: SimNode | null = null;
  private downNode: SimNode | null = null;
  private downAt = 0;
  private downX = 0;
  private downY = 0;
  private moved = false;
  private pinchDist = 0;
  private lastDpr = 1;
  /** The whole vault graph; `nodes`/`edges` above hold the visible scope. */
  private full: GraphData = { nodes: [], edges: [] };
  private depth = DEFAULT_DEPTH;
  private label: HTMLElement;
  private widerBtn: HTMLButtonElement;
  private narrowerBtn: HTMLButtonElement;
  /** Frames of quiet before the loop parks itself. */
  private idle = 0;
  private dprTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private container: HTMLElement,
    private onOpen: (path: string) => void,
    private onClose: () => void,
  ) {
    this.canvas = container.querySelector("canvas")!;
    this.ctx = this.canvas.getContext("2d")!;
    this.label = container.querySelector<HTMLElement>("#graph-scope-label")!;
    this.widerBtn = container.querySelector<HTMLButtonElement>("#graph-wider")!;
    this.narrowerBtn = container.querySelector<HTMLButtonElement>("#graph-narrower")!;
    this.widerBtn.addEventListener("click", () => this.widen());
    this.narrowerBtn.addEventListener("click", () => this.narrow());
    container.querySelector("#graph-close")!.addEventListener("click", () => this.onClose());
    window.addEventListener("resize", () => {
      if (this.visible) {
        this.resize();
        this.wake();
      }
    });
    // The loop parks itself once the layout settles, which also stops the
    // per-frame checks it used to carry. Light/dark is read inside draw(), so
    // without this the canvas kept light-mode node colours and white label
    // halos on a dark panel until something happened to wake it.
    this.dark.addEventListener("change", () => this.wake());

    const c = this.canvas;
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015));
      this.wake();
    }, { passive: false });

    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (this.pointers.size === 1) {
        this.downAt = performance.now();
        this.downX = e.offsetX;
        this.downY = e.offsetY;
        this.moved = false;
        const n = this.hit(e.offsetX, e.offsetY);
        this.downNode = n;
        this.wake();
        if (n) {
          this.dragNode = n;
          n.fx = n.x;
          n.fy = n.y;
          this.alpha = Math.max(this.alpha, 0.3);
        }
      } else if (this.pointers.size === 2) {
        if (this.dragNode) {
          this.dragNode.fx = null;
          this.dragNode.fy = null;
          this.dragNode = null;
        }
        const [a, b] = [...this.pointers.values()];
        this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });

    c.addEventListener("pointermove", (e) => {
      if (!this.pointers.has(e.pointerId)) {
        const was = this.hovered;
        this.hovered = this.hit(e.offsetX, e.offsetY);
        c.style.cursor = this.hovered ? "pointer" : "default";
        if (was !== this.hovered) this.wake();
        return;
      }
      const prev = this.pointers.get(e.pointerId)!;
      const dx = e.offsetX - prev.x;
      const dy = e.offsetY - prev.y;
      this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (Math.hypot(e.offsetX - this.downX, e.offsetY - this.downY) > 5) this.moved = true;
      if (this.pointers.size === 1) {
        if (this.dragNode) {
          this.dragNode.fx! += dx / this.scale;
          this.dragNode.fy! += dy / this.scale;
          this.alpha = Math.max(this.alpha, 0.3);
        } else {
          this.ox += dx;
          this.oy += dy;
        }
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        if (this.pinchDist > 0) this.zoomAt(mx, my, dist / this.pinchDist);
        this.pinchDist = dist;
        this.ox += dx / 2;
        this.oy += dy / 2;
      }
      this.wake();
    });

    const up = (e: PointerEvent, cancelled = false) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      if (this.pointers.size === 0) {
        if (this.dragNode) {
          this.dragNode.fx = null;
          this.dragNode.fy = null;
          this.dragNode = null;
        }
        // a tap opens the node that was under the finger at pointerdown —
        // re-hit-testing here would race the still-moving simulation
        if (!cancelled && !this.moved && performance.now() - this.downAt < 400) {
          const n = this.downNode;
          if (n && !n.missing) this.onOpen(n.id);
        }
        this.downNode = null;
      }
    };
    c.addEventListener("pointerup", (e) => up(e));
    c.addEventListener("pointercancel", (e) => up(e, true));
  }

  get isOpen(): boolean {
    return this.visible;
  }

  show(data: GraphData, currentId: string | null): void {
    this.currentId = currentId;
    this.full = data;
    this.depth = DEFAULT_DEPTH;
    this.byId = new Map(); // positions from a previous scope don't apply
    // Sized and on screen before scoping: fit() measures the canvas, and a
    // hidden canvas measures zero.
    this.container.hidden = false;
    this.visible = true;
    this.resize();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.watchDpr();
    this.applyScope(); // builds, fits, and starts the loop
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.container.hidden = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0; // otherwise wake() thinks the loop is still running
    clearInterval(this.dprTimer);
    this.dprTimer = undefined;
  }

  /** Re-scope around the current note at the current depth and relayout. */
  private applyScope(): void {
    const { data, truncated, reachedAll } = scopeAround(this.full, this.currentId, this.depth);
    this.build(data);
    this.fit();
    this.alpha = 1;
    this.wake();
    const total = this.full.nodes.length;
    const shown = data.nodes.length;
    this.label.textContent =
      shown >= total
        ? `${total} ${total === 1 ? "note" : "notes"}`
        : `${shown} of ${total} notes · ${this.depth} link${this.depth === 1 ? "" : "s"} out`;
    this.widerBtn.disabled = truncated || reachedAll;
    this.narrowerBtn.disabled = this.depth <= 1;
  }

  private widen(): void {
    this.depth++;
    this.applyScope();
  }

  private narrow(): void {
    if (this.depth <= 1) return;
    this.depth--;
    this.applyScope();
  }

  private build(data: GraphData): void {
    const deg = new Map<string, number>();
    for (const e of data.edges) {
      deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
      deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
    }
    const old = this.byId;
    this.byId = new Map();
    this.nodes = data.nodes.map((n, i) => {
      const prev = old.get(n.id);
      const angle = i * 2.399963;
      const r = 22 * Math.sqrt(i);
      const sim: SimNode = {
        id: n.id,
        title: n.title,
        group: n.group,
        missing: n.missing ?? false,
        deg: deg.get(n.id) ?? 0,
        x: prev?.x ?? Math.cos(angle) * r,
        y: prev?.y ?? Math.sin(angle) * r,
        vx: 0,
        vy: 0,
        fx: null,
        fy: null,
      };
      this.byId.set(n.id, sim);
      return sim;
    });
    this.edges = [];
    this.adj = new Map();
    for (const e of data.edges) {
      const s = this.byId.get(e.source);
      const t = this.byId.get(e.target);
      if (!s || !t) continue;
      this.edges.push([s, t]);
      if (!this.adj.has(s.id)) this.adj.set(s.id, new Set());
      if (!this.adj.has(t.id)) this.adj.set(t.id, new Set());
      this.adj.get(s.id)!.add(t.id);
      this.adj.get(t.id)!.add(s.id);
    }
    this.hovered = null;
  }

  private resize(): void {
    const dpr = devicePixelRatio || 1;
    this.lastDpr = dpr;
    this.canvas.width = this.canvas.clientWidth * dpr;
    this.canvas.height = this.canvas.clientHeight * dpr;
  }

  private fit(): void {
    if (this.nodes.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x);
      maxY = Math.max(maxY, n.y);
    }
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const bw = Math.max(maxX - minX, 50);
    const bh = Math.max(maxY - minY, 50);
    this.scale = Math.min(Math.min(w / bw, h / bh) * 0.82, 1.6);
    this.ox = w / 2 - ((minX + maxX) / 2) * this.scale;
    this.oy = h / 2 - ((minY + maxY) / 2) * this.scale;
  }

  private zoomAt(sx: number, sy: number, factor: number): void {
    const ns = Math.min(Math.max(this.scale * factor, 0.05), 8);
    const f = ns / this.scale;
    this.ox = sx - (sx - this.ox) * f;
    this.oy = sy - (sy - this.oy) * f;
    this.scale = ns;
  }

  private radius(n: SimNode): number {
    return (n.missing ? 2.5 : 3.5) + Math.sqrt(n.deg) * 1.6;
  }

  private hit(sx: number, sy: number): SimNode | null {
    const wx = (sx - this.ox) / this.scale;
    const wy = (sy - this.oy) / this.scale;
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      const r = this.radius(n) + 6 / this.scale;
      if ((n.x - wx) ** 2 + (n.y - wy) ** 2 <= r * r) return n;
    }
    return null;
  }

  private step(): void {
    const a = this.alpha;
    // pairwise repulsion, limited to nearby nodes via a spatial grid
    const grid = new Map<string, SimNode[]>();
    for (const n of this.nodes) {
      const k = Math.floor(n.x / CELL) + ":" + Math.floor(n.y / CELL);
      const cell = grid.get(k);
      if (cell) cell.push(n);
      else grid.set(k, [n]);
    }
    for (const n of this.nodes) {
      const cx = Math.floor(n.x / CELL);
      const cy = Math.floor(n.y / CELL);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          for (const m of grid.get(gx + ":" + gy) ?? []) {
            if (m === n) continue;
            let dx = n.x - m.x;
            let dy = n.y - m.y;
            let d2 = dx * dx + dy * dy;
            if (d2 > CELL * CELL) continue;
            if (d2 < 1) {
              dx = n.id < m.id ? 1 : -1;
              dy = 0.5;
              d2 = 1;
            }
            const d = Math.sqrt(d2);
            const f = (2600 / d2) * a;
            n.vx += (dx / d) * f;
            n.vy += (dy / d) * f;
          }
        }
      }
    }
    // springs along edges
    for (const [s, t] of this.edges) {
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const d = Math.max(Math.hypot(dx, dy), 1);
      const f = (d - 80) * 0.04 * a;
      const ux = dx / d;
      const uy = dy / d;
      s.vx += ux * f;
      s.vy += uy * f;
      t.vx -= ux * f;
      t.vy -= uy * f;
    }
    // centering gravity, damping, integration
    for (const n of this.nodes) {
      n.vx -= n.x * 0.012 * a;
      n.vy -= n.y * 0.012 * a;
      n.vx *= 0.85;
      n.vy *= 0.85;
      if (n.fx !== null && n.fy !== null) {
        n.x = n.fx;
        n.y = n.fy;
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      n.x += n.vx;
      n.y += n.vy;
    }
    this.alpha *= 0.994;
  }

  /** Repaint now, and keep painting for a moment (a pan or a hover changes the
   *  picture without the simulation moving). */
  private wake(): void {
    this.idle = 2;
    if (!this.raf && this.visible) this.raf = requestAnimationFrame(this.loop);
  }

  /** Dragging a window to a display of different pixel density changes no CSS
   *  size, so it fires no resize event — the loop used to catch it by polling
   *  every frame, which parking removed. A one-second check while the graph is
   *  open costs nothing next to the 60 fps redraw it replaced. */
  private watchDpr(): void {
    clearInterval(this.dprTimer);
    this.dprTimer = setInterval(() => {
      if (!this.visible) return;
      if ((devicePixelRatio || 1) !== this.lastDpr) {
        this.resize();
        this.wake();
      }
    }, 1000);
  }

  private loop = (): void => {
    if (!this.visible) {
      this.raf = 0;
      return;
    }
    if ((devicePixelRatio || 1) !== this.lastDpr) this.resize(); // window moved between screens
    const settling = this.alpha > 0.005;
    if (settling) this.step();
    if (!settling && this.idle <= 0) {
      // Nothing is moving and nothing has been touched: stop. The loop used to
      // run forever, repainting an identical picture on a phone's battery.
      this.raf = 0;
      return;
    }
    this.draw();
    if (!settling) this.idle--;
    this.raf = requestAnimationFrame(this.loop);
  };

  private color(n: SimNode, dark: boolean): string {
    if (n.missing) return dark ? "#55555f" : "#c0c0c8";
    if (n.group === "") return dark ? "hsl(240 12% 68%)" : "hsl(240 10% 55%)";
    return `hsl(${hue(n.group)} 60% ${dark ? 63 : 47}%)`;
  }

  private draw(): void {
    const { ctx, canvas } = this;
    const dpr = devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const dark = this.dark.matches;
    const s = this.scale;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * this.ox, dpr * this.oy);

    const hl = this.hovered;
    const hlAdj = hl ? this.adj.get(hl.id) ?? new Set<string>() : null;

    ctx.strokeStyle = dark ? "#8888a0" : "#666680";
    ctx.lineWidth = 1 / s;
    // One batched path per opacity instead of a beginPath+stroke per edge.
    // Per-edge stroking was ~50,000 draw calls a frame on a large vault; the
    // scope cap keeps that far smaller now, but batching is free.
    const strokeBatch = (alpha: number, pick: (from: SimNode, to: SimNode) => boolean): void => {
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      for (const [from, to] of this.edges) {
        if (!pick(from, to)) continue;
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
      }
      ctx.stroke();
    };
    if (hl) {
      strokeBatch(0.05, (from, to) => from !== hl && to !== hl);
      strokeBatch(0.55, (from, to) => from === hl || to === hl);
    } else {
      strokeBatch(0.16, () => true);
    }

    for (const n of this.nodes) {
      const r = this.radius(n);
      ctx.globalAlpha = hl && n !== hl && !hlAdj!.has(n.id) ? 0.25 : 1;
      ctx.fillStyle = this.color(n, dark);
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();
      if (n.id === this.currentId || n === hl) {
        ctx.strokeStyle = dark ? "#818cf8" : "#6366f1";
        ctx.lineWidth = 2 / s;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 2 / s, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // labels in screen space so they stay a constant, readable size
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center";
    for (const n of this.nodes) {
      const r = this.radius(n);
      const show = n === hl || n.id === this.currentId || (hlAdj?.has(n.id) ?? false) || s * (r + 4) >= 7;
      if (!show) continue;
      const sx = n.x * s + this.ox;
      const sy = n.y * s + this.oy + r * s + 12;
      if (sx < -80 || sx > w + 80 || sy < -20 || sy > h + 20) continue;
      ctx.globalAlpha = hl && n !== hl && !hlAdj!.has(n.id) ? 0.3 : 1;
      ctx.lineWidth = 3;
      ctx.strokeStyle = dark ? "#15151a" : "#ffffff";
      ctx.strokeText(n.title, sx, sy);
      ctx.fillStyle = dark ? "#b9b9c6" : "#52525c";
      ctx.fillText(n.title, sx, sy);
    }
    ctx.globalAlpha = 1;
  }
}

// A VS Code-style minimap down the right edge: the whole note as a thumbnail
// with the viewport drawn over it, clickable and draggable. Desktop only — CSS
// hides it on windows too narrow to keep it clear of the text column, and every
// method no-ops while it's hidden, so nothing is measured for a phone.
//
// The thumbnail is measured, not approximated: each rendered line box comes
// from a Range over a block's contents, so the map's shape really is the note's
// shape — wrapping, headings, code, images and all. Measuring is the expensive
// half, so it happens only when the note's DOM or size actually changes (the
// observers below do the noticing) and lands in an offscreen layer that
// scrolling merely re-blits.

/** Tallest a line may be drawn, as a fraction of its real height. Sets the map's
 *  line pitch the way VS Code's fixed minimap font does: a short note gets a
 *  readable map instead of a postage stamp squeezed into the top of the strip. */
const MAX_SCALE = 0.25;

interface Shape {
  /** document coordinates */
  x: number;
  y: number;
  w: number;
  h: number;
  /** headings, drawn darker — they're the landmarks you navigate by */
  strong: boolean;
}

export class MiniMap {
  private canvas: HTMLCanvasElement;
  private layer = document.createElement("canvas");
  /** document y of the note's first line */
  private top = 0;
  /** document px → map px; 0 means there's nothing to show */
  private scale = 0;
  private dpr = 1;
  /** grab offset inside the viewport box while dragging, in map px */
  private drag: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private frame = 0;

  constructor(
    /** the fixed strip; its canvas child fills it */
    private root: HTMLElement,
    private content: HTMLElement,
  ) {
    const canvas = root.querySelector("canvas")!;
    this.canvas = canvas;
    // Re-measure on anything that moves the note's geometry: a block editor
    // opening, a textarea growing under the caret, a render, a window resize.
    // Coalesced, because a render fires a burst of these at once.
    const schedule = (): void => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.update(), 60);
    };
    new ResizeObserver(schedule).observe(content);
    new MutationObserver(schedule).observe(content, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    // scrolling only moves the box — no re-measure, one paint per frame
    window.addEventListener("scroll", () => this.schedulePaint(), { passive: true });
    canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    canvas.addEventListener("pointermove", (e) => this.onMove(e));
    const release = (e: PointerEvent): void => {
      this.drag = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
  }

  /** Source mode has no rendered blocks to map, so the map steps aside. */
  setVisible(on: boolean): void {
    this.root.hidden = !on;
    if (on) this.update();
  }

  /** Re-measure the note and repaint. Cheap to call — it bails when hidden. */
  update(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) {
      this.scale = 0; // hidden by [hidden] or by the narrow-window media query
      return;
    }
    const shapes = this.measure();
    const box = this.content.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    for (const c of [this.layer, this.canvas]) {
      c.width = Math.round(w * this.dpr);
      c.height = Math.round(h * this.dpr);
    }
    const ctx = this.layer.getContext("2d")!;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (shapes.length === 0 || box.width === 0) {
      this.scale = 0;
      this.paint();
      return;
    }
    let top = Infinity;
    let bottom = 0;
    for (const s of shapes) {
      if (s.y < top) top = s.y;
      if (s.y + s.h > bottom) bottom = s.y + s.h;
    }
    this.top = top;
    const left = box.left + window.scrollX;
    // Line widths stay proportional (that's what makes the map read as text);
    // the vertical scale is a fixed pitch until the note grows past the strip,
    // then compresses to fit — the whole note is always on the map, which is
    // the point of a viewfinder.
    const kx = w / box.width;
    this.scale = Math.min(MAX_SCALE, h / Math.max(1, bottom - top));
    const css = getComputedStyle(document.documentElement);
    const muted = css.getPropertyValue("--muted").trim() || "#888";
    const fg = css.getPropertyValue("--fg").trim() || "#000";
    for (const s of shapes) {
      ctx.fillStyle = s.strong ? fg : muted;
      ctx.globalAlpha = s.strong ? 0.7 : 0.4;
      ctx.fillRect(
        (s.x - left) * kx,
        (s.y - top) * this.scale,
        Math.max(1, s.w * kx),
        // lines keep a gap between them however hard the map is compressed
        Math.max(1, s.h * this.scale * 0.62),
      );
    }
    this.paint();
  }

  /** Every rendered line box in the note, in document coordinates. */
  private measure(): Shape[] {
    const out: Shape[] = [];
    const ox = window.scrollX;
    const oy = window.scrollY;
    const range = document.createRange();
    for (const el of this.content.querySelectorAll<HTMLElement>("[data-start], .block-edit")) {
      // the open editor is a box, not lines — draw it as one solid mark so the
      // block you're working on doesn't leave a hole in the map
      if (el.classList.contains("block-edit")) {
        const r = el.getBoundingClientRect();
        out.push({ x: r.left + ox, y: r.top + oy, w: r.width, h: r.height, strong: false });
        continue;
      }
      const strong = /^H[1-3]$/.test(el.tagName);
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 0);
      const boxes = rects.length > 0 ? rects : [el.getBoundingClientRect()];
      for (const r of boxes) {
        out.push({ x: r.left + ox, y: r.top + oy, w: r.width, h: r.height, strong });
      }
    }
    return out;
  }

  private schedulePaint(): void {
    if (this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  private paint(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const ctx = this.canvas.getContext("2d")!;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = 1;
    ctx.drawImage(this.layer, 0, 0, w, h);
    if (this.scale === 0) return;
    const y = Math.max(0, Math.min(h - 4, (window.scrollY - this.top) * this.scale));
    const bh = Math.max(6, Math.min(h - y, window.innerHeight * this.scale));
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#666";
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.12;
    ctx.fillRect(0, y, w, bh);
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, y + 0.5, w - 1, bh - 1);
    ctx.globalAlpha = 1;
  }

  /** Map y (in map px) → the scroll position that puts the box there. */
  private scrollTo(mapY: number): void {
    window.scrollTo(0, this.top + (mapY - (this.drag ?? 0)) / this.scale);
  }

  private onDown(e: PointerEvent): void {
    if (this.scale === 0) return;
    const y = e.clientY - this.canvas.getBoundingClientRect().top;
    const boxY = (window.scrollY - this.top) * this.scale;
    const boxH = window.innerHeight * this.scale;
    // grabbing the box keeps its offset (it doesn't jump under the cursor);
    // clicking anywhere else centres it where you clicked, then drags
    this.drag = y >= boxY && y <= boxY + boxH ? y - boxY : boxH / 2;
    this.canvas.setPointerCapture(e.pointerId);
    this.scrollTo(y);
  }

  private onMove(e: PointerEvent): void {
    if (this.drag === null || this.scale === 0) return;
    e.preventDefault();
    this.scrollTo(e.clientY - this.canvas.getBoundingClientRect().top);
  }
}

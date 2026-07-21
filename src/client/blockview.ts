// Notion-style in-place block editing over the rendered note.
//
// The rendered view IS the editor: every paragraph, heading, and top-level
// list item is a DOM element tagged with its exact source line range
// (data-start/data-end). Tapping a block swaps it for a small textarea holding
// those raw markdown lines; committing splices them back. Enter in a list item
// creates the next item; Enter in a paragraph starts a new block; a toolbar on
// the active block retypes it (¶/H1-H3/•/☑/❝). The file is never rewritten
// wholesale — every edit is a line splice on what was typed.
import { marked } from "marked";
import { convertBlock, nextItemPrefix, segmentBlocks, stripBlockPrefixes, type Block, type TargetType } from "../blocks";
import { normalizeTasks, taskLinesIn, toggleTaskAtLine } from "../links";

export interface BlockHost {
  content(): string;
  /** Set new content: the host marks the note dirty and schedules a save. */
  update(next: string): void;
  wikiExists(name: string): boolean;
  followWiki(name: string): void;
  openRelative(href: string): void;
  openExternal(url: string): void;
  /** Mapped URL for a relative image src, or null to leave it untouched. */
  imageSrc(src: string): string | null;
}

interface ActiveEdit {
  start: number;
  end: number;
  original: string;
  wrap: HTMLElement;
  textarea: HTMLTextAreaElement;
  /** Appending after the current end of the note (no lines replaced). */
  append?: boolean;
}

interface RenderGroup {
  start: number;
  end: number;
  items?: Block[];
}

const TOOLS: { t: TargetType | "delete"; label: string; title: string }[] = [
  { t: "p", label: "¶", title: "Paragraph" },
  { t: "h1", label: "H1", title: "Heading 1" },
  { t: "h2", label: "H2", title: "Heading 2" },
  { t: "h3", label: "H3", title: "Heading 3" },
  { t: "bullet", label: "•", title: "Bullet list" },
  { t: "task", label: "☑", title: "To-do" },
  { t: "quote", label: "❝", title: "Quote" },
  { t: "delete", label: "✕", title: "Delete block" },
];

export class BlockView {
  private active: ActiveEdit | null = null;
  /** A commit happened without re-render (mid tap-through to another block). */
  private staleDom = false;
  private lineDelta = 0;
  private commitEnd = -1;

  constructor(
    private container: HTMLElement,
    private host: BlockHost,
  ) {
    container.addEventListener("click", (e) => this.onClick(e));
  }

  hasActiveEdit(): boolean {
    return this.active !== null;
  }

  /* ---------- rendering ---------- */

  render(): void {
    this.active = null;
    this.staleDom = false;
    const src = this.host.content();
    const lines = src.split("\n");
    const blocks = segmentBlocks(src);
    const frag = document.createDocumentFragment();
    for (const g of this.groupForRender(blocks)) frag.appendChild(this.renderGroup(g, lines));
    this.container.replaceChildren(frag);
    if (this.container.childElementCount === 0) {
      const ph = document.createElement("p");
      ph.className = "block-placeholder";
      ph.textContent = "Tap to start writing…";
      ph.dataset.start = "0";
      ph.dataset.end = String(lines.length - 1);
      this.container.appendChild(ph);
    }
    this.postprocess(src);
  }

  /** Consecutive items (allowing loose-list gaps) render as one <ul>/<ol>. */
  private groupForRender(blocks: Block[]): RenderGroup[] {
    const out: RenderGroup[] = [];
    let i = 0;
    while (i < blocks.length) {
      const b = blocks[i];
      if (b.type === "blank") {
        i++;
        continue;
      }
      if (b.type !== "item") {
        out.push({ start: b.start, end: b.end });
        i++;
        continue;
      }
      const items: Block[] = [b];
      let end = b.end;
      let j = i + 1;
      while (j < blocks.length) {
        const nb = blocks[j];
        if (nb.type === "item" && nb.ordered === b.ordered) {
          items.push(nb);
          end = nb.end;
          j++;
        } else if (nb.type === "blank" && blocks[j + 1]?.type === "item" && blocks[j + 1].ordered === b.ordered) {
          j++;
        } else {
          break;
        }
      }
      out.push({ start: b.start, end, items });
      i = j;
    }
    return out;
  }

  private renderGroup(g: RenderGroup, lines: string[]): HTMLElement {
    const text = lines.slice(g.start, g.end + 1).join("\n");
    const tmp = document.createElement("div");
    tmp.innerHTML = marked.parse(normalizeTasks(text)) as string;
    if (g.items) {
      const root = tmp.firstElementChild as HTMLElement | null;
      const lis = root ? [...root.children].filter((c): c is HTMLElement => c.tagName === "LI") : [];
      if (
        root !== null &&
        (root.tagName === "UL" || root.tagName === "OL") &&
        tmp.childElementCount === 1 &&
        lis.length === g.items.length
      ) {
        lis.forEach((li, k) => {
          li.dataset.start = String(g.items![k].start);
          li.dataset.end = String(g.items![k].end);
        });
        return root;
      }
      // marked disagreed with our segmentation — degrade to one coarse block
      // rather than risk mapping an edit onto the wrong lines
    }
    let el: HTMLElement;
    if (tmp.childElementCount === 1) {
      el = tmp.firstElementChild as HTMLElement;
    } else {
      el = document.createElement("div");
      el.append(...tmp.childNodes);
    }
    el.dataset.start = String(g.start);
    el.dataset.end = String(g.end);
    return el;
  }

  private postprocess(src: string): void {
    const c = this.container;
    c.querySelectorAll<HTMLAnchorElement>("a.wiki").forEach((a) => {
      const name = a.dataset.name ?? "";
      if (!this.host.wikiExists(name)) a.classList.add("missing");
      a.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.consumeStale()) return;
        this.host.followWiki(name);
      });
    });
    c.querySelectorAll<HTMLAnchorElement>("a:not(.wiki)").forEach((a) => {
      const href = a.getAttribute("href") ?? "";
      a.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.consumeStale()) return;
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) this.host.openExternal(href);
        else if (/\.md$/i.test(href)) this.host.openRelative(href);
      });
    });
    c.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
      const mapped = this.host.imageSrc(img.getAttribute("src") ?? "");
      if (mapped) img.src = mapped;
    });
    // checkboxes: block-scoped mapping, only wired when DOM and source agree
    c.querySelectorAll<HTMLElement>("[data-start]").forEach((el) => {
      const boxes = [...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
      if (boxes.length === 0) return;
      const taskLines = taskLinesIn(src, Number(el.dataset.start), Number(el.dataset.end));
      if (taskLines.length !== boxes.length) return; // unsafe mapping → read-only
      boxes.forEach((box, k) => {
        box.disabled = false;
        box.addEventListener("click", (e) => e.stopPropagation());
        box.addEventListener("change", () => {
          if (this.consumeStale()) return;
          const next = toggleTaskAtLine(this.host.content(), taskLines[k]);
          if (next !== null) this.host.update(next);
          this.rerenderKeepScroll();
        });
      });
    });
  }

  private rerenderKeepScroll(): void {
    const y = window.scrollY;
    this.render();
    window.scrollTo(0, y);
  }

  /** If the DOM is stale from a render-less commit, re-render and report it. */
  private consumeStale(): boolean {
    if (!this.staleDom) return false;
    this.rerenderKeepScroll();
    return true;
  }

  /* ---------- editing ---------- */

  private onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    if (t.closest("a, input, button, textarea, .block-toolbar")) return;
    const el = t.closest<HTMLElement>("[data-start]");
    if (!el || !this.container.contains(el)) {
      if (t === this.container) {
        if (this.active) this.commit();
        else if (!this.consumeStale()) this.appendAtEnd();
      }
      return;
    }
    if (this.active && this.active.wrap.contains(el)) return;
    let start = Number(el.dataset.start);
    let end = Number(el.dataset.end);
    if (this.active) this.commit(false); // blur usually did this already
    if (this.staleDom && start > this.commitEnd) {
      start += this.lineDelta;
      end += this.lineDelta;
    }
    const caret = this.caretFromPoint(el, e.clientX, e.clientY, start, end);
    this.openRange(start, end, caret);
  }

  /** Open an editor over the given line range. */
  openRange(start: number, end: number, caret: number): void {
    this.render(); // clean DOM from current content; clears active/stale state
    const lines = this.host.content().split("\n");
    const cStart = Math.max(0, Math.min(start, lines.length - 1));
    const cEnd = Math.max(cStart, Math.min(end, lines.length - 1));
    const text = lines.slice(cStart, cEnd + 1).join("\n");
    const wrap = this.buildEditor(text);
    const el = this.container.querySelector<HTMLElement>(`[data-start="${cStart}"]`);
    if (el) el.replaceWith(wrap);
    else this.container.appendChild(wrap);
    this.activate(wrap, { start: cStart, end: cEnd, original: text }, caret);
  }

  /** Open the first block — used for brand-new empty notes. */
  openFirst(): void {
    const lines = this.host.content().split("\n");
    this.openRange(0, lines.length - 1, 0);
  }

  /** Click below the content: append a fresh paragraph at the end. */
  private appendAtEnd(): void {
    const src = this.host.content();
    if (src.trim() === "") {
      this.openFirst();
      return;
    }
    this.render();
    const wrap = this.buildEditor("");
    this.container.appendChild(wrap);
    this.activate(wrap, { start: -1, end: -1, original: "", append: true }, 0);
  }

  private activate(wrap: HTMLElement, edit: Omit<ActiveEdit, "wrap" | "textarea">, caret: number): void {
    const textarea = wrap.querySelector("textarea")!;
    this.active = { ...edit, wrap, textarea };
    this.sizeTextarea(textarea);
    textarea.focus();
    const pos = Math.max(0, Math.min(caret, textarea.value.length));
    textarea.setSelectionRange(pos, pos);
  }

  private buildEditor(text: string): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "block-edit";
    const bar = document.createElement("div");
    bar.className = "block-toolbar";
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.spellcheck = false;
    for (const tool of TOOLS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = tool.label;
      btn.title = tool.title;
      // preventDefault on pointerdown keeps focus (and the keyboard, on
      // phones) in the textarea; click still fires
      btn.addEventListener("pointerdown", (e) => e.preventDefault());
      btn.addEventListener("click", () => {
        if (tool.t === "delete") {
          this.deleteActive();
          return;
        }
        textarea.value = convertBlock(textarea.value, tool.t);
        this.sizeTextarea(textarea);
        textarea.focus();
        const firstLineEnd = textarea.value.includes("\n") ? textarea.value.indexOf("\n") : textarea.value.length;
        textarea.setSelectionRange(firstLineEnd, firstLineEnd);
      });
      bar.appendChild(btn);
    }
    textarea.addEventListener("input", () => this.sizeTextarea(textarea));
    textarea.addEventListener("keydown", (e) => this.onEditorKey(e, textarea));
    textarea.addEventListener("blur", () => {
      this.commit(false);
      // if no follow-up tap claims the stale DOM shortly, settle it
      setTimeout(() => {
        if (this.staleDom && !this.active) this.rerenderKeepScroll();
      }, 250);
    });
    wrap.append(bar, textarea);
    return wrap;
  }

  private onEditorKey(e: KeyboardEvent, textarea: HTMLTextAreaElement): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.commit();
      return;
    }
    if (e.key === "Backspace" && textarea.value === "") {
      e.preventDefault();
      this.deleteActive();
      return;
    }
    if (e.key !== "Enter" || e.shiftKey) return;

    const value = textarea.value;
    const blk = segmentBlocks(value).find((b) => b.type !== "blank");
    const pos = textarea.selectionStart;

    if (blk?.type === "item") {
      const firstLineEnd = value.includes("\n") ? value.indexOf("\n") : value.length;
      if (pos > firstLineEnd) return; // literal newline inside nested content
      e.preventDefault();
      if (stripBlockPrefixes(value).trim() === "") {
        // Enter on an empty item ends the list with a fresh paragraph
        this.replaceActive(["", ""], 1, 0);
        return;
      }
      const before = value.slice(0, pos);
      const tail = value.slice(pos, firstLineEnd);
      const rest = value.slice(firstLineEnd);
      const prefix = nextItemPrefix(blk);
      const keepLines = (before + rest).split("\n");
      this.replaceActive([...keepLines, prefix + tail], keepLines.length, prefix.length);
      return;
    }

    // paragraph / heading / quote: split into two blocks
    e.preventDefault();
    const before = value.slice(0, pos).split("\n");
    const after = value.slice(pos).split("\n");
    this.replaceActive([...before, "", ...after], before.length + 1, 0);
  }

  /**
   * Replace the active block's lines with newLines, then open an editor on
   * the line at (old start + offsetIntoNew) with the caret at caretPos.
   */
  private replaceActive(newLines: string[], offsetIntoNew: number, caretPos: number): void {
    const a = this.active;
    if (!a) return;
    this.active = null;
    const lines = this.host.content().split("\n");
    if (a.append) lines.push("", ...newLines);
    else lines.splice(a.start, a.end - a.start + 1, ...newLines);
    this.host.update(lines.join("\n"));
    const base = a.append ? lines.length - newLines.length : a.start;
    const target = base + offsetIntoNew;
    this.openRange(target, target, caretPos);
  }

  /** Commit the active edit into the note. Returns true if content changed. */
  commit(renderAfter = true): boolean {
    const a = this.active;
    if (!a) {
      if (renderAfter && this.staleDom) this.rerenderKeepScroll();
      return false;
    }
    this.active = null;
    const value = a.textarea.value;
    const changed = value !== a.original;
    if (changed || a.append) {
      const lines = this.host.content().split("\n");
      const newLines = value.split("\n");
      if (a.append) {
        if (value.trim() !== "") {
          lines.push("", ...newLines);
          this.host.update(lines.join("\n"));
        }
        this.lineDelta = 0;
        this.commitEnd = Number.MAX_SAFE_INTEGER;
      } else {
        lines.splice(a.start, a.end - a.start + 1, ...newLines);
        this.host.update(lines.join("\n"));
        this.lineDelta = newLines.length - (a.end - a.start + 1);
        this.commitEnd = a.end;
      }
    } else {
      this.lineDelta = 0;
      this.commitEnd = Number.MAX_SAFE_INTEGER;
    }
    if (renderAfter) this.rerenderKeepScroll();
    else this.staleDom = true;
    return changed;
  }

  private deleteActive(): void {
    const a = this.active;
    if (!a) return;
    this.active = null;
    if (a.append) {
      this.rerenderKeepScroll();
      return;
    }
    const lines = this.host.content().split("\n");
    let start = a.start;
    let count = a.end - a.start + 1;
    // swallow one adjacent blank so blanks don't pile up
    if (start + count < lines.length && lines[start + count].trim() === "") count++;
    else if (start > 0 && lines[start - 1].trim() === "") {
      start--;
      count++;
    }
    lines.splice(start, count);
    this.host.update(lines.join("\n"));
    this.rerenderKeepScroll();
  }

  private sizeTextarea(t: HTMLTextAreaElement): void {
    const y = window.scrollY;
    t.style.height = "auto";
    t.style.height = t.scrollHeight + "px";
    window.scrollTo(0, y);
  }

  /**
   * Best-effort mapping of a click position in the rendered block to an
   * offset in its markdown source: take the rendered text before the caret
   * and find its tail in the source. Falls back to the end.
   */
  private caretFromPoint(el: HTMLElement, x: number, y: number, start: number, end: number): number {
    const lines = this.host.content().split("\n");
    const text = lines.slice(start, Math.min(end, lines.length - 1) + 1).join("\n");
    const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
    const range = doc.caretRangeFromPoint?.(x, y);
    if (!range || !el.contains(range.startContainer)) return text.length;
    const r2 = document.createRange();
    r2.selectNodeContents(el);
    try {
      r2.setEnd(range.startContainer, range.startOffset);
    } catch {
      return text.length;
    }
    const tail = r2.toString().slice(-24).trim().slice(-16);
    if (!tail) return 0;
    const idx = text.indexOf(tail);
    return idx >= 0 ? idx + tail.length : text.length;
  }
}

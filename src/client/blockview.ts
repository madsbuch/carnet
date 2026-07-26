// Notion-style in-place block editing over the rendered note.
//
// The rendered view IS the editor: every paragraph, heading, and top-level
// list item is a DOM element tagged with its exact source line range
// (data-start/data-end). Tapping a block swaps it for a small textarea holding
// those raw markdown lines; committing splices them back. Enter in a list item
// creates the next item; Enter in a paragraph starts a new block; a toolbar on
// the active block retypes it (¶/H1-H3/•/☑/❝), inserts a wiki link or a
// separator, or deletes it. The file is never rewritten
// wholesale — every edit is a line splice on what was typed.
//
// State invariants:
// - `active` is the one live edit session. commit(false) flushes its text but
//   keeps the session alive while the textarea still has focus (Cmd+S,
//   app-switch); it only closes on blur/navigation (forceClose) or render.
// - Typing flushes on its own, on a short debounce (LIVE_COMMIT_MS). Without
//   that, text typed into a block lived only in the textarea until something
//   ended the session, so a crash or an OS kill — the normal way an Android app
//   dies — took everything written since the block was opened.
// - `staleDom` means the DOM no longer matches the content (a flush happened
//   without a re-render, mid tap-through); `staleShifted` additionally means
//   line numbers moved, so handlers holding line coordinates must drop their
//   action instead of acting on stale positions.
import { marked } from "marked";
import {
  convertBlock,
  insertSeparator,
  itemContentStart,
  nextItemPrefix,
  segmentBlocks,
  stripBlockPrefixes,
  type Block,
  type TargetType,
} from "../blocks";
import { countLabel } from "../counts";
import { normalizeTasks, taskLines, taskLinesInRange, taskState, toggleTaskAtLine } from "../links";
import { insertWikiLink } from "./linkcomplete";

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
  /** The block's end line as the rendered DOM knows it (for stale adjustments). */
  domEnd: number;
  original: string;
  wrap: HTMLElement;
  textarea: HTMLTextAreaElement;
  /** Appending after the current end of the note (no lines replaced yet). */
  append?: boolean;
  /** This session started as an append and has since written its lines. Emptying
   *  it again has to take those lines back out, rather than splice a blank in
   *  where the user never wrote one. */
  wasAppend?: boolean;
}

interface RenderGroup {
  start: number;
  end: number;
  items?: Block[];
}

const TOOLS: { t: TargetType | "delete" | "link" | "hrule"; label: string; title: string }[] = [
  { t: "p", label: "¶", title: "Paragraph" },
  { t: "h1", label: "H1", title: "Heading 1" },
  { t: "h2", label: "H2", title: "Heading 2" },
  { t: "h3", label: "H3", title: "Heading 3" },
  { t: "bullet", label: "•", title: "Bullet list" },
  { t: "task", label: "☑", title: "To-do" },
  { t: "quote", label: "❝", title: "Quote" },
  { t: "link", label: "[…]", title: "Link to a note" },
  { t: "hrule", label: "―", title: "Separator" },
  { t: "delete", label: "✕", title: "Delete block" },
];

/** How long typing may sit only in the textarea before it reaches the note.
 *  Short enough that a crash costs a few words, long enough not to splice the
 *  file on every keystroke. */
const LIVE_COMMIT_MS = 400;

export class BlockView {
  private active: ActiveEdit | null = null;
  private staleDom = false;
  private staleShifted = false;
  private lineDelta = 0;
  private commitEnd = -1;
  private liveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private container: HTMLElement,
    private host: BlockHost,
  ) {
    container.addEventListener("click", (e) => this.onClick(e));
  }

  hasActiveEdit(): boolean {
    return this.active !== null;
  }

  /**
   * The note as it would read if the active edit committed right now — plain
   * file content when nothing is being edited. Lets whole-file views (the note
   * counter) follow typing without a commit per keystroke. Mirrors the splice
   * commit() performs, so the two can never disagree.
   */
  pendingContent(): string {
    const a = this.active;
    const content = this.host.content();
    if (!a) return content;
    const lines = content.split("\n");
    if (a.append) {
      if (a.textarea.value.trim() === "") return content;
      lines.push("", ...a.textarea.value.split("\n"));
    } else {
      lines.splice(a.start, a.end - a.start + 1, ...a.textarea.value.split("\n"));
    }
    return lines.join("\n");
  }

  /** Flush and close any edit session without re-rendering (navigation). */
  flush(): boolean {
    return this.commit(false, true);
  }

  /**
   * Push what's in the textarea into the note shortly after typing stops,
   * without closing the session or re-rendering — the same flush Cmd+S does.
   * The host then marks the note dirty and schedules its own save, so nothing
   * ever sits unsaved for longer than this debounce plus the host's.
   */
  private scheduleLiveCommit(): void {
    clearTimeout(this.liveTimer);
    this.liveTimer = setTimeout(() => {
      const a = this.active;
      // Only while the textarea still holds focus: commit(false) ends a session
      // whose textarea has lost it, and an orphaned editor swallows keystrokes.
      // If focus did move, blur has already flushed this text anyway.
      if (a && a.textarea.isConnected && document.activeElement === a.textarea) {
        this.commit(false);
      }
    }, LIVE_COMMIT_MS);
  }

  private cancelLiveCommit(): void {
    clearTimeout(this.liveTimer);
    this.liveTimer = undefined;
  }

  /* ---------- rendering ---------- */

  render(): void {
    this.cancelLiveCommit(); // the session it would have flushed is going away
    this.active = null;
    this.staleDom = false;
    this.staleShifted = false;
    // These measure the drift between the content and the DOM. A fresh render
    // *is* the content, so any earlier drift is gone — leaving them set let a
    // stale offset be applied to correct coordinates, opening an editor a line
    // off and merging two paragraphs into one.
    this.lineDelta = 0;
    this.commitEnd = -1;
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
    const srcLines = src.split("\n");
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
    // checkboxes: block-scoped mapping, only wired when the DOM and the source
    // agree on both the count AND every box's checked state.
    // The task-line map is computed once for the note; doing it per block meant
    // re-splitting and re-fence-masking the whole note for every checkbox block,
    // which is quadratic — 10 s on a phone for a 4,000-item checklist.
    const allTaskLines = taskLines(src);
    c.querySelectorAll<HTMLElement>("[data-start]").forEach((el) => {
      const boxes = [...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
      if (boxes.length === 0) return;
      const blockTasks = taskLinesInRange(allTaskLines, Number(el.dataset.start), Number(el.dataset.end));
      if (blockTasks.length !== boxes.length) return;
      const agree = boxes.every((box, k) => taskState(srcLines[blockTasks[k]]) === box.checked);
      if (!agree) return; // unsafe mapping → read-only
      boxes.forEach((box, k) => {
        box.disabled = false;
        box.addEventListener("click", (e) => e.stopPropagation());
        box.addEventListener("change", () => {
          if (this.consumeStale()) return;
          const next = toggleTaskAtLine(this.host.content(), blockTasks[k]);
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

  /**
   * Settle a stale DOM before acting on it. Returns true when the pending
   * action must be dropped because its captured line numbers moved.
   */
  private consumeStale(): boolean {
    if (!this.staleDom) return false;
    const shifted = this.staleShifted;
    if (this.active) this.commit(); // flush + render, never lose typed text
    else this.rerenderKeepScroll();
    return shifted;
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
    if (this.active) this.commit(false, true); // blur usually closed it already
    if (this.staleDom && start > this.commitEnd) {
      start += this.lineDelta;
      end += this.lineDelta;
    }
    const caret = this.caretFromPoint(el, e.clientX, e.clientY, start, end);
    this.openRange(start, end, caret);
  }

  /**
   * Open an editor over the given line range. The range snaps outward to the
   * whole block containing its first line, so editors always cover complete
   * blocks — nothing gets hidden or half-replaced while editing.
   */
  openRange(start: number, end: number, caret: number): void {
    this.render(); // clean DOM from current content; clears active/stale state
    const content = this.host.content();
    const lines = content.split("\n");
    let cStart = Math.max(0, Math.min(start, lines.length - 1));
    let cEnd = Math.max(cStart, Math.min(end, lines.length - 1));
    const hit = segmentBlocks(content).find((b) => b.type !== "blank" && b.start <= cStart && cStart <= b.end);
    if (hit) {
      cStart = hit.start;
      cEnd = Math.max(cEnd, hit.end);
    }
    const text = lines.slice(cStart, cEnd + 1).join("\n");
    const wrap = this.buildEditor(text);
    const exact = this.container.querySelector<HTMLElement>(`[data-start="${cStart}"]`);
    if (exact) {
      exact.replaceWith(wrap);
    } else {
      // no element renders this line (blank or brand-new): insert the editor
      // at its position in document order, not at the bottom of the note
      const following = [...this.container.querySelectorAll<HTMLElement>("[data-start]")].find(
        (other) => Number(other.dataset.start) > cStart,
      );
      let anchor: HTMLElement | null = following ?? null;
      while (anchor && anchor.parentElement !== this.container) {
        anchor = anchor.parentElement as HTMLElement | null;
      }
      if (anchor) this.container.insertBefore(wrap, anchor);
      else this.container.appendChild(wrap);
    }
    this.activate(wrap, { start: cStart, end: cEnd, domEnd: cEnd, original: text }, caret);
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
    this.activate(
      wrap,
      { start: -1, end: -1, domEnd: Number.MAX_SAFE_INTEGER, original: "", append: true },
      0,
    );
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
    // this block's own counter, under its editor — every mutation below reaches
    // it through the textarea's input listener, whether typed or from a button
    const counter = document.createElement("div");
    counter.className = "block-count";
    // Trails typing rather than tracking it: counting is a whole-text regex
    // walk, and a block can be as long as the note.
    let counterTimer: ReturnType<typeof setTimeout> | undefined;
    const syncCounter = (): void => {
      clearTimeout(counterTimer);
      counterTimer = setTimeout(() => {
        counter.textContent = countLabel(textarea.value);
      }, 200);
    };
    counter.textContent = countLabel(text);
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
        if (tool.t === "link") {
          insertWikiLink(textarea);
          return;
        }
        if (tool.t === "hrule") {
          // split at the caret, lay a separator between the halves, and
          // continue writing in the block below it
          const { lines, caret } = insertSeparator(textarea.value, textarea.selectionStart);
          this.replaceActive(lines, caret, 0);
          return;
        }
        textarea.value = convertBlock(textarea.value, tool.t);
        // Assigning .value fires no input event, so this has to say so itself:
        // otherwise retyping a block and putting the phone down left the change
        // in a detached textarea, unsaved and undirty, for an OS kill to take.
        // The one listener does the resize, the recount, the live flush, and
        // lets app.ts see it — the same route insertWikiLink takes.
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.focus();
        const firstLineEnd = textarea.value.includes("\n") ? textarea.value.indexOf("\n") : textarea.value.length;
        textarea.setSelectionRange(firstLineEnd, firstLineEnd);
      });
      bar.appendChild(btn);
    }
    textarea.addEventListener("input", () => {
      this.sizeTextarea(textarea);
      syncCounter();
      this.scheduleLiveCommit();
    });
    textarea.addEventListener("keydown", (e) => this.onEditorKey(e, textarea));
    textarea.addEventListener("blur", () => {
      this.commit(false, true);
      // if no follow-up tap claims the stale DOM shortly, settle it
      setTimeout(() => {
        if (this.staleDom && !this.active) this.rerenderKeepScroll();
      }, 250);
    });
    wrap.append(bar, textarea, counter);
    return wrap;
  }

  private onEditorKey(e: KeyboardEvent, textarea: HTMLTextAreaElement): void {
    if (e.isComposing) return; // never act on IME composition keys
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
    // Enter in an empty append editor must not spray blanks — including one that
    // has already written and then had its text cleared again.
    if ((this.active?.append || this.active?.wasAppend) && value.trim() === "") {
      e.preventDefault();
      return;
    }
    const blk = segmentBlocks(value).find((b) => b.type !== "blank");
    if (blk?.type === "code") return; // Enter inside a fence is a literal newline
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
      // never split inside the marker itself — clamp to where the text starts
      const contentStart = Math.min(itemContentStart(value), firstLineEnd);
      const p = Math.max(pos, contentStart);
      const before = value.slice(0, p);
      const tail = value.slice(p, firstLineEnd);
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

  /**
   * Flush the active edit into the note. Returns true if content changed.
   * With renderAfter=false the session stays alive while the textarea keeps
   * focus (Cmd+S, app-switch) unless forceClose ends it (blur, navigation) —
   * an orphaned-but-focused textarea would silently swallow keystrokes.
   */
  commit(renderAfter = true, forceClose = false): boolean {
    this.cancelLiveCommit();
    const a = this.active;
    if (!a) {
      if (renderAfter && this.staleDom) this.rerenderKeepScroll();
      return false;
    }
    const value = a.textarea.value;
    const newLines = value.split("\n");
    const changed = value !== a.original;
    if (changed) {
      const lines = this.host.content().split("\n");
      // The session's range is moved onto the new lines *before* the host is
      // told: update() is observable (the note counter reads pendingContent),
      // and a range still pointing at the pre-splice lines would misread it.
      if (a.append) {
        if (value.trim() !== "") {
          a.start = lines.length + 1; // after the separating blank
          lines.push("", ...newLines);
          a.append = false;
          a.wasAppend = true;
          a.end = a.start + newLines.length - 1;
          // Re-base onto the lines just written. Left at MAX_SAFE_INTEGER (what
          // an append starts with, since nothing rendered covers it) every later
          // flush would compute a nonsense lineDelta and wedge staleShifted true,
          // which silently drops link taps and checkbox toggles.
          a.domEnd = a.end;
          this.lineDelta = 0;
          // appended past everything rendered, so no block's coordinates moved
          this.commitEnd = Number.MAX_SAFE_INTEGER;
          this.host.update(lines.join("\n"));
        }
      } else if (a.wasAppend && value.trim() === "") {
        // An appended block emptied again: take the lines back out, separating
        // blank and all, and go back to appending. Splicing "" in would leave
        // blank lines the user never typed, and every repeat would add more.
        lines.splice(a.start - 1, a.end - a.start + 2);
        a.append = true;
        a.wasAppend = false;
        a.start = -1;
        a.end = -1;
        a.domEnd = Number.MAX_SAFE_INTEGER;
        this.lineDelta = 0;
        this.commitEnd = Number.MAX_SAFE_INTEGER;
        this.host.update(lines.join("\n"));
      } else {
        lines.splice(a.start, a.end - a.start + 1, ...newLines);
        a.end = a.start + newLines.length - 1;
        // cumulative vs the rendered DOM, not vs the previous flush
        this.lineDelta = a.end - a.domEnd;
        this.commitEnd = a.domEnd;
        // Only a change in line COUNT invalidates the coordinates other
        // handlers are holding, and lineDelta is measured against the rendered
        // DOM rather than the previous flush, so it goes back to false when the
        // count comes back. This matters now that typing flushes continuously:
        // otherwise every link and checkbox would go dead while you edit.
        this.staleShifted = this.lineDelta !== 0;
        this.host.update(lines.join("\n"));
      }
      a.original = value;
    }
    const keepSession =
      !renderAfter && !forceClose && a.textarea.isConnected && document.activeElement === a.textarea;
    if (keepSession) {
      this.staleDom = this.staleDom || changed;
      return changed;
    }
    this.active = null;
    if (renderAfter) this.rerenderKeepScroll();
    // Only a session that actually wrote something leaves the DOM out of step.
    // Marking it stale regardless meant a look-but-don't-touch visit to a block
    // resurrected the previous session's line offset and applied it to
    // coordinates that were already correct.
    else this.staleDom = this.staleDom || changed;
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

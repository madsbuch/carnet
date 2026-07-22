// Fuzzy type-ahead for [wiki-links]: typing "[que" in any note editor (the
// raw source textarea or a block-edit textarea) pops a small panel of
// matching notes under the caret; picking one completes "[name]".
//
// Wired via capture-phase listeners on document, so BlockView's dynamically
// created textareas need no hooks — anything inside #editor or .block-edit
// participates automatically.
import { dirOf, fuzzyScore, noteTitle, resolveLink } from "../links";

export interface LinkCompleteHost {
  paths(): string[];
  currentPath(): string | null;
}

const MAX_ITEMS = 6;

/** The unclosed "[query" immediately before the caret, if any. */
function linkContext(t: HTMLTextAreaElement): { bracket: number; query: string } | null {
  const caret = t.selectionStart;
  if (caret !== t.selectionEnd) return null;
  const before = t.value.slice(0, caret);
  const m = /\[([^\[\]\n]*)$/.exec(before);
  if (!m || m[1] === "") return null; // bare "[" stays quiet — plain markdown links exist
  if (before[m.index - 1] === "!") return null; // image syntax
  return { bracket: m.index, query: m[1] };
}

/** Viewport position of the caret, via an offscreen mirror of the textarea. */
function caretViewportPos(t: HTMLTextAreaElement): { left: number; top: number; lineHeight: number } {
  const s = getComputedStyle(t);
  const div = document.createElement("div");
  for (const prop of [
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing",
    "wordSpacing", "textIndent", "textTransform", "wordBreak", "overflowWrap",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "boxSizing",
  ] as const) {
    div.style[prop] = s[prop];
  }
  div.style.position = "fixed";
  div.style.top = "0";
  div.style.left = "-9999px";
  div.style.visibility = "hidden";
  div.style.whiteSpace = "pre-wrap";
  div.style.width = t.getBoundingClientRect().width + "px";
  div.textContent = t.value.slice(0, t.selectionStart);
  const marker = document.createElement("span");
  marker.textContent = "​";
  div.appendChild(marker);
  document.body.appendChild(div);
  const r = t.getBoundingClientRect();
  const pos = {
    left: r.left + marker.offsetLeft - t.scrollLeft,
    top: r.top + marker.offsetTop - t.scrollTop,
    lineHeight: parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.6,
  };
  div.remove();
  return pos;
}

export function setupLinkComplete(host: LinkCompleteHost): void {
  const panel = document.createElement("div");
  panel.id = "linkcomplete";
  panel.hidden = true;
  document.body.appendChild(panel);

  let target: HTMLTextAreaElement | null = null;
  let bracket = 0;
  let matches: string[] = [];
  let sel = 0;

  function hide(): void {
    panel.hidden = true;
    target = null;
    matches = [];
  }

  /** The link name to insert: the plain title when it resolves to this note,
   *  the full path form when the title alone would land elsewhere. */
  function nameFor(path: string): string {
    const title = noteTitle(path);
    const from = host.currentPath() ?? "";
    if (resolveLink(title, from, host.paths()) === path) return title;
    return path.replace(/\.md$/i, "");
  }

  function pick(i: number): void {
    const t = target;
    const path = matches[i];
    if (!t || path === undefined) return;
    const caret = t.selectionStart;
    t.setRangeText(nameFor(path) + "]", bracket + 1, caret, "end");
    hide();
    t.focus();
    // setRangeText fires no input event; the host's autosave/resize hooks need one
    t.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function renderPanel(): void {
    panel.replaceChildren(
      ...matches.map((p, i) => {
        const item = document.createElement("div");
        item.className = "lc-item" + (i === sel ? " sel" : "");
        item.textContent = noteTitle(p);
        const dir = dirOf(p);
        if (dir) {
          const span = document.createElement("span");
          span.className = "lc-path";
          span.textContent = dir;
          item.appendChild(span);
        }
        // preventDefault keeps focus (and the phone keyboard) in the textarea
        item.addEventListener("pointerdown", (e) => e.preventDefault());
        item.addEventListener("click", () => pick(i));
        return item;
      }),
    );
  }

  function position(t: HTMLTextAreaElement): void {
    const caret = caretViewportPos(t);
    panel.style.visibility = "hidden";
    panel.hidden = false;
    const pw = panel.offsetWidth;
    const ph = panel.offsetHeight;
    const left = Math.max(8, Math.min(caret.left, window.innerWidth - pw - 8));
    const below = caret.top + caret.lineHeight;
    const top = below + ph > window.innerHeight - 8 ? Math.max(8, caret.top - ph - 4) : below;
    panel.style.left = left + "px";
    panel.style.top = top + "px";
    panel.style.visibility = "";
  }

  function update(t: HTMLTextAreaElement): void {
    const ctx = linkContext(t);
    if (!ctx) {
      hide();
      return;
    }
    matches = host
      .paths()
      .map((p) => [fuzzyScore(ctx.query, p), p] as const)
      .filter(([s]) => s >= 0)
      .sort((a, b) => b[0] - a[0])
      .slice(0, MAX_ITEMS)
      .map(([, p]) => p);
    if (matches.length === 0) {
      hide();
      return;
    }
    target = t;
    bracket = ctx.bracket;
    sel = 0;
    renderPanel();
    position(t);
  }

  function eligible(el: EventTarget | null): HTMLTextAreaElement | null {
    if (!(el instanceof HTMLTextAreaElement)) return null;
    if (el.id === "editor" || el.closest(".block-edit")) return el;
    return null;
  }

  document.addEventListener("input", (e) => {
    const t = eligible(e.target);
    if (t) update(t);
    else hide();
  });

  document.addEventListener(
    "keydown",
    (e) => {
      if (panel.hidden || !target) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        sel = (sel + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length;
        renderPanel();
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        pick(sel);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        hide();
      }
    },
    true, // before BlockView's Enter-splits-block handler
  );

  // caret moved by tap/arrow without input, textarea blurred, or note scrolled
  document.addEventListener("selectionchange", () => {
    if (target && document.activeElement === target) update(target);
    else if (target) hide();
  });
  document.addEventListener("scroll", () => hide(), true);
}

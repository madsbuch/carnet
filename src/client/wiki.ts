import { marked } from "marked";
import { isWikiName } from "../links";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface WikiToken {
  type: "wiki";
  raw: string;
  name: string;
}

/**
 * Teach marked about [wiki-links]. The tokenizer only ever sees src starting at
 * the "[", so standard links/images/references are safe: marked's built-in
 * tokenizers consume those before their inner brackets are ever exposed, and
 * the lookahead declines [text](url) / [a][b] / [def]: forms.
 */
export function setupWiki(): void {
  marked.use({
    breaks: true,
    extensions: [
      {
        name: "wiki",
        level: "inline",
        start(src: string) {
          const i = src.indexOf("[");
          return i < 0 ? undefined : i;
        },
        tokenizer(src: string): WikiToken | undefined {
          const m = /^\[([^\[\]\n]+)\](?!\(|\[|:)/.exec(src);
          if (!m) return undefined;
          const name = m[1].trim();
          if (!isWikiName(name)) return undefined;
          // [docs] with a "[docs]: url" definition is a markdown shortcut
          // reference link — decline so marked's own tokenizer renders it.
          const defs = (this as unknown as { lexer?: { tokens?: { links?: Record<string, unknown> } } })
            .lexer?.tokens?.links;
          const key = name.toLowerCase().replace(/\s+/g, " ");
          if (defs && Object.prototype.hasOwnProperty.call(defs, key)) return undefined;
          return { type: "wiki", raw: m[0], name };
        },
        renderer(token) {
          const t = token as unknown as WikiToken;
          return `<a class="wiki" data-name="${escapeHtml(t.name)}">${escapeHtml(t.name)}</a>`;
        },
      },
    ],
  });
}

// The block editor is the one place that splices raw source lines under a
// rendered view, so it is where a bug costs you text. These drive the real
// class against a real DOM.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

/** happy-dom has to be installed as globals before blockview/marked load. */
function installDom(): void {
  const w = new Window({ url: "http://localhost" });
  for (const key of [
    "window", "document", "HTMLElement", "HTMLTextAreaElement", "HTMLInputElement",
    "HTMLAnchorElement", "HTMLImageElement", "DocumentFragment", "Node", "Range",
    "MouseEvent", "KeyboardEvent", "Event", "getComputedStyle", "requestAnimationFrame",
    "cancelAnimationFrame", "matchMedia",
  ]) {
    (globalThis as Record<string, unknown>)[key] = (w as unknown as Record<string, unknown>)[key];
  }
}
installDom();

const { BlockView } = await import("./client/blockview");

/** A host that records what the editor pushes back, like app.ts does. */
function makeHost(initial: string) {
  const state = { content: initial, updates: 0 };
  return {
    state,
    host: {
      content: () => state.content,
      update: (next: string) => {
        state.content = next;
        state.updates++;
      },
      wikiExists: () => true,
      followWiki: () => {},
      openRelative: () => {},
      openExternal: () => {},
      imageSrc: () => null,
    },
  };
}

let container: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  document.body.innerHTML = "";
});

/** Type into whichever textarea the editor opened, firing input like a user. */
function type(text: string): HTMLTextAreaElement {
  const ta = container.querySelector("textarea") as HTMLTextAreaElement;
  expect(ta).toBeTruthy();
  ta.value = text;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  return ta;
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("BlockView", () => {
  test("typing reaches the note on its own, without ending the session", async () => {
    const { state, host } = makeHost("# Title\n\nfirst paragraph\n\nsecond paragraph");
    const view = new BlockView(container, host);
    view.render();
    view.openRange(2, 2, 0);

    const ta = type("EDITED paragraph");
    // still nothing: the flush is debounced, not immediate
    expect(state.content).toContain("first paragraph");

    // The real fix under test: no blur, no Enter, no navigation — just typing.
    Object.defineProperty(document, "activeElement", { value: ta, configurable: true });
    await settle(600);

    expect(state.content).toBe("# Title\n\nEDITED paragraph\n\nsecond paragraph");
    expect(view.hasActiveEdit()).toBe(true); // the session survives the flush
  });

  test("repeated flushes in one session don't duplicate or drop lines", async () => {
    const { state, host } = makeHost("# Title\n\nbody\n\ntail");
    const view = new BlockView(container, host);
    view.render();
    view.openRange(2, 2, 0);
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    Object.defineProperty(document, "activeElement", { value: ta, configurable: true });

    for (const draft of ["one", "one two", "one two three", "one two three four"]) {
      type(draft);
      await settle(500);
    }
    expect(state.content).toBe("# Title\n\none two three four\n\ntail");

    // and growing the block by lines stays correct
    type("a\nb\nc");
    await settle(500);
    expect(state.content).toBe("# Title\n\na\nb\nc\n\ntail");

    // ...and shrinking it back
    type("just one line");
    await settle(500);
    expect(state.content).toBe("# Title\n\njust one line\n\ntail");
  });

  test("pendingContent always equals what committing would produce", async () => {
    const { state, host } = makeHost("# Title\n\nbody\n\ntail");
    const view = new BlockView(container, host);
    view.render();
    view.openRange(2, 2, 0);
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    Object.defineProperty(document, "activeElement", { value: ta, configurable: true });

    for (const draft of ["x", "x y", "line\nline2", "back to one"]) {
      type(draft);
      const predicted = view.pendingContent();
      await settle(500);
      expect(state.content).toBe(predicted);
    }
  });

  test("the last keystrokes survive a flush on navigation", () => {
    const { state, host } = makeHost("# Title\n\nbody");
    const view = new BlockView(container, host);
    view.render();
    view.openRange(2, 2, 0);
    type("typed but never blurred");
    view.flush(); // what loadNote / changeVault / window close do
    expect(state.content).toBe("# Title\n\ntyped but never blurred");
    expect(view.hasActiveEdit()).toBe(false);
  });

  test("editing the first block leaves the rest of the note untouched", async () => {
    const body = ["# Title", "", "one", "", "two", "", "three", "", "four"].join("\n");
    const { state, host } = makeHost(body);
    const view = new BlockView(container, host);
    view.render();
    view.openRange(2, 2, 0);
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    Object.defineProperty(document, "activeElement", { value: ta, configurable: true });
    type("ONE");
    await settle(500);
    expect(state.content).toBe(["# Title", "", "ONE", "", "two", "", "three", "", "four"].join("\n"));
  });

  test("a list item edit rewrites only that item", async () => {
    const body = ["- alpha", "- beta", "- gamma"].join("\n");
    const { state, host } = makeHost(body);
    const view = new BlockView(container, host);
    view.render();
    view.openRange(1, 1, 0);
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    Object.defineProperty(document, "activeElement", { value: ta, configurable: true });
    type("- BETA");
    await settle(500);
    expect(state.content).toBe(["- alpha", "- BETA", "- gamma"].join("\n"));
  });

  test("an empty note takes its first paragraph", () => {
    const { state, host } = makeHost("");
    const view = new BlockView(container, host);
    view.render();
    view.openFirst();
    type("first words in a brand new note");
    view.flush();
    expect(state.content).toBe("first words in a brand new note");
  });

  test("committing twice does not write twice", () => {
    const { state, host } = makeHost("# Title\n\nbody");
    const view = new BlockView(container, host);
    view.render();
    view.openRange(2, 2, 0);
    type("changed");
    view.flush();
    const after = state.updates;
    view.flush();
    expect(state.updates).toBe(after);
    expect(state.content).toBe("# Title\n\nchanged");
  });
});

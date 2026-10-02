import { Type } from "typebox";
import { chromium, type Browser, type Page } from "playwright-core";
import { BROWSER_CDP } from "../api/mcp.js";
import { diffViews, findNodes, findRef, pinned, renderView, sectionText, textPage, type AxChild, type View, type Viewport } from "./view.js";

/**
 * The agent's browser tools: the portal's own, on the same Chromium the
 * Playwright MCP drove, over its debugging port.
 *
 * Every response is sized for a local model, which reads each token before it
 * can answer: a page is the viewport (view.ts), an action answers with what it
 * changed, text is read a section at a time. Elements are addressed by the refs
 * a view shows, resolved here — never by a selector the model wrote — and a
 * ref whose element has gone says so instead of acting on something else.
 */

let browser: Browser | null = null;
let connecting: Promise<Browser> | null = null;

async function connect(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  connecting ??= chromium
    .connectOverCDP(BROWSER_CDP, { timeout: 10_000 })
    .then((b) => {
      browser = b;
      b.on("disconnected", () => {
        if (browser === b) browser = null;
      });
      return b;
    })
    .catch((e: Error) => {
      throw new Error(`The browser is not reachable at ${BROWSER_CDP} (${e.message.split("\n")[0]}). Is it running? See Settings → Browser.`);
    })
    .finally(() => {
      connecting = null;
    });
  return connecting;
}

/** What each chat was last shown, and on which tab: diffs and scrolls are told against it. */
interface Seen {
  page: Page;
  view?: View;
  url?: string;
  scrollY?: number;
}
const seen = new Map<string, Seen>();

/** The tab a chat works in: the one it last used, else the most recent. */
async function pageFor(sessionId: string): Promise<Page> {
  const known = seen.get(sessionId);
  if (known && !known.page.isClosed()) return known.page;
  const b = await connect();
  const context = b.contexts()[0] ?? (await b.newContext());
  const pages = context.pages();
  const page = pages.length ? pages[pages.length - 1] : await context.newPage();
  seen.set(sessionId, { page });
  return page;
}

const metrics = (page: Page): Promise<Viewport> =>
  page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollY: Math.round(scrollY),
    scrollHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
  }));

async function look(page: Page, options: { mode?: "a11y" | "index"; skip?: ReadonlySet<string> } = {}) {
  const [tree, viewport, title] = await Promise.all([
    page.ariaSnapshotJSON({ mode: "ai", boxes: true }) as Promise<AxChild[]>,
    metrics(page),
    page.title(),
  ]);
  return { tree, viewport, view: renderView(tree, viewport, { title, url: page.url() }, options) };
}

/** Shows the page, and remembers what was shown for the next diff. */
async function show(sessionId: string, page: Page, options: { mode?: "a11y" | "index"; skip?: ReadonlySet<string> } = {}, note = "") {
  const { view, viewport } = await look(page, options);
  seen.set(sessionId, { page, view, url: page.url(), scrollY: viewport.scrollY });
  return text(note ? `${note}\n\n${view.text}` : view.text);
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

/** Lets a page settle after an action: its load, then a moment for scripts to draw. */
async function settle(page: Page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
}

/** A ref as the model may write it — `e12`, `[e12]`, `ref=e12` — reduced to the ref. */
export function cleanRef(raw: unknown): string {
  const ref = String(raw ?? "").trim().replace(/^\[|\]$/g, "").replace(/^(?:aria-)?ref\s*=\s*/i, "").trim();
  if (!/^(?:f\d+)?e\d+$/.test(ref)) throw new Error(`"${raw}" is not a ref. Use one from the last snapshot, like e12.`);
  return ref;
}

/** The element a ref names, or a clear error when it is gone: never something else in its place. */
async function element(page: Page, raw: unknown) {
  const ref = cleanRef(raw);
  const locator = page.locator(`aria-ref=${ref}`);
  if ((await locator.count()) === 0) {
    throw new Error(`${ref} is no longer on the page: it changed or was removed. Take a fresh browser_snapshot and use the refs it shows.`);
  }
  return { ref, locator };
}

/**
 * An action, answered with what it changed. A new address or a new tab is
 * answered with a view of it; so is a change too big to be shorter as a diff.
 */
async function act(sessionId: string, what: string, fn: (page: Page) => Promise<void>) {
  const page = await pageFor(sessionId);
  let before = seen.get(sessionId);
  if (!before?.view || before.url !== page.url()) {
    const { view, viewport } = await look(page);
    before = { page, view, url: page.url(), scrollY: viewport.scrollY };
  }
  const opened = page.context().waitForEvent("page", { timeout: 1500 }).catch(() => null);
  await fn(page);
  const tab = await opened;
  if (tab) {
    await settle(tab);
    return show(sessionId, tab, {}, `${what}: it opened a new tab, which is where you are now.`);
  }
  await settle(page);
  if (page.url() !== before.url) return show(sessionId, page, {}, `${what}: the page is now ${page.url()}.`);
  const { view, viewport } = await look(page);
  const changes = diffViews(before.view!, view);
  seen.set(sessionId, { page, view, url: page.url(), scrollY: viewport.scrollY });
  if (changes === null) return text(`${what}: the page changed a lot.\n\n${view.text}`);
  return text(changes.length ? `${what}. What changed on screen:\n${changes.join("\n")}` : `${what}. Nothing on screen changed.`);
}

/** Keys as people write them ("cmd+l", "ctrl+shift+t") in Playwright's spelling. */
export function keyCombo(raw: string): string {
  const names: Record<string, string> = { cmd: "Meta", command: "Meta", meta: "Meta", ctrl: "Control", control: "Control", alt: "Alt", option: "Alt", shift: "Shift", esc: "Escape", enter: "Enter", return: "Enter", tab: "Tab", space: "Space", backspace: "Backspace", delete: "Delete", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", pageup: "PageUp", pagedown: "PageDown", home: "Home", end: "End" };
  return raw
    .split("+")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => names[k.toLowerCase()] ?? k)
    .join("+");
}

const REF = Type.String({ description: "A ref from the last snapshot, like e12." });

/** An ExtensionFactory — see pi's InlineExtension. */
export function browserTools(sessionId: string) {
  return (pi: any): void => {
    pi.registerTool({
      name: "browser_navigate",
      label: "Go to",
      description: "Open a URL in the browser. Answers with the page as it is on screen.",
      promptSnippet: "browser_navigate — open a URL",
      parameters: Type.Object({ url: Type.String({ description: "The address to open" }) }),
      async execute(_id: string, p: { url: string }) {
        const page = await pageFor(sessionId);
        await page.goto(p.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(600);
        return show(sessionId, page);
      },
    });

    pi.registerTool({
      name: "browser_back",
      label: "Back",
      description: "Go back one page in the browser's history.",
      parameters: Type.Object({}),
      async execute() {
        const page = await pageFor(sessionId);
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(400);
        return show(sessionId, page);
      },
    });

    pi.registerTool({
      name: "browser_snapshot",
      label: "Look at the page",
      description:
        "What is on screen now, as text with a ref for each element: only the viewport, with how much there is above and below. " +
        "mode \"index\" lists only what can be clicked or typed into, for forms. Long text is cut with a pointer to browser_get_text.",
      promptSnippet: "browser_snapshot — see what is on screen, with refs to act on",
      parameters: Type.Object({
        mode: Type.Optional(Type.Union([Type.Literal("a11y"), Type.Literal("index")], { description: "a11y (default): everything in view. index: only what can be clicked or typed into." })),
      }),
      async execute(_id: string, p: { mode?: "a11y" | "index" }) {
        return show(sessionId, await pageFor(sessionId), { mode: p.mode });
      },
    });

    pi.registerTool({
      name: "browser_click",
      label: "Click",
      description: "Click an element by its ref. Answers with what changed on screen, or the new page.",
      promptSnippet: "browser_click — click an element by ref",
      parameters: Type.Object({ ref: REF, double: Type.Optional(Type.Boolean({ description: "Double-click" })) }),
      async execute(_id: string, p: { ref: string; double?: boolean }) {
        return act(sessionId, `Clicked ${cleanRef(p.ref)}`, async (page) => {
          const { locator } = await element(page, p.ref);
          if (p.double) await locator.dblclick({ timeout: 10_000 });
          else await locator.click({ timeout: 10_000 });
        });
      },
    });

    pi.registerTool({
      name: "browser_type",
      label: "Type",
      description: "Type into a text field by its ref, replacing what is in it. submit presses Enter after. Answers with what changed.",
      promptSnippet: "browser_type — type into a field by ref",
      parameters: Type.Object({
        ref: REF,
        text: Type.String({ description: "What to type" }),
        submit: Type.Optional(Type.Boolean({ description: "Press Enter afterwards" })),
      }),
      async execute(_id: string, p: { ref: string; text: string; submit?: boolean }) {
        return act(sessionId, `Typed into ${cleanRef(p.ref)}`, async (page) => {
          const { locator } = await element(page, p.ref);
          await locator.fill(p.text, { timeout: 10_000 });
          if (p.submit) await locator.press("Enter");
        });
      },
    });

    pi.registerTool({
      name: "browser_select",
      label: "Choose",
      description: "Choose an option in a dropdown by its ref, by the option's visible text.",
      parameters: Type.Object({ ref: REF, option: Type.String({ description: "The option's text" }) }),
      async execute(_id: string, p: { ref: string; option: string }) {
        return act(sessionId, `Chose "${p.option}" in ${cleanRef(p.ref)}`, async (page) => {
          const { locator } = await element(page, p.ref);
          await locator.selectOption({ label: p.option }, { timeout: 10_000 });
        });
      },
    });

    pi.registerTool({
      name: "browser_key",
      label: "Press keys",
      description: "Press a key or combination on the page, like Enter, Escape or ctrl+a. Answers with what changed.",
      parameters: Type.Object({ key: Type.String({ description: "A key or combination, like Enter, Escape, ctrl+a" }) }),
      async execute(_id: string, p: { key: string }) {
        const combo = keyCombo(p.key);
        return act(sessionId, `Pressed ${combo}`, (page) => page.keyboard.press(combo));
      },
    });

    pi.registerTool({
      name: "browser_scroll",
      label: "Scroll",
      description:
        "Scroll by screens and see what comes into view. With a ref, scroll that element into view instead. " +
        "What stayed pinned on screen (a sticky sidebar) is not repeated.",
      promptSnippet: "browser_scroll — see the next screen down (or up)",
      parameters: Type.Object({
        direction: Type.Optional(Type.Union([Type.Literal("down"), Type.Literal("up")], { description: "down (default) or up" })),
        screens: Type.Optional(Type.Number({ description: "How many screens, 1 by default" })),
        ref: Type.Optional(REF),
      }),
      async execute(_id: string, p: { direction?: "down" | "up"; screens?: number; ref?: string }) {
        const page = await pageFor(sessionId);
        const before = seen.get(sessionId);
        if (p.ref) {
          const { locator } = await element(page, p.ref);
          await locator.scrollIntoViewIfNeeded({ timeout: 10_000 });
        } else {
          const { width, height } = await metrics(page);
          const screens = Math.min(Math.max(p.screens ?? 1, 0.25), 10);
          // At the middle of the page, so a scrolling panel under the pointer scrolls too.
          await page.mouse.move(width / 2, height / 2);
          await page.mouse.wheel(0, (p.direction === "up" ? -1 : 1) * height * 0.9 * screens);
        }
        await page.waitForTimeout(500);
        const now = await look(page);
        const skip = before?.view && before.url === page.url() ? pinned(before.view, now.view, now.viewport.scrollY - (before.scrollY ?? 0)) : new Set<string>();
        if (before && before.url === page.url() && before.scrollY === now.viewport.scrollY && !p.ref) {
          return show(sessionId, page, { skip }, p.direction === "up" ? "Already at the top." : "Already at the bottom: there is nothing further down.");
        }
        return show(sessionId, page, { skip });
      },
    });

    pi.registerTool({
      name: "browser_find",
      label: "Find on the page",
      description: "Find elements anywhere on the page, in view or not, by words in their name or text. Answers with their refs and where they are.",
      promptSnippet: "browser_find — find an element by its words, anywhere on the page",
      parameters: Type.Object({ query: Type.String({ description: "Words the element's name or text contains" }) }),
      async execute(_id: string, p: { query: string }) {
        const page = await pageFor(sessionId);
        const { tree, viewport } = await look(page);
        const hits = findNodes(tree, p.query, viewport);
        return text(hits.length ? hits.join("\n") : `Nothing on the page matches "${p.query}".`);
      },
    });

    pi.registerTool({
      name: "browser_get_text",
      label: "Read",
      description: "Read the full text of a section by its ref — an article, a paragraph, a table — in pages. Use it where a snapshot cut text short.",
      promptSnippet: "browser_get_text — read a section's full text by ref",
      parameters: Type.Object({
        ref: REF,
        offset: Type.Optional(Type.Number({ description: "Where to continue from, as the last page said" })),
        max_chars: Type.Optional(Type.Number({ description: "How much to read, 2000 by default" })),
      }),
      async execute(_id: string, p: { ref: string; offset?: number; max_chars?: number }) {
        const ref = cleanRef(p.ref);
        const page = await pageFor(sessionId);
        const { tree } = await look(page);
        const node = findRef(tree, ref);
        if (!node) throw new Error(`${ref} is no longer on the page: it changed or was removed. Take a fresh browser_snapshot and use the refs it shows.`);
        return text(textPage(sectionText(node), ref, p.offset ?? 0, Math.min(Math.max(p.max_chars ?? 2000, 200), 8000)));
      },
    });

    pi.registerTool({
      name: "browser_screenshot",
      label: "Screenshot",
      description: "A picture of what is on screen, or of one element by its ref. For layout, images and pages whose text says little.",
      parameters: Type.Object({ ref: Type.Optional(REF) }),
      async execute(_id: string, p: { ref?: string }) {
        const page = await pageFor(sessionId);
        const shot = p.ref
          ? await (await element(page, p.ref)).locator.screenshot({ type: "jpeg", quality: 70, timeout: 10_000 })
          : await page.screenshot({ type: "jpeg", quality: 70, timeout: 10_000 });
        return { content: [{ type: "image" as const, data: shot.toString("base64"), mimeType: "image/jpeg" }], details: {} };
      },
    });
  };
}

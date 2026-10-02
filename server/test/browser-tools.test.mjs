import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { freePort } from "./server-harness.mjs";

/**
 * The portal's browser tools against a real Chromium over its debugging port,
 * as they run beside the browser container: what the model is shown after
 * each call, a stale ref, a scroll past a sticky sidebar, reading and finding.
 */

const home = mkdtempSync(path.join(tmpdir(), "browser-tools-"));

const FORM = `<!doctype html><title>Signup</title><h1>Sign up</h1>
<form onsubmit="event.preventDefault(); const b = document.getElementById('save'); b.disabled = true; b.textContent = 'Saved'; document.getElementById('msg').hidden = false;">
<label>Name <input id=name></label> <label>Plan <select id=plan><option>Free</option><option>Pro</option></select></label>
<button id=save>Save</button></form>
<p role=alert id=msg hidden>Thanks, you are signed up.</p>
<p><a href="/long">The long page</a></p>`;

const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const LONG = `<!doctype html><title>Long</title>
<nav aria-label="Sections" style="position:fixed;top:0;left:0;width:180px"><a href="#a">Alpha</a> <a href="#b">Beta</a></nav>
<main style="margin-left:200px">${Array.from({ length: 60 }, (_, i) => `<p>Paragraph ${i}: ${words(20)}</p>`).join("")}
<article id=essay><h2>Essay</h2><p>${words(600)}</p></article>
<h2>Pricing</h2><p>It costs nothing.</p></main>`;

const site = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(req.url === "/long" ? LONG : FORM);
});
let browser;
let tools = {};
let base = "";

after(async () => {
  site.close();
  await browser?.close();
  rmSync(home, { recursive: true, force: true });
});

/**
 * A Chromium with a debugging port, as the browser container runs one: the
 * one Playwright has installed, if it has. Without one the test is skipped
 * and says why, rather than failing on a machine with no browser.
 */
const cdpPort = await freePort();
try {
  browser = await chromium.launch({ args: [`--remote-debugging-port=${cdpPort}`, "--window-size=1280,720"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto("about:blank");
} catch (e) {
  browser = undefined;
  console.log(`# no Chromium to run: ${e.message.split("\n")[0]}`);
}

async function setUp() {
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${site.address().port}`;
  process.env.BROWSER_CDP_URL = `http://127.0.0.1:${cdpPort}`;
  process.env.DATA_DIR = home;
  process.env.PI_CODING_AGENT_DIR = path.join(home, "agent");
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  const { browserTools } = await import("../dist/browser/tools.js");
  browserTools("chat-1")({ registerTool: (t) => (tools[t.name] = t) });
}

const call = async (name, params = {}) => {
  const result = await tools[name].execute("call", params);
  return result.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
};
const refOf = (text, pattern) => {
  const line = text.split("\n").find((l) => pattern.test(l));
  assert.ok(line, `no line matching ${pattern} in:\n${text}`);
  return line.match(/\[((?:f\d+)?e\d+)\]/)[1];
};

test("the browser tools, on a real browser", { skip: browser ? false : "no Chromium installed for Playwright" }, async (t) => {
  await setUp();

  await t.test("a page is shown as the view, never as HTML", async () => {
    const view = await call("browser_navigate", { url: `${base}/form` });
    assert.match(view, /^Page: Signup — /);
    assert.match(view, /textbox "Name" \[e\d+\]/);
    assert.doesNotMatch(view, /<\/?[a-z]+[\s>]/i, "no HTML in the answer");
  });

  let saveRef;
  await t.test("typing and clicking answer with what changed", async () => {
    const view = await call("browser_snapshot");
    const typed = await call("browser_type", { ref: refOf(view, /textbox "Name"/), text: "Ada" });
    assert.match(typed, /What changed on screen:/);
    assert.match(typed, /textbox "Name": Ada/);
    const chose = await call("browser_select", { ref: refOf(view, /combobox "Plan"/), option: "Pro" });
    assert.match(chose, /Pro/);
    saveRef = refOf(view, /button "Save"/);
    const clicked = await call("browser_click", { ref: saveRef });
    assert.match(clicked, /button "Saved" \[e\d+\] disabled/);
    assert.match(clicked, /\+ alert: Thanks, you are signed up\./);
    assert.ok(clicked.length < 1500, `a diff, not a page: ${clicked.length} chars`);
  });

  await t.test("a ref whose element is gone is refused, not clicked somewhere else", async () => {
    await assert.rejects(call("browser_click", { ref: saveRef }), /no longer on the page.*fresh browser_snapshot/s);
    await assert.rejects(call("browser_click", { ref: "#save" }), /not a ref/);
  });

  await t.test("following a link answers with the new page", async () => {
    const view = await call("browser_snapshot");
    const moved = await call("browser_click", { ref: refOf(view, /link "The long page"/) });
    assert.match(moved, /the page is now .*\/long/);
    assert.match(moved, /↓ [\d,]+ more below/);
  });

  await t.test("scrolling shows the next screen without repeating a pinned sidebar", async () => {
    const scrolled = await call("browser_scroll");
    assert.match(scrolled, /Paragraph \d+/);
    assert.match(scrolled, /Still on screen and unchanged, not repeated: Sections/);
    assert.doesNotMatch(scrolled, /link "Alpha"/);
  });

  await t.test("find reaches past the viewport, and get_text reads a section in pages", async () => {
    const found = await call("browser_find", { query: "pricing" });
    assert.match(found, /heading "Pricing" \[(?:f\d+)?e\d+\].* px below/);
    const essay = refOf(await call("browser_find", { query: "essay" }), /heading "Essay"|article/);
    const view = await call("browser_scroll", { ref: essay });
    const article = refOf(view, /^\s*article/);
    const page1 = await call("browser_get_text", { ref: article });
    assert.match(page1, /## Essay/);
    assert.match(page1, /get_text (?:f\d+)?e\d+ offset=\d+ for more/);
    const page2 = await call("browser_get_text", { ref: article, offset: 2000 });
    assert.match(page2, /\(chars [\d,]+–/);
  });

  await t.test("a screenshot is an image", async () => {
    const shot = await tools.browser_screenshot.execute("call", {});
    assert.equal(shot.content[0].type, "image");
    assert.equal(shot.content[0].mimeType, "image/jpeg");
  });
});

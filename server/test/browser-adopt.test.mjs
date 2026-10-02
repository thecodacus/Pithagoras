import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// An install from before the portal's own browser tools: the Playwright MCP
// entry the portal wrote, and switches on its tools.
const home = mkdtempSync(path.join(tmpdir(), "pithagoras-adopt-"));
process.env.DATA_DIR = home;
process.env.PI_CODING_AGENT_DIR = path.join(home, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const mcpFile = path.join(process.env.PI_CODING_AGENT_DIR, "mcp.json");
const CDP = "http://127.0.0.1:9222";
const managed = { command: "npx", args: ["-y", "@playwright/mcp@0.0.79", "--cdp-endpoint", CDP] };
writeFileSync(mcpFile, JSON.stringify({ mcpServers: { browser: managed, jira: { command: "jira-mcp" } } }));

const db = await import("../dist/db.js");
const { adoptPortalBrowser } = await import("../dist/api/browser.js");
const { PORTAL_BROWSER_TOOLS } = await import("../dist/tool-policy.js");

const OLD = ["browser_browser_click", "browser_browser_navigate"];
db.rememberTools([...OLD.map((name) => ({ name, source: "pi-mcp-adapter" })), { name: "jira_search", source: "pi-mcp-adapter" }]);
// The default has the browser off; one chat switched it on, another off on top of a project that had it on.
db.setToolDefaultsOff([...OLD, "jira_search"]);
db.createSession({ id: "has-it", title: "on", workspace: home, executor: "host" });
db.createSession({ id: "no-it", title: "off", workspace: home, executor: "host" });
db.createSession({ id: "silent", title: "untouched", workspace: home, executor: "host" });
db.setSessionTools("has-it", { off: [], on: OLD });
db.setSessionTools("no-it", { off: ["browser_browser_click"], on: [] });
db.setProjectTools("site", { off: [], on: OLD });

const has = (list) => PORTAL_BROWSER_TOOLS.every((name) => list.includes(name));
const mcp = () => JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers;

test("the first start moves over: the MCP entry goes, the portal's tools come on, every switch carried", () => {
  assert.equal(db.portalBrowserState(), "unset");
  adoptPortalBrowser();
  assert.equal(db.portalBrowserState(), "on");
  assert.deepEqual(Object.keys(mcp()), ["jira"], "only the entry the portal wrote is removed");
  assert.ok(has(db.toolDefaultsOff()), "off by default, as the browser was");
  assert.ok(db.toolDefaultsOff().includes("jira_search"));
  assert.ok(has(db.sessionTools("has-it").on), "a chat that had the browser still has it");
  assert.ok(has(db.sessionTools("no-it").off), "a chat that had it off still has it off");
  assert.deepEqual(db.sessionTools("silent"), { off: [], on: [] }, "a chat that said nothing still says nothing");
  assert.ok(has(db.projectTools("site").on), "and a project's say too");
});

test("whether a chat may drive the browser reads the portal's tools from then on", () => {
  db.rememberTools(PORTAL_BROWSER_TOOLS.map((name) => ({ name, source: "browser" })));
  assert.equal(db.browserAllowed(db.getSession("has-it")), true);
  assert.equal(db.browserAllowed(db.getSession("no-it")), false);
  assert.equal(db.browserAllowed(db.getSession("silent")), false);
  assert.equal(db.browserConfigured(), true);
});

test("it runs once: a Playwright MCP added back by hand stays", () => {
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { browser: managed } }));
  adoptPortalBrowser();
  assert.deepEqual(Object.keys(mcp()), ["browser"]);
});

test("switched off, it stays off, and an install without the old entry is left alone", () => {
  db.setPortalBrowser(false);
  adoptPortalBrowser();
  assert.equal(db.portalBrowserState(), "off");
  db.getDb().prepare("DELETE FROM settings WHERE key = 'browser_tools'").run();
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: {} }));
  adoptPortalBrowser();
  assert.equal(db.portalBrowserState(), "unset", "a fresh install connects from the Browser page");
});

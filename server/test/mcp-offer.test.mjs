import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// Issue #95: a tool the MCP adapter's configuration says no to was still listed, still loaded in a running
// chat, and a switched-off one was still reachable through the adapter's own `mcp` tool from its cache.
const home = inProcessHome("pithagoras-mcp-offer-");
const agent = process.env.PI_CODING_AGENT_DIR;
writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: ["npm:pi-mcp-adapter@2.18.0"] }));
const mcpFile = (config) => writeFileSync(path.join(agent, "mcp.json"), JSON.stringify(config));
const cacheFile = (servers) => writeFileSync(path.join(agent, "mcp-cache.json"), JSON.stringify({ version: 1, servers }));

const { mcpOffer } = await import("../dist/mcp-offer.js");
const { switchedOffVia, guardExtension } = await import("../dist/pi/guard.js");
const { createSession, rememberTools, shownTools, withdrawnMcpTools } = await import("../dist/db.js");
const { sessions } = await import("../dist/session-manager.js");

mock.method(console, "warn", () => {});

const cache = {
  jira: { tools: [{ name: "search" }, { name: "create_issue" }, { name: "admin.delete" }], resources: [{ name: "Project List" }] },
  "brave-search": { tools: [{ name: "web_search" }] },
};

test("a server's tool is offered while its configuration registers it, and from the cache while the server starts only when used", () => {
  const offer = mcpOffer({ mcpServers: { jira: { command: "j", directTools: true }, "brave-search": { command: "b", directTools: true, lifecycle: "eager" } } }, { servers: cache }, undefined);
  assert.equal(offer("jira_search"), "cached", "lazy is the adapter's default");
  assert.equal(offer("jira_admin_delete"), "cached", "a dotted name is registered with underscores");
  assert.equal(offer("jira_read_project_list"), "cached", "a resource is a tool too");
  assert.equal(offer("brave_search_web_search"), "offered", "an eager server is started with the chat");
  assert.equal(offer("bash"), undefined, "no server's");
});

test("a server switched off, a tool left out or no longer there is withdrawn", () => {
  const servers = (jira) => ({ mcpServers: { jira: { command: "j", directTools: true, ...jira } } });
  assert.equal(mcpOffer(servers({ disabled: true }), { servers: cache }, undefined)("jira_search"), "withdrawn");
  assert.equal(mcpOffer(servers({ excludeTools: ["create_*"] }), { servers: cache }, undefined)("jira_create_issue"), "withdrawn");
  assert.equal(mcpOffer(servers({ excludeTools: ["jira_create_issue"] }), { servers: cache }, undefined)("jira_create_issue"), "withdrawn", "by its full name as well");
  assert.equal(mcpOffer(servers({ includeTools: ["search"] }), { servers: cache }, undefined)("jira_create_issue"), "withdrawn");
  assert.equal(mcpOffer(servers({ includeTools: ["search"] }), { servers: cache }, undefined)("jira_search"), "cached");
  assert.equal(mcpOffer(servers({}), { servers: cache }, undefined)("jira_gone"), "withdrawn", "the cache is what the adapter registers from");
  assert.equal(mcpOffer(servers({}), null, undefined)("jira_gone"), "offered", "without a cache there is nothing to go by");
});

test("a tool no longer registered one by one is reached through the proxy, not withdrawn", () => {
  const offer = (jira, settings) => mcpOffer({ mcpServers: { jira: { command: "j", ...jira } }, settings }, { servers: cache }, undefined)("jira_search");
  assert.equal(offer({}), "proxied");
  assert.equal(offer({ directTools: false }, { directTools: true }), "proxied", "the server's own setting wins");
  assert.equal(offer({}, { directTools: true }), "cached");
  assert.equal(offer({ directTools: ["create_issue"] }), "proxied");
  assert.equal(offer({ directTools: ["search"] }), "cached");
  assert.equal(mcpOffer({ mcpServers: { jira: { command: "j" } } }, { servers: cache }, "jira")("jira_search"), "cached", "MCP_DIRECT_TOOLS replaces the configuration");
  assert.equal(mcpOffer({ mcpServers: { jira: { command: "j", toolPrefix: "short" } } }, { servers: cache }, undefined)("jira_search"), undefined, "a prefix it cannot read is not judged");
});

test("the mcp tool does not reach a tool that is switched off, by any of its names", () => {
  const off = new Set(["jira_create_issue", "brave_search_web_search"]);
  assert.equal(switchedOffVia("mcp", { tool: "jira_create_issue" }, off), "jira_create_issue");
  assert.equal(switchedOffVia("mcp", { tool: "jira-create-issue" }, off), "jira_create_issue", "the adapter takes hyphens for underscores");
  assert.equal(switchedOffVia("mcp", { tool: "create_issue", server: "jira" }, off), "jira_create_issue");
  assert.equal(switchedOffVia("mcp", { tool: "web_search", server: "brave-search" }, off), "brave_search_web_search");
  assert.equal(switchedOffVia("mcp", { describe: "jira_create_issue" }, off), "jira_create_issue");
  assert.equal(switchedOffVia("mcp", { tool: "jira_search" }, off), undefined, "what is on stays reachable");
  assert.equal(switchedOffVia("mcp", { search: "jira" }, off), undefined);
  assert.equal(switchedOffVia("jira_search", {}, off), undefined);
  assert.equal(switchedOffVia("mcp", { tool: "jira_create_issue" }, new Set()), undefined);
});

test("the guard refuses it before anything could allow it, and an MCP script while a server's tool is off", () => {
  mcpFile({ mcpServers: { jira: { command: "j", directTools: true } } });
  let off = new Set(["jira_create_issue"]);
  const h = {};
  guardExtension("t", () => ({ role: "primary" }), "s", true, () => ({ allowed: true, allowlist: [] }), undefined, [], () => off)({ on: (k, f) => (h[k] = f) });
  const refused = h.tool_call({ toolName: "mcp", input: { tool: "jira_create_issue", args: {} } });
  assert.equal(refused?.block, true);
  assert.match(refused.reason, /switched off in this conversation/);
  assert.equal(h.tool_call({ toolName: "mcp", input: { tool: "jira_search" } }), undefined);
  assert.equal(h.tool_call({ toolName: "mcp_script", input: { code: "await tools.jira_search({})" } })?.block, true);
  off = new Set(["bash"]);
  assert.equal(h.tool_call({ toolName: "mcp", input: { tool: "jira_create_issue" } }), undefined, "read at each call");
  assert.equal(h.tool_call({ toolName: "mcp_script", input: { code: "" } }), undefined, "no server's tool is off");
});

test("what the configuration says no to is not listed, is off in pi, and what comes from the cache is marked", async () => {
  cacheFile(cache);
  mcpFile({ mcpServers: { jira: { command: "j", directTools: true, excludeTools: ["create_issue"] }, "brave-search": { command: "b", disabled: true } } });
  rememberTools([
    { name: "jira_search", source: "pi-mcp-adapter", package: "npm:pi-mcp-adapter@2.18.0" },
    { name: "jira_create_issue", source: "pi-mcp-adapter", package: "npm:pi-mcp-adapter@2.18.0" },
    { name: "brave_search_web_search", source: "pi-mcp-adapter", package: "npm:pi-mcp-adapter@2.18.0" },
    { name: "mcp", source: "pi-mcp-adapter", package: "npm:pi-mcp-adapter@2.18.0" },
    { name: "bash", source: "built in", package: null },
  ]);
  const shown = shownTools();
  assert.deepEqual(shown.map((t) => t.name), ["bash", "jira_search", "mcp"]);
  assert.equal(shown.find((t) => t.name === "jira_search").cached, true);
  assert.equal(shown.find((t) => t.name === "bash").cached, undefined);
  assert.deepEqual(withdrawnMcpTools(), ["brave_search_web_search", "jira_create_issue"]);

  createSession({ id: "idle", title: "idle", workspace: home, executor: "host" });
  const { tools } = await sessions.getTools("idle");
  assert.deepEqual(tools.map((t) => t.name), ["bash", "jira_search", "mcp"]);
  assert.equal(tools.find((t) => t.name === "jira_search").cached, true);
  // What pi is told is off includes them; what the page is told, and what is written down, does not.
  assert.deepEqual(sessions.piOff("idle"), ["brave_search_web_search", "jira_create_issue"]);
  assert.deepEqual(sessions.offFor("idle"), []);
  await sessions.setTools("idle", ["bash"]);
  assert.deepEqual(sessions.offFor("idle"), ["bash"]);

  // Allowed again: listed again, and nothing was written down against it meanwhile.
  mcpFile({ mcpServers: { jira: { command: "j", directTools: true }, "brave-search": { command: "b", directTools: true } } });
  assert.deepEqual(shownTools().map((t) => t.name), ["bash", "brave_search_web_search", "jira_create_issue", "jira_search", "mcp"]);
  assert.deepEqual(sessions.piOff("idle"), ["bash"]);
});

test("a configuration that cannot be read withdraws nothing", () => {
  writeFileSync(path.join(agent, "mcp.json"), "{ not json");
  assert.deepEqual(withdrawnMcpTools(), []);
});

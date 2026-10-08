import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { freePort, inProcessHome, serverEnv, startServer } from "./server-harness.mjs";

/**
 * An agent's and a routine's own tool switches (#81), against the whole server:
 * what their pages read and write, and what a chat or a run under them starts
 * with. The layers, each an exception to the one before it: the portal-wide
 * default, the agent, the project, the routine, and the chat's own.
 */
const home = inProcessHome("pithagoras-tool-layers-api-");
mkdirSync(path.join(home, "ws", "research"), { recursive: true });
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({}));

const db = await import("../dist/db.js");
db.rememberTools([
  { name: "web_search", source: "pi-web-access" },
  { name: "web_fetch", source: "pi-web-access" },
  { name: "bash", source: "built in", package: null },
  // The portal's own browser tool: what a routine's old Browser switch answers for.
  { name: "browser_navigate", source: "browser", package: null, inline: true },
]);

let base;
before(async () => {
  ({ base } = await startServer(serverEnv(home, await freePort())));
});

const send = (url, method, body) =>
  fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (url, method = "GET", body) => {
  const res = await send(url, method, body);
  assert.ok(res.ok, `${url}: ${res.status} ${await res.clone().text()}`);
  return res.json();
};
const states = (r) => Object.fromEntries(r.tools.map((t) => [t.name, t.enabled]));

beforeEach(async () => {
  await json("/api/tools", "PUT", { off: ["web_fetch"] });
  db.getDb().exec("DELETE FROM project_tools; DELETE FROM agent_tools; UPDATE routines SET tools_off = '', tools_on = ''");
});

/** A routine, made as the page makes one, in Home or a project. */
const routine = async (name, workspace) =>
  json("/api/routines", "POST", { name, schedule: "0 9 * * *", instructions: "Do it", ...(workspace ? { workspace } : {}) });

/** A session that is a run of the routine, as the supervisor makes one. */
function runOf(r, workspace) {
  const id = `run-${r.slug}`;
  if (!db.getSession(id)) db.createSession({ id, title: r.name, workspace, executor: "host", kind: "routine", routine_slug: r.slug });
  return id;
}

test("an agent's switches are exceptions to the default, for every chat in its home", async () => {
  const agent = await json("/api/agents", "POST", { name: "Reader" });
  const before = await json(`/api/agents/${agent.id}/tools`);
  assert.deepEqual(states(before), { bash: true, browser_navigate: true, web_fetch: false, web_search: true });
  assert.equal(before.live, false);

  // Both ways: bash off where the default has it on, web_fetch on where the default has it off.
  const saved = await json(`/api/agents/${agent.id}/tools`, "PUT", { off: ["bash"] });
  assert.deepEqual(saved.off, ["bash"]);
  assert.deepEqual(db.agentTools(agent.id), { off: ["bash"], on: ["web_fetch"] });

  const chat = await json("/api/sessions", "POST", { agent: agent.id });
  assert.deepEqual(states(await json(`/api/sessions/${chat.id}/tools`)), { bash: false, browser_navigate: true, web_fetch: true, web_search: true });
  // Another agent's chats, and a project's, are not this agent's.
  const other = await json("/api/sessions", "POST", {});
  assert.deepEqual(states(await json(`/api/sessions/${other.id}/tools`)), { bash: true, browser_navigate: true, web_fetch: false, web_search: true });
  const project = await json("/api/sessions", "POST", { workspace: "research" });
  assert.equal(states(await json(`/api/sessions/${project.id}/tools`)).bash, true);

  // A later change to the default reaches what the agent never said anything about.
  await json("/api/tools", "PUT", { off: ["web_fetch", "web_search"] });
  assert.equal(states(await json(`/api/sessions/${chat.id}/tools`)).web_search, false);
  // And the chat's own switch is the last word.
  await json(`/api/sessions/${chat.id}/tools`, "PUT", { off: ["web_search"] });
  assert.equal(states(await json(`/api/sessions/${chat.id}/tools`)).bash, true);
});

test("the first agent's switches reach its chats, its heartbeat and the routines in Home", async () => {
  await json("/api/agents/home/tools", "PUT", { off: ["web_fetch", "web_search"] });
  const chat = await json("/api/sessions", "POST", {});
  assert.equal(states(await json(`/api/sessions/${chat.id}/tools`)).web_search, false);
  const r = await routine("Home routine");
  const run = runOf(r, db.getSession(chat.id).workspace);
  assert.equal(states(await json(`/api/sessions/${run}/tools`)).web_search, false);
  // The routine's page shows what its agent leaves as its default.
  const page = await json(`/api/routines/${r.id}/tools`);
  assert.equal(page.tools.find((t) => t.name === "web_search").defaultOn, false);
});

test("a routine's switches come after its agent and its project, and a run's chat has the last word", async () => {
  await json("/api/projects/research/tools", "PUT", { off: ["web_fetch", "bash"] });
  const r = await routine("Research digest", "research");
  const page = await json(`/api/routines/${r.id}/tools`);
  // The project's, with the browser off as a routine's always was.
  assert.deepEqual(states(page), { bash: false, browser_navigate: false, web_fetch: false, web_search: true });
  assert.equal(page.tools.find((t) => t.name === "bash").defaultOn, false, "what the layers under it say");
  assert.equal(page.tools.find((t) => t.name === "browser_navigate").defaultOn, true);

  await json(`/api/routines/${r.id}/tools`, "PUT", { off: ["web_fetch", "web_search", "browser_navigate"] });
  assert.deepEqual(db.routineTools(r.slug), { off: ["browser_navigate", "web_search"], on: ["bash"] });
  const run = runOf(r, path.join(home, "ws", "research"));
  assert.deepEqual(states(await json(`/api/sessions/${run}/tools`)), { bash: true, browser_navigate: false, web_fetch: false, web_search: false });
  await json(`/api/sessions/${run}/tools`, "PUT", { off: ["web_fetch", "web_search", "browser_navigate"] });
  assert.equal(states(await json(`/api/sessions/${run}/tools`)).bash, true);
  await json(`/api/sessions/${run}/tools`, "PUT", { off: ["web_fetch", "browser_navigate"] });
  assert.equal(states(await json(`/api/sessions/${run}/tools`)).web_search, true, "the run's chat switched it on for itself");
});

test("the browser is a routine's tools now: off unless switched on, and its old switch is kept", async () => {
  const r = await routine("Shop check");
  const run = runOf(r, db.getSession((await json("/api/sessions", "POST", {})).id).workspace);
  const row = () => db.getSession(run);
  assert.equal(db.browserAllowed(row()), false, "a new routine has no browser");

  // Switched on in the tools list: its runs may drive it.
  await json(`/api/routines/${r.id}/tools`, "PUT", { off: ["web_fetch"] });
  assert.deepEqual(db.routineTools(r.slug), { off: [], on: ["browser_navigate"] });
  assert.equal(db.browserAllowed(row()), true);
  assert.equal(states(await json(`/api/sessions/${run}/tools`)).browser_navigate, true);

  // A routine that had the old switch on keeps it, for browser tools it has said nothing about.
  db.getDb().prepare("UPDATE routines SET tools_off = '', tools_on = '', browser = 1 WHERE id = ?").run(r.id);
  assert.equal(db.browserAllowed(row()), true);
  db.getDb().prepare("UPDATE routines SET browser = 0 WHERE id = ?").run(r.id);
  assert.equal(db.browserAllowed(row()), false);
});

test("an agent or routine that is not there is not found", async () => {
  assert.equal((await send("/api/agents/nobody/tools")).status, 404);
  assert.equal((await send("/api/routines/nothing/tools", "PUT", { off: [] })).status, 404);
  assert.equal((await send("/api/agents/home/tools", "PUT", { off: "bash" })).status, 400);
});

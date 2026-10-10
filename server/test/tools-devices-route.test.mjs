import { test, before } from "node:test";
import assert from "node:assert/strict";
import { freePort, inProcessHome, serverEnv, startServer } from "./server-harness.mjs";

/**
 * What the tool lists say of pi's seven file and shell tools in a portal that has run chats with a device,
 * against the whole server. Such a chat registers them again as the devices extension's, and a catalogue
 * that was written from it filed them under "devices": the lists have to put them in the Built-in box
 * all the same, once, and a default for one of them is still a default for the tool.
 */
const home = inProcessHome("pithagoras-tools-devices-route-");
const db = await import("../dist/db.js");
const { sessions } = await import("../dist/session-manager.js");

const SEVEN = ["bash", "edit", "find", "grep", "ls", "read", "write"];
// As a portal that ran with a device has it kept them: the devices extension's, the portal's own inline.
db.putSetting(
  "tools_seen",
  JSON.stringify([
    ...SEVEN.map((name) => ({ name, source: "devices", description: `${name}, with a device`, package: null, inline: true })),
    { name: "web_search", source: "pi-web-access", package: null, inline: false },
  ]),
);
db.createSession({ id: "idle", title: "idle", workspace: home, executor: "host" });

let base;
before(async () => {
  ({ base } = await startServer(serverEnv(home, await freePort())));
});

const marks = (tools) => Object.fromEntries(tools.map((t) => [t.name, [t.source, t.inline === true]]));
const builtIn = Object.fromEntries(SEVEN.map((name) => [name, ["built in", false]]));

test("Settings → Tools lists the seven as built in, each once, whatever the catalogue was written from", async () => {
  const { tools } = await (await fetch(`${base}/api/tools`)).json();
  assert.deepEqual(marks(tools), { ...builtIn, web_search: ["pi-web-access", false] });
  assert.equal(tools.length, 8);
});

test("a chat that has not started lists them as built in too", async () => {
  const { tools } = await sessions.getTools("idle");
  assert.deepEqual(marks(tools), { ...builtIn, web_search: ["pi-web-access", false] });
});

test("a default off for bash is one for the tool, and the list keeps it in the Built-in box", async () => {
  const put = await fetch(`${base}/api/tools`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ off: ["bash"] }) });
  assert.equal(put.status, 200);
  const { tools, off } = await (await fetch(`${base}/api/tools`)).json();
  assert.deepEqual(off, ["bash"]);
  assert.deepEqual(tools.filter((t) => !t.defaultOn).map((t) => [t.name, t.source]), [["bash", "built in"]]);
  // And an idle chat follows it, so a chat started with a device has bash off from its first message.
  assert.deepEqual((await sessions.getTools("idle")).tools.filter((t) => !t.enabled).map((t) => t.name), ["bash"]);
});

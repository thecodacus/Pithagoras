import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import express from "express";
import { fakeModel } from "./fake-model.mjs";
import { inProcessHome } from "./server-harness.mjs";

/**
 * The seven file and shell tools stay pi's own in every list of tools, also in a chat that was granted
 * a device. The grant registers them again as the devices extension's (`<inline:devices>`), and what
 * a chat reports of them was filed under "devices" in the catalogue behind Settings → Tools, in place
 * of the Built-in box. Against pi as the portal's own client runs it.
 */
const home = inProcessHome("pithagoras-devices-tools-");
process.env.PORTAL_PASSWORD = "a-long-enough-password";

const model = await fakeModel(() => "Done.");
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(model.models()));

const { SdkPiClient } = await import("../dist/pi/sdk-client.js");
const { pairRouter } = await import("../dist/sync/pair.js");
const { attachSyncUpgrade, linkOf, dropDevice } = await import("../dist/sync/hub.js");
const store = await import("../dist/sync/store.js");
const grants = await import("../dist/sync/grants.js");
const db = await import("../dist/db.js");
const { connect, until } = await import("./fake-device.mjs");

const SEVEN = ["bash", "edit", "find", "grep", "ls", "read", "write"];

let server;
let base;
let deviceId;
before(async () => {
  const app = express();
  app.use(pairRouter());
  server = http.createServer(app);
  attachSyncUpgrade(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `127.0.0.1:${server.address().port}`;
  store.setDevicesEnabled(true);
  const { code } = store.newPairingCode();
  const paired = await fetch(`http://${base}/sync/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "laptop", os: "linux", arch: "x86_64" }) }).then((r) => r.json());
  deviceId = paired.device_id;
  await connect(base, paired.connector_token, {});
  await until(() => linkOf(deviceId)?.info, "the device");
});
after(() => {
  for (const d of store.listDevices()) dropDevice(d.id);
  server.closeAllConnections();
  server.close();
});

let chats = 0;
/** A pi session as the portal starts one for a chat; granted a device first when asked. */
async function start({ granted, toolsOff = [] }) {
  const id = `chat-${++chats}`;
  const cwd = mkdtempSync(path.join(process.env.WORKSPACE_ROOT, "chat-"));
  db.createSession({ id, title: id, workspace: cwd, executor: "host", kind: "task" });
  if (granted) grants.grantDevice(id, deviceId, "/home/alice/src");
  return SdkPiClient.create({ cwd, sessionDir: mkdtempSync(path.join(home, "pi-")), provider: "fake", modelId: "m", sessionId: id, devices: true, toolsOff });
}

const seven = (tools) => tools.filter((t) => SEVEN.includes(t.name)).sort((a, b) => a.name.localeCompare(b.name));
const catalogue = () => db.knownTools().filter((t) => SEVEN.includes(t.name));

test("a chat with a device lists the seven tools as built in, and the catalogue keeps them there", async () => {
  const client = await start({ granted: true });
  try {
    // The grant did register them again: the devices extension's, with a device parameter.
    const live = client.session.getAllTools().find((t) => t.name === "bash");
    assert.equal(live.sourceInfo.path, "<inline:devices>");
    assert.ok(live.parameters.properties.device, "bash takes a device");

    const tools = await client.getTools();
    assert.deepEqual(seven(tools).map((t) => t.name), SEVEN, "grep, find and ls are active in a granted chat");
    for (const tool of seven(tools)) {
      assert.equal(tool.source, "built in", `${tool.name} is pi's own tool`);
      assert.equal(tool.inline, undefined, `${tool.name} is not one of the portal's own extension's tools`);
    }
    // Nothing is filed under the devices extension.
    assert.deepEqual(tools.filter((t) => t.source === "devices"), []);

    db.rememberTools(tools.map(db.remembered));
    for (const tool of catalogue()) {
      assert.equal(tool.source, "built in", tool.name);
      assert.notEqual(tool.inline, true, tool.name);
    }
    assert.deepEqual(catalogue().map((t) => t.name), SEVEN);
    // What Settings → Tools and a project's list are given.
    assert.deepEqual(db.shownTools().filter((t) => SEVEN.includes(t.name)).map((t) => [t.name, t.source, t.inline]), SEVEN.map((name) => [name, "built in", undefined]));
  } finally {
    client.dispose();
  }
});

test("a chat that had no device before and one that has: the same seven entries, never twice or under another source", async () => {
  const plain = await start({ granted: false });
  try {
    db.rememberTools((await plain.getTools()).map(db.remembered));
  } finally {
    plain.dispose();
  }
  const before = catalogue();
  assert.ok(before.every((t) => t.source === "built in"), "pi's own, from a chat without a device");
  const granted = await start({ granted: true });
  try {
    db.rememberTools((await granted.getTools()).map(db.remembered));
  } finally {
    granted.dispose();
  }
  const after = catalogue();
  assert.equal(after.length, new Set(after.map((t) => t.name)).size);
  assert.deepEqual(after.filter((t) => before.some((b) => b.name === t.name)).map((t) => [t.name, t.source, t.package, t.inline]), before.map((t) => [t.name, t.source, t.package, t.inline]));
  assert.ok(after.every((t) => t.source === "built in"));
});

test("a catalogue that holds the seven under the devices extension, as a portal that ran with a device has it, reads as built in and is mended", () => {
  const entry = (name) => ({ name, source: "devices", description: `The ${name} tool`, package: null, inline: true });
  db.putSetting("tools_seen", JSON.stringify([...SEVEN.map(entry), { name: "web_search", source: "pi-web-access", package: null, inline: false }]));
  // The entries are left as they were stored; what is read is built in.
  for (const tool of catalogue()) {
    assert.equal(tool.source, "built in", tool.name);
    assert.equal(tool.package, null, tool.name);
    assert.equal(tool.inline, false, tool.name);
    assert.equal(tool.description, `The ${tool.name} tool`, "what the tool says it does is kept");
  }
  assert.equal(db.knownTools().find((t) => t.name === "web_search").source, "pi-web-access");
  const shown = db.shownTools();
  assert.deepEqual(shown.filter((t) => SEVEN.includes(t.name)).map((t) => [t.name, t.source, t.inline]), SEVEN.map((name) => [name, "built in", undefined]));
  assert.deepEqual(shown.filter((t) => t.source === "devices"), []);

  // And written back right with the next report, whichever way that reports them.
  db.rememberTools([{ name: "read", source: "devices", package: null, inline: true }]);
  const stored = JSON.parse(db.getSetting("tools_seen"));
  for (const name of SEVEN) assert.equal(stored.find((t) => t.name === name).source, "built in", name);
});

test("a tool of one of the seven names that another extension owns keeps its own source", () => {
  db.putSetting("tools_seen", JSON.stringify([]));
  db.rememberTools([
    { name: "ls", source: "my-files", package: null, inline: false },
    // A loose extension file called devices.ts is not the portal's devices extension.
    { name: "find", source: "devices", package: null, inline: false },
  ]);
  assert.deepEqual(db.knownTools().map((t) => [t.name, t.source]), [["find", "devices"], ["ls", "my-files"]]);
});

test("switching bash or read off in the tool defaults takes the device variant out of a chat too, now and after a reload", async () => {
  const client = await start({ granted: true, toolsOff: ["bash", "read"] });
  try {
    const active = () => client.session.getActiveToolNames();
    assert.ok(!active().includes("bash") && !active().includes("read"), "off from the start");
    assert.ok(active().includes("write") && active().includes("grep"));
    // Still listed, and as off: a switch that is not shown cannot be switched back on.
    const listed = await client.getTools();
    assert.deepEqual(seven(listed).filter((t) => !t.enabled).map((t) => t.name), ["bash", "read"]);
    assert.deepEqual([...new Set(seven(listed).map((t) => t.source))], ["built in"]);
    assert.deepEqual(listed.filter((t) => t.name === "bash").length, 1, "once");

    await client.reload();
    assert.ok(!active().includes("bash") && !active().includes("read"), "off after a reload");
    assert.ok(active().includes("write"));

    await client.setToolsOff(["write", "ls"]);
    assert.ok(active().includes("bash") && active().includes("read"), "on again");
    assert.ok(!active().includes("write") && !active().includes("ls"));
    await client.reload();
    assert.ok(!active().includes("write") && !active().includes("ls"), "off after a reload");
    assert.ok(active().includes("bash"));
  } finally {
    client.dispose();
  }
});

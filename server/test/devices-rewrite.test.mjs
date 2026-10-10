import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import express from "express";
import { inProcessHome } from "./server-harness.mjs";

/**
 * A command for a device reaches the device as the model wrote it, in a real pi session, while another extension rewrites the
 * `bash` calls on `tool_call` (as a command optimiser that puts `rtk` in front does, after checking for rtk on the portal): the
 * device's bash has pi's tool name, so the rewrite is made on its calls too. The portal's own bash stays rewritable.
 */
const home = inProcessHome("pithagoras-rewrite-");
process.env.PORTAL_PASSWORD = "a-long-enough-password";

const pi = await import("@earendil-works/pi-coding-agent");
// pi-ai's faux provider: pi's own dependency, which its package does not re-export.
const piAi = await import(new URL("node_modules/@earendil-works/pi-ai/dist/index.js", new URL("../", import.meta.resolve("@earendil-works/pi-coding-agent"))).href).catch(() => import("@earendil-works/pi-ai"));
const { pairRouter } = await import("../dist/sync/pair.js");
const { attachSyncUpgrade, linkOf, dropDevice } = await import("../dist/sync/hub.js");
const store = await import("../dist/sync/store.js");
const grants = await import("../dist/sync/grants.js");
const { deviceTools } = await import("../dist/sync/tools.js");
const { createSession } = await import("../dist/db.js");
const { FRAME } = await import("../dist/sync/protocol.js");
const { connect: connectTo, until, INFO } = await import("./fake-device.mjs");

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use(pairRouter());
  server = http.createServer(app);
  attachSyncUpgrade(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `127.0.0.1:${server.address().port}`;
  store.setDevicesEnabled(true);
});
after(() => {
  for (const d of store.listDevices()) dropDevice(d.id);
  server.closeAllConnections();
  server.close();
});

async function online(name, answers) {
  const { code } = store.newPairingCode();
  const r = await fetch(`http://${base}/sync/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name, os: "linux", arch: "x86_64" }) }).then((x) => x.json());
  const { device } = await connectTo(base, r.connector_token, { answers: { "device.info": { ...INFO, name }, ...answers } });
  await until(() => linkOf(r.device_id)?.info && linkOf(r.device_id).sameMachine !== undefined, "the device's info");
  return { id: r.device_id, device };
}

/** Another extension's `tool_call` hook on `bash`, in the shape of the optimiser's: it changes `event.input.command` in place. */
const optimiser = (api) => {
  api.on("tool_call", (event) => {
    if (!pi.isToolCallEventType("bash", event)) return {};
    event.input.command = `echo optimised; ${event.input.command}`;
    return {};
  });
};

/** A real pi session of the chat, with the faux model answering `responses`, and the device tools of the portal (and the optimiser first, if asked). */
async function runSession(sessionId, id, responses, { optimise = false } = {}) {
  createSession({ id: sessionId, title: sessionId, workspace: home, executor: "host", kind: "task" });
  grants.grantDevice(sessionId, id, "/home/alice/src");
  const faux = piAi.fauxProvider({});
  faux.setResponses(responses);
  const modelRuntime = await pi.ModelRuntime.create();
  modelRuntime.registerNativeProvider(faux.provider);
  const { provider, id: modelId } = faux.getModel();
  const loader = new pi.DefaultResourceLoader({
    cwd: home,
    agentDir: process.env.PI_CODING_AGENT_DIR,
    noExtensions: true,
    // The optimiser first, as a package's extensions are loaded before the portal's own.
    extensionFactories: [
      ...(optimise ? [{ name: "optimiser", factory: optimiser }] : []),
      { name: "devices", factory: deviceTools({ sessionId, cwd: home, pi, serverTool: () => undefined }) },
    ],
  });
  await loader.reload();
  const { session } = await pi.createAgentSession({
    cwd: home,
    agentDir: process.env.PI_CODING_AGENT_DIR,
    sessionManager: pi.SessionManager.inMemory(home),
    modelRuntime,
    resourceLoader: loader,
    model: modelRuntime.getModel(provider, modelId),
  });
  const results = [];
  session.subscribe((e) => e.type === "tool_execution_end" && results.push(e));
  await session.prompt("go");
  return results;
}

const calls = (...c) => piAi.fauxAssistantMessage(c.map(([args, i]) => piAi.fauxToolCall("bash", args, { id: i })));

/** A device that runs a command: it answers with one line of output naming it. */
const runner = (name) =>
  online(name, {
    "exec.start": (params, _id, d) => {
      setTimeout(() => {
        d.frame(FRAME.execOutput, params.stream, 0, "on the device\n");
        d.notify("exec.exit", { stream: params.stream, code: 0, signal: null, timed_out: false, truncated: false });
      }, 5);
      return {};
    },
  });

test("a command for a device is run there as the model wrote it, and a command for the server can still be rewritten", async () => {
  const { id, device } = await runner("laptop");
  const results = await runSession(
    "rewrite-chat",
    id,
    [
      // Two calls at once, one for the device and one for the server, then a call for the device alone.
      calls([{ command: "git status | head -3", device: "laptop" }, "d1"], [{ command: "echo on the server" }, "s1"]),
      calls([{ command: "ls -la", device: "laptop", timeout: 30 }, "d2"]),
      piAi.fauxAssistantMessage("done"),
    ],
    { optimise: true },
  );

  const ran = device.asked("exec.start").map((m) => m.params.command);
  assert.deepEqual(ran, ["git status | head -3", "ls -la"]);
  assert.equal(device.asked("exec.start")[1].params.timeout_ms, 30_000, "the other params are the call's own");
  const server = results.find((r) => r.toolCallId === "s1");
  assert.match(JSON.stringify(server.result), /optimised/, "the portal's own bash is rewritten as before");
  assert.match(JSON.stringify(results.find((r) => r.toolCallId === "d1").result), /on the device/);
});

test("calls of one message that share an id each run their own command: the id says which command only when it is the one", async () => {
  const { id, device } = await runner("twin");
  // A provider that sends no ids, or repeats one: pi keeps the calls apart by their place, and both are called "dup".
  await runSession("twin-chat", id, [
    calls([{ command: "echo FIRST", device: "twin" }, "dup"], [{ command: "echo SECOND", device: "twin" }, "dup"]),
    // One for the server and one for the device: the device never runs the server's.
    calls([{ command: "echo meant-for-the-server" }, "dup"], [{ command: "echo meant-for-the-device", device: "twin" }, "dup"]),
    piAi.fauxAssistantMessage("done"),
  ]);
  const ran = device.asked("exec.start").map((m) => m.params.command).sort();
  assert.deepEqual(ran, ["echo FIRST", "echo SECOND", "echo meant-for-the-device"]);

  // And with the optimiser that rewrites everything: what runs is then the rewrite of each call's own command, never another's.
  const { id: other, device: second } = await runner("twin-rewritten");
  await runSession(
    "twin-rewritten-chat",
    other,
    [calls([{ command: "echo FIRST", device: "twin-rewritten" }, "dup"], [{ command: "echo SECOND", device: "twin-rewritten" }, "dup"]), piAi.fauxAssistantMessage("done")],
    { optimise: true },
  );
  assert.deepEqual(second.asked("exec.start").map((m) => m.params.command).sort(), ["echo optimised; echo FIRST", "echo optimised; echo SECOND"]);
});

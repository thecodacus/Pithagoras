import { test, before } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { freePort, serverEnv, startServer, testHome } from "./server-harness.mjs";

/**
 * The Devices add-on in the whole server, as it is deployed: the switch, the
 * routes behind the login, and the two sync routes in front of it, which a
 * device reaches with its code or token and nothing else.
 */
const PASSWORD = "correct horse battery";
let base;
let open;
before(async () => {
  ({ base } = await startServer(serverEnv(testHome("pithagoras-devices-api-"), await freePort(), { PORTAL_PASSWORD: PASSWORD, PORTAL_ALLOW_NO_PASSWORD: "" })));
  ({ base: open } = await startServer(serverEnv(testHome("pithagoras-devices-open-"), await freePort())));
});

let cookie;
async function api(route, { method = "GET", body, as = cookie, at = base } = {}) {
  const res = await fetch(at + route, { method, headers: { ...(as ? { Cookie: as } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}

const ws = (path) => base.replace("http", "ws") + path;

/** A device that connects with its token, says hello and answers what the portal asks. */
function device(token, answers = {}) {
  return new Promise((resolve) => {
    const sock = new WebSocket(ws("/sync/v1/connect"), { headers: { Authorization: `Bearer ${token}` }, perMessageDeflate: false });
    const got = [];
    sock.on("unexpected-response", (_req, res) => resolve({ status: res.statusCode }));
    sock.on("error", () => {});
    const closed = new Promise((r) => sock.on("close", (code) => r(code)));
    sock.on("message", (data, isBinary) => {
      if (isBinary) return;
      const m = JSON.parse(String(data));
      got.push(m);
      const all = {
        "device.info": { name: "laptop", os: "linux", arch: "x86_64", os_release: null, hostname: "laptop", user: "alice", uid: 4242, home: "/home/alice", shell: "bash", session: "headless", mode: "ask", mode_expires_ms: null, folders: [], folders_shell: "landlock", tools: ["read", "bash"], mcp_tools: [], client_version: "0.1.0" },
        "device.probe": { found: false, sha256: null, user: "alice", uid: 4242 },
        "approval.list": { approvals: [{ id: 3, call: 1, chat: "c1", tool: "exec", target: "make", reasons: ["Ask mode"], preview: null, choices: ["once", "chat", "time", "deny"], max_minutes: 480, created_ms: 1, expires_ms: 2 }] },
        "policy.get": { portal_policy: "read", version: "v1", settings: { policy: { mode: "ask" }, exec: {} }, device_only: ["allow_root"] },
        "approval.answer": {},
        ...answers,
      };
      if (m.id !== undefined && m.method in all) {
        const a = all[m.method];
        sock.send(JSON.stringify(a.error ? { jsonrpc: "2.0", id: m.id, error: a.error } : { jsonrpc: "2.0", id: m.id, result: a }));
      }
    });
    sock.on("open", () => {
      sock.send(JSON.stringify({ jsonrpc: "2.0", method: "hello", params: { proto: 1, device_id: token.split(".")[0], client_version: "0.1.0", os: "linux", user: "alice", shell: "bash", capabilities: ["fs", "exec", "probe", "approvals", "policy"] } }));
      resolve({ status: 101, sock, got, closed });
    });
  });
}

const until = async (check, what) => {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`waited in vain for ${what}`);
};

test("a portal without a password cannot switch devices on", async () => {
  const flags = await api("/api/features/devices", { at: open, as: null });
  assert.equal(flags.body.enabled, false);
  assert.match(flags.body.refused, /PORTAL_PASSWORD/);
  assert.equal((await api("/api/features/devices", { at: open, as: null, method: "PUT", body: { enabled: true } })).status, 409);
  assert.equal((await api("/api/features/flags", { at: open, as: null })).body.devices.enabled, false);
});

test("the add-on is off at first, and its routes and the sync routes answer nothing until it is on", async () => {
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = login.headers.getSetCookie()[0].split(";")[0];
  assert.equal((await api("/api/features/flags")).body.devices.enabled, false);
  assert.equal((await api("/api/devices")).status, 404);
  assert.equal((await api("/sync/v1/pair", { as: null, method: "POST", body: { code: "ABCDEFGH", name: "x", os: "linux", arch: "x86_64" } })).status, 404);
  assert.equal((await device("d0000000000000000.xxxxxxxxxxxxxxxxxxxx")).status, 503);
  // Behind the login, the switch and the page alike.
  assert.equal((await api("/api/features/devices", { as: null, method: "PUT", body: { enabled: true } })).status, 401);
  assert.equal((await api("/api/devices", { as: null })).status, 401);
  assert.equal((await api("/api/features/devices", { method: "PUT", body: { enabled: true } })).body.enabled, true);
  assert.equal((await api("/api/features/flags")).body.devices.enabled, true);
});

test("pairing, the list, rename, approvals, settings, and removal that cuts the device off", async () => {
  assert.equal((await api("/api/devices/pair", { as: null, method: "POST" })).status, 401);
  const code = await api("/api/devices/pair", { method: "POST" });
  assert.equal(code.status, 200);
  assert.match(code.body.code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(code.headers.get("cache-control"), "no-store");
  assert.equal(code.body.spki, null, "plain HTTP: nothing to pin");
  assert.ok((await api("/api/devices")).body.pairing.expires);
  // The code is the device's login: the pair route is in front of the portal's.
  const paired = await api("/sync/v1/pair", { as: null, method: "POST", body: { code: code.body.code, name: "laptop", os: "linux", arch: "x86_64" } });
  assert.equal(paired.status, 200);
  assert.equal((await api("/api/devices")).body.pairing, null);
  const { device_id: id, connector_token: token } = paired.body;

  // The portal's upgrade listener for the browser leaves the sync path to the hub.
  const dev = await device(token);
  assert.equal(dev.status, 101);
  await until(async () => (await api("/api/devices")).body.devices[0]?.policy, "the device's settings");
  const [shown] = (await api("/api/devices")).body.devices;
  assert.equal(shown.online, true);
  assert.equal(shown.info.mode, "ask");
  assert.equal(shown.sameMachine, false);
  assert.equal(shown.hello.clientVersion, "0.1.0");
  assert.deepEqual(shown.approvals.map((a) => a.id), [3]);
  assert.equal(shown.policy.portal_policy, "read");
  assert.equal(shown.token_hash, undefined);
  assert.ok(!JSON.stringify(shown).includes(token.split(".")[1]));

  assert.equal((await api(`/api/devices/${id}`, { method: "PUT", body: { name: "Not Valid" } })).status, 400);
  assert.equal((await api(`/api/devices/${id}`, { method: "PUT", body: { name: "desk" } })).body.device.name, "desk");

  assert.equal((await api(`/api/devices/${id}/approvals/3`, { method: "POST", body: { answer: "always", created_ms: 1 } })).status, 400);
  assert.equal((await api(`/api/devices/${id}/approvals/3`, { method: "POST", body: { answer: "time", created_ms: 1 } })).status, 400);
  // The answer names the question it was shown for: without that, for another one with the number, or for one the portal does not hold, nothing is sent.
  assert.equal((await api(`/api/devices/${id}/approvals/3`, { method: "POST", body: { answer: "once" } })).status, 400);
  assert.equal((await api(`/api/devices/${id}/approvals/3`, { method: "POST", body: { answer: "once", created_ms: 2 } })).status, 409);
  assert.equal((await api(`/api/devices/${id}/approvals/99`, { method: "POST", body: { answer: "once", created_ms: 1 } })).status, 409);
  assert.deepEqual(dev.got.filter((m) => m.method === "approval.answer"), []);
  assert.equal((await api(`/api/devices/${id}/approvals/3`, { method: "POST", body: { answer: "time", minutes: 30, created_ms: 1 } })).status, 200);
  assert.deepEqual(dev.got.find((m) => m.method === "approval.answer").params, { id: 3, answer: "time", minutes: 30 });

  assert.equal((await api(`/api/devices/${id}/policy`)).body.policy.version, "v1");
  // The device decides whether the portal may change its settings; its refusal comes back as one.
  dev.sock.close(1000);
  await dev.closed;
  await until(async () => !(await api("/api/devices")).body.devices[0].online, "offline");
  const refusing = await device(token, { "policy.set": { error: { code: -32001, message: "portal_policy is read" } } });
  await until(async () => (await api("/api/devices")).body.devices[0]?.online, "online");
  const set = await api(`/api/devices/${id}/policy`, { method: "PUT", body: { settings: { policy: { mode: "full" } }, ifVersion: "v1" } });
  assert.equal(set.status, 403);
  assert.match(set.body.error, /portal_policy is read/);
  assert.deepEqual(refusing.got.find((m) => m.method === "policy.set").params, { settings: { policy: { mode: "full" } }, if_version: "v1" });

  assert.equal((await api(`/api/devices/${id}`, { method: "DELETE" })).status, 200);
  assert.equal(await refusing.closed, 4001);
  assert.equal((await device(token)).status, 401);
  assert.deepEqual((await api("/api/devices")).body.devices, []);
});

test("a device's settings that are too deep to be written out are not kept, and the device list answers", async () => {
  const code = (await api("/api/devices/pair", { method: "POST" })).body.code;
  const { device_id: id, connector_token: token } = (await api("/sync/v1/pair", { as: null, method: "POST", body: { code, name: "deep", os: "linux", arch: "x86_64" } })).body;
  const dev = await device(token);
  await until(async () => (await api("/api/devices")).body.devices[0]?.policy, "the device's settings");
  // 5,000 levels in 10 KB: JSON.stringify cannot write that on Node 22, which is what the image runs. As text, as the test could not write it either.
  const deep = (version) => `{"jsonrpc":"2.0","method":"policy.changed","params":{"portal_policy":"read","version":"${version}","settings":{"x":${"[".repeat(5000)}${"]".repeat(5000)}},"device_only":[]}}`;
  dev.sock.send(deep("deep"));
  // The portal has read it once it has the device's answer to a call that comes after it (not one that asks for the settings anew).
  assert.equal((await api(`/api/devices/${id}/approvals/3`, { method: "POST", body: { answer: "deny", created_ms: 1 } })).status, 200);
  const list = await api("/api/devices");
  assert.equal(list.status, 200);
  assert.equal(list.body.devices[0].policy.version, "v1", "the settings it had before");
  dev.sock.close(1000);
  await dev.closed;
  assert.equal((await api(`/api/devices/${id}`, { method: "DELETE" })).status, 200);
});

test("switching the add-on off drops connected devices and the open code", async () => {
  const code = (await api("/api/devices/pair", { method: "POST" })).body.code;
  const { connector_token: token } = (await api("/sync/v1/pair", { as: null, method: "POST", body: { code, name: "box", os: "linux", arch: "x86_64" } })).body;
  const dev = await device(token);
  await until(async () => (await api("/api/devices")).body.devices[0]?.online, "online");
  await api("/api/devices/pair", { method: "POST" });
  assert.equal((await api("/api/features/devices", { method: "PUT", body: { enabled: false } })).body.enabled, false);
  assert.equal(await dev.closed, 1001);
  assert.equal((await device(token)).status, 503);
  // The device stays paired: on again, it connects with the same token, and the old code is gone.
  await api("/api/features/devices", { method: "PUT", body: { enabled: true } });
  assert.equal((await api("/api/devices")).body.pairing, null);
  const back = await device(token);
  assert.equal(back.status, 101);
  back.sock.close(1000);
});

test("a switch left on does not outlast the password: without one the add-on answers nothing, and with it again the paired devices are still there", async () => {
  const home = testHome("pithagoras-devices-restart-");
  const env = (overrides) => serverEnv(home, 0, overrides);
  const withPassword = { PORTAL_PASSWORD: PASSWORD, PORTAL_ALLOW_NO_PASSWORD: "" };
  const signIn = async (at) => (await fetch(`${at}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) })).headers.getSetCookie()[0].split(";")[0];

  // With a password: switched on, and one device paired.
  const first = await startServer({ ...env(withPassword), PORT: String(await freePort()) });
  const as = await signIn(first.base);
  assert.equal((await api("/api/features/devices", { at: first.base, as, method: "PUT", body: { enabled: true } })).body.enabled, true);
  const code = (await api("/api/devices/pair", { at: first.base, as, method: "POST" })).body.code;
  const paired = await api("/sync/v1/pair", { at: first.base, as: null, method: "POST", body: { code, name: "desk", os: "linux", arch: "x86_64" } });
  assert.equal(paired.status, 200);
  first.child.kill();
  await once(first.child, "exit");

  // Restarted without one (PORTAL_ALLOW_NO_PASSWORD): the switch is still on, and nothing answers.
  const open = await startServer({ ...env({}), PORT: String(await freePort()) });
  const feature = (await api("/api/features/devices", { at: open.base, as: null })).body;
  assert.deepEqual({ enabled: feature.enabled, switchedOn: feature.switchedOn }, { enabled: false, switchedOn: true });
  assert.match(feature.refused, /PORTAL_PASSWORD/);
  assert.equal((await api("/api/features/flags", { at: open.base, as: null })).body.devices.enabled, false);
  const list = await api("/api/devices", { at: open.base, as: null });
  assert.equal(list.status, 404);
  assert.match(list.body.error, /without a password/);
  assert.equal((await api("/api/devices/pair", { at: open.base, as: null, method: "POST" })).status, 404);
  assert.equal((await api("/sync/v1/pair", { at: open.base, as: null, method: "POST", body: { code: "ABCDEFGH", name: "x", os: "linux", arch: "x86_64" } })).status, 404);
  const sock = new WebSocket(open.base.replace("http", "ws") + "/sync/v1/connect", { headers: { Authorization: `Bearer ${paired.body.connector_token}` } });
  sock.on("error", () => {});
  assert.equal(await new Promise((r) => sock.on("unexpected-response", (_req, res) => r(res.statusCode))), 503);
  assert.equal((await api("/api/features/devices", { at: open.base, as: null, method: "PUT", body: { enabled: true } })).status, 409);
  open.child.kill();
  await once(open.child, "exit");

  // With a password again: on without anybody switching it, and the device is paired as before.
  const back = await startServer({ ...env(withPassword), PORT: String(await freePort()) });
  const again = await signIn(back.base);
  assert.equal((await api("/api/features/devices", { at: back.base, as: again })).body.enabled, true);
  assert.deepEqual((await api("/api/devices", { at: back.base, as: again })).body.devices.map((d) => d.name), ["desk"]);
});

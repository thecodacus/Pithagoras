import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { ENTRY, freePort, inProcessHome, runToEnd, serverEnv, startServer, testHome } from "./server-harness.mjs";

/**
 * The login: who gets past it, and what one cookie is worth. Every other test of
 * the server runs without a password; this one runs with it, in front of the
 * API and in front of the agent's browser, which the portal proxies and signs
 * into for whoever it let in.
 */
const PASSWORD = "correct horse battery";
const SECRET = "a-fixed-secret-for-the-tests";
const home = testHome("pithagoras-auth-");
const BROWSER_PASSWORD = "the-browsers-own-password";

// The same login in this process, to make the cookies a server would not hand
// out: one that has run out.
inProcessHome("pithagoras-auth-in-process-");
process.env.PORTAL_PASSWORD = PASSWORD;
process.env.PORTAL_SECRET = SECRET;
const auth = await import("../dist/auth.js");
const security = await import("../dist/http-security.js");

/** What `issueCookie` sets, taken from a response that is only listening. */
function issued({ secure = false } = {}) {
  let cookie;
  auth.issueCookie({ cookie: (name, value, options) => { cookie = { name, value, options }; }, req: { secure } });
  return cookie;
}

// --- the browser, stood in for: an https server of its own, as the container is ---

const tls = path.join(home, "tls");
mkdirSync(tls);
execFileSync("openssl", [
  "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-subj", "/CN=127.0.0.1",
  "-days", "1", "-keyout", path.join(tls, "key.pem"), "-out", path.join(tls, "cert.pem"),
], { stdio: "ignore" });
const cert = { key: readFileSync(path.join(tls, "key.pem")), cert: readFileSync(path.join(tls, "cert.pem")) };

/** What the stand-in browser was asked, and what it does with an upgrade. */
const browser = { requests: [], upgrades: [], received: "", mode: "accept", release: undefined, socketClosed: undefined };
const upstream = https.createServer(cert, (req, res) => {
  browser.requests.push({ url: req.url, headers: req.headers });
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("the desktop");
});
upstream.on("upgrade", async (req, socket, head) => {
  browser.upgrades.push({ url: req.url, headers: req.headers });
  socket.on("error", () => {});
  browser.socketClosed = new Promise((resolve) => socket.on("close", resolve));
  if (browser.mode === "refuse") return void socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
  if (browser.mode === "slow") await new Promise((resolve) => { browser.release = resolve; });
  browser.received = head.toString();
  socket.on("data", (d) => { browser.received += d; });
  // The greeting follows the headers at once, as a VNC server's does.
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nRFB 003.008\n");
});
const upstreamPort = await freePort();
upstream.listen(upstreamPort, "127.0.0.1");

let base;
let port;
let server;
before(async () => {
  ({ base, child: server, port } = await startServer(serverEnv(home, await freePort(), {
    PORTAL_PASSWORD: PASSWORD, PORTAL_ALLOW_NO_PASSWORD: "", PORTAL_SECRET: SECRET,
    BROWSER_HTTPS_PORT: String(upstreamPort), BROWSER_USER: "agent", BROWSER_PASSWORD,
  })));
});
after(() => upstream.close());

const login = (password = PASSWORD, at = base) =>
  fetch(`${at}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
/** The cookie a login set, as a request header. */
const cookieOf = (res) => (res.headers.getSetCookie()[0] ?? "").split(";")[0];
const signedIn = async () => cookieOf(await login());
const api = (cookie, route = "/api/settings") => fetch(base + route, { headers: cookie ? { Cookie: cookie } : {} });

// --- the API ---

test("what is behind the login answers 401 without it, and the 404 for a route that is not there comes after the login", async () => {
  assert.equal((await api(undefined, "/api/settings")).status, 401);
  assert.equal((await api(undefined, "/api/sessions")).status, 401);
  assert.equal((await api(undefined, "/api/browser")).status, 401);
  assert.equal((await api(undefined, "/api/no-such-route")).status, 401);
  const status = await (await api(undefined, "/api/auth/status")).json();
  assert.deepEqual(status, { authRequired: true, authed: false });
});

test("a wrong password gets no cookie, and the right one gets a cookie that works", async () => {
  const wrong = await login("not the password");
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.getSetCookie().length, 0);

  const right = await login();
  assert.equal(right.status, 200);
  const [set] = right.headers.getSetCookie();
  assert.match(set, /HttpOnly/i);
  assert.match(set, /SameSite=Lax/i);
  assert.doesNotMatch(set, /Secure/i, "plain HTTP: a Secure cookie would never be stored");
  const cookie = cookieOf(right);
  assert.equal((await api(cookie)).status, 200);
  assert.deepEqual(await (await api(cookie, "/api/auth/status")).json(), { authRequired: true, authed: true });
});

test("a cookie with a flipped signature, a stamp that has run out or another login's signature is refused", async () => {
  const [name, value] = (await signedIn()).split("=");
  const [expiry, mac] = value.split(".");
  const flipped = `${mac.slice(0, -1)}${mac.endsWith("0") ? "1" : "0"}`;
  assert.equal((await api(`${name}=${expiry}.${flipped}`)).status, 401, "flipped signature");
  assert.equal((await api(`${name}=${Number(expiry) + 1000}.${mac}`)).status, 401, "a later stamp than the one signed");
  assert.equal((await api(`${name}=${expiry}`)).status, 401, "no signature");
  assert.equal((await api(`${name}=garbage`)).status, 401);

  // One that was good once: made 31 days ago, so it has run out by now.
  const past = Date.now() - 31 * 24 * 60 * 60 * 1000;
  const clock = mock.method(Date, "now", () => past);
  const old = issued();
  clock.mock.restore();
  assert.equal((await api(`${old.name}=${old.value}`)).status, 401, "run out");
  const fresh = issued();
  assert.equal((await api(`${fresh.name}=${fresh.value}`)).status, 200, "the same login, made now");
});

test("signing out refuses the login it ended, also a copy of its cookie", async () => {
  const cookie = await signedIn();
  assert.equal((await api(cookie)).status, 200);
  const out = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie } });
  assert.equal(out.status, 200);
  assert.equal((await api(cookie)).status, 401, "the copy taken before");
  assert.equal((await api(await signedIn())).status, 200, "a new login is another one");
});

test("changing the password ends the logins made under the old one", async () => {
  const cookie = await signedIn();
  const other = testHome("pithagoras-auth-other-");
  let otherPort = await freePort();
  const env = (extra) => serverEnv(other, otherPort, { PORTAL_ALLOW_NO_PASSWORD: "", PORTAL_SECRET: SECRET, PORTAL_PASSWORD: PASSWORD, ...extra });
  const { child, base: there, port: took } = await startServer(env({ PORTAL_PASSWORD: "another long password" }));
  // The restarts below are on the port it took.
  otherPort = took;
  assert.equal((await fetch(`${there}/api/settings`, { headers: { Cookie: cookie } })).status, 401, "same secret, new password");
  child.kill();
  await new Promise((resolve) => child.once("exit", resolve));

  // A restart that changes nothing keeps everybody signed in.
  const again = await startServer(env({}));
  assert.equal((await fetch(`${there}/api/settings`, { headers: { Cookie: cookie } })).status, 200, "same secret and password");
  again.child.kill();
  await new Promise((resolve) => again.child.once("exit", resolve));

  const elsewhere = await startServer(env({ PORTAL_SECRET: "some other secret" }));
  assert.equal((await fetch(`${there}/api/settings`, { headers: { Cookie: cookie } })).status, 401, "same password, other secret");
});

test("the cookie is Secure where the portal serves TLS, and only there", () => {
  assert.equal(issued().options.secure, false);
  assert.equal(issued({ secure: true }).options.secure, true, "a request that came in over TLS");
  process.env.PORTAL_TLS_CERT = path.join(tls, "cert.pem");
  process.env.PORTAL_TLS_KEY = path.join(tls, "key.pem");
  try {
    assert.equal(issued().options.secure, true);
    let cleared;
    auth.signOut({ cookies: {} }, { clearCookie: (name, options) => { cleared = options; }, req: { secure: false } });
    assert.equal(cleared.secure, true, "clearing it has to match how it was set");
  } finally {
    delete process.env.PORTAL_TLS_CERT;
    delete process.env.PORTAL_TLS_KEY;
  }
  assert.equal(issued().options.secure, false);
});

// --- starting ---

test("the portal does not start without a password, with the example's, or with a short one", async () => {
  const start = (overrides) => runToEnd([ENTRY], serverEnv(testHome("pithagoras-auth-start-"), 0, overrides), { ms: 20_000 });
  const none = await start({ PORTAL_PASSWORD: "", PORTAL_ALLOW_NO_PASSWORD: "" });
  assert.equal(none.code, 1);
  assert.match(none.err, /PORTAL_PASSWORD is not set/);
  for (const password of ["change-me", "short", "1234567"]) {
    const refused = await start({ PORTAL_PASSWORD: password, PORTAL_ALLOW_NO_PASSWORD: "" });
    assert.equal(refused.code, 1, password);
    assert.match(refused.err, /refuses to start with one that\s+anybody could guess/, password);
  }
});

test("a secret that is a shell command, as a .env written from the old guide holds, is warned about", async () => {
  // Refused for its password, so that it ends: the warning comes before.
  const start = (secret) => runToEnd([ENTRY], serverEnv(testHome("pithagoras-auth-secret-"), 0, { PORTAL_PASSWORD: "short", PORTAL_ALLOW_NO_PASSWORD: "", PORTAL_SECRET: secret }), { ms: 20_000 });
  const copied = await start("$(openssl rand -hex 32)");
  assert.match(copied.err, /PORTAL_SECRET is a shell command/);
  const real = await start("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  assert.doesNotMatch(real.err, /PORTAL_SECRET/);
});

test("a password shorter than the minimum only stops a portal it is new to: one that ran with it keeps working, with a warning", async () => {
  const home = testHome("pithagoras-auth-kept-");
  const run = (password, port) => startServer(serverEnv(home, port, { PORTAL_PASSWORD: password, PORTAL_ALLOW_NO_PASSWORD: password ? "" : "1" }));
  const refused = (password) => runToEnd([ENTRY], serverEnv(home, 0, { PORTAL_PASSWORD: password, PORTAL_ALLOW_NO_PASSWORD: "" }), { ms: 20_000 });
  const stop = async ({ child }) => { child.kill(); await new Promise((r) => child.once("exit", r)); };
  const loggedIn = async (at, password) => {
    const res = await login(password, at);
    return (await fetch(`${at}/api/auth/status`, { headers: { Cookie: cookieOf(res) } })).json();
  };

  // An install from before the minimum: it has been used, under a password that is short.
  const before = await run("", await freePort());
  assert.equal((await fetch(`${before.base}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 200);
  await stop(before);

  const oldPassword = "oldpass";
  const kept = await run(oldPassword, await freePort());
  // Said to a login, not to whoever asks: it would name the password to guess.
  assert.deepEqual(await (await fetch(`${kept.base}/api/auth/status`)).json(), { authRequired: true, authed: false });
  assert.deepEqual(await loggedIn(kept.base, oldPassword), { authRequired: true, authed: true, shortPassword: true });
  await stop(kept);

  // Remembered, so that it is a change which stops it: another short one, even one of the same length.
  for (const password of ["newpass", "oldpas"]) assert.equal((await refused(password)).code, 1, password);
  const again = await run(oldPassword, await freePort());
  await stop(again);

  // A long one is accepted, and a return to a short one is then a change like any other.
  const long = await run("a long enough password", await freePort());
  assert.deepEqual(await loggedIn(long.base, "a long enough password"), { authRequired: true, authed: true });
  await stop(long);
  assert.equal((await refused(oldPassword)).code, 1);

  // A portal that was never used has nothing to keep.
  const fresh = await runToEnd([ENTRY], serverEnv(testHome("pithagoras-auth-new-"), 0, { PORTAL_PASSWORD: oldPassword, PORTAL_ALLOW_NO_PASSWORD: "" }), { ms: 20_000 });
  assert.equal(fresh.code, 1);
});

test("the example environment file ships no password for anyone to find", () => {
  // `cp .env.example .env` and `docker compose up` is the quick start: with a
  // password in the example, that is a portal everyone with the file can enter.
  const example = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
  const line = example.split("\n").find((l) => l.startsWith("PORTAL_PASSWORD="));
  assert.equal(line, "PORTAL_PASSWORD=");
});

// --- the login throttle ---

const attempts = (limiter, address, times) => {
  let through = 0;
  let refused = 0;
  const res = { setHeader() {}, status() { refused++; return this; }, json() {}, on() {} };
  for (let i = 0; i < times; i++) limiter({ socket: { remoteAddress: address } }, res, () => through++);
  return { through, refused };
};

test("an IPv6 /64 is one address to the throttle, and a mapped IPv4 address is the IPv4 one", () => {
  const { throttleKey } = security;
  assert.equal(throttleKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), throttleKey("2001:db8:1:2::1"));
  assert.equal(throttleKey("2001:db8:1:2::1"), throttleKey("2001:0db8:0001:0002:ffff::"));
  assert.notEqual(throttleKey("2001:db8:1:2::1"), throttleKey("2001:db8:1:3::1"));
  assert.equal(throttleKey("::1"), throttleKey("0:0:0:0:5::7"));
  assert.equal(throttleKey("::ffff:10.0.0.7"), "10.0.0.7");
  assert.equal(throttleKey("192.0.2.5"), "192.0.2.5");
  assert.equal(throttleKey(undefined), "unknown");

  // Eleven attempts, each from another address of one block: the eleventh is refused.
  const limiter = security.loginThrottle();
  const block = Array.from({ length: 11 }, (_, i) => `2001:db8:5:6:${i.toString(16)}::1`);
  const seen = block.map((address) => attempts(limiter, address, 1));
  assert.equal(seen.filter((r) => r.refused).length, 1, "the one that was one too many");
  assert.equal(attempts(limiter, "2001:db8:5:7::1", 1).through, 1, "the next block is not affected");
});

test("when the throttle is full, the oldest entry makes room and a new address still gets its attempts", () => {
  const limiter = security.loginThrottle();
  for (let i = 0; i < 4096; i++) attempts(limiter, `10.${i >> 8}.${i & 255}.1`, 1);
  // Every one of the 4096 has an attempt on record: the owner, from a 4097th
  // address, must not be locked out because of them.
  assert.deepEqual(attempts(limiter, "198.51.100.9", 1), { through: 1, refused: 0 });
  // And the first of them was the one that made room.
  assert.deepEqual(attempts(limiter, "10.0.0.1", 10), { through: 10, refused: 0 });
});

test("a locked address stays locked however many others pass through a full throttle", () => {
  const limiter = security.loginThrottle();
  const attacker = "2001:db8:0:1::1";
  assert.deepEqual(attempts(limiter, attacker, 10), { through: 10, refused: 0 });
  assert.equal(attempts(limiter, attacker, 1).refused, 1, "locked after ten");
  // 4096 other blocks fail once each: the map is full and the attacker is its oldest entry.
  for (let i = 0; i < 4096; i++) attempts(limiter, `2001:db8:1:${i.toString(16)}::1`, 1);
  assert.equal(attempts(limiter, attacker, 1).refused, 1, "evicting the lock would be ten more guesses for 4096 others");
  // The ones that failed once are what makes room, so a newcomer still gets in.
  assert.deepEqual(attempts(limiter, "198.51.100.9", 1), { through: 1, refused: 0 });
});

test("when every entry of a full throttle is locked, a newcomer is refused rather than a lock dropped", () => {
  const limiter = security.loginThrottle();
  for (let i = 0; i < 4096; i++) attempts(limiter, `10.${i >> 8}.${i & 255}.1`, 10);
  assert.equal(attempts(limiter, "198.51.100.9", 1).refused, 1);
  assert.equal(attempts(limiter, "10.0.0.1", 1).refused, 1, "and nobody's lock is gone");
});

test("addresses that stop at nine and let 4096 others push them out are held to the window's budget", () => {
  const limiter = security.loginThrottle();
  // 4097 addresses take turns, each with nine wrong logins and then out of the way: none is ever locked, and
  // each comes back to a count of nothing. Without a budget for the window every round is as free as the first.
  let through = 0;
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 4097; i++) through += attempts(limiter, `2001:db8:${(i + 1).toString(16)}::1`, 9).through;
  }
  // The window's budget, the last attempt of each one in the map at that moment, and the nine of the one that found it spent.
  assert.ok(through <= 4096 * 10 + 4096 + 9, `${through} guesses in one window`);
  // And a newcomer is told to wait, which the window's end undoes.
  assert.equal(attempts(limiter, "198.51.100.9", 1).refused, 1);
});

test("the window's budget is a fresh one when the window is over", () => {
  let clock = 1_000_000;
  const limiter = security.loginThrottle(() => clock);
  for (let i = 0; i < 4097; i++) attempts(limiter, `10.${i >> 8}.${i & 255}.1`, 9);
  for (let i = 0; i < 500; i++) attempts(limiter, `172.16.${i >> 8}.${i & 255}`, 9);
  assert.equal(attempts(limiter, "198.51.100.9", 1).refused, 1, "the budget is spent");
  clock += 15 * 60_000 + 1;
  assert.deepEqual(attempts(limiter, "198.51.100.9", 1), { through: 1, refused: 0 }, "and it is new once the window is over");
});

// --- the agent's browser ---

/** A request for the upgrade to a stream, as a browser makes it, with `after` as the bytes the page sends first. */
function upgrade(headers = {}, after = "", url = "/browser-ui/websockify") {
  const socket = net.connect(port, "127.0.0.1");
  let text = "";
  socket.on("data", (d) => { text += d; });
  // Refused and closed on is what some of these are about; the answer is what is read.
  socket.on("error", () => {});
  const lines = [
    `GET ${url} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Connection: Upgrade", "Upgrade: websocket",
    "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
  ];
  // One write, so that what follows the headers arrives with them, as it does from a browser.
  socket.write(`${lines.join("\r\n")}\r\n\r\n${after}`);
  const closed = new Promise((resolve) => socket.once("close", resolve));
  return { socket, text: () => text, closed };
}
const until = async (check, what) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.fail(`never: ${what}`);
};
const basic = (user, password) => "Basic " + Buffer.from(`${user}:${password}`).toString("base64");

test("the browser page and its stream are behind the login: nothing reaches the browser without it", async () => {
  browser.requests.length = browser.upgrades.length = 0;
  const page = await fetch(`${base}/browser-ui/`);
  assert.equal(page.status, 401);
  assert.doesNotMatch(await page.text(), /the desktop/);

  const stream = upgrade();
  await until(() => stream.text().includes("\r\n\r\n"), "an answer");
  assert.match(stream.text(), /^HTTP\/1\.1 401 /);
  stream.socket.destroy();
  const wrong = upgrade({ Cookie: `${issued().name}=9999999999999.00` });
  await until(() => wrong.text().includes("\r\n\r\n"), "an answer to a made-up cookie");
  assert.match(wrong.text(), /^HTTP\/1\.1 401 /);
  wrong.socket.destroy();

  assert.deepEqual([browser.requests.length, browser.upgrades.length], [0, 0], "the browser was never asked");
});

test("an upgrade that is not the browser's is answered and closed, not held open for whoever sent it", async () => {
  browser.upgrades.length = 0;
  // Nothing else takes upgrades, so each of these is the portal's to answer: the page, the API, and the browser's prefix in other letters.
  for (const url of ["/", "/api/sessions", "/browser-uifoo", "/BROWSER-UI/websockify"]) {
    const stream = upgrade({}, "", url);
    await until(() => stream.text().includes("\r\n\r\n"), `an answer to ${url}`);
    assert.match(stream.text(), url.startsWith("/BROWSER") ? /^HTTP\/1\.1 401 / : /^HTTP\/1\.1 404 /, url);
    // Closed from the portal's side too, with the client still connected.
    await Promise.race([stream.closed, new Promise((_, reject) => setTimeout(() => reject(new Error(`${url} was left open`)), 3000))]);
  }
  assert.equal(browser.upgrades.length, 0, "and nothing went to the browser");
});

/** Whether the server process itself still holds the connection a client opened from `clientPort`, which is what a left-open one costs it. */
function heldByServer(clientPort) {
  const hex = (n) => n.toString(16).toUpperCase().padStart(4, "0");
  let inode;
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const line of readFileSync(file, "utf8").split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length > 9 && f[1].endsWith(`:${hex(port)}`) && f[2].endsWith(`:${hex(clientPort)}`)) inode = f[9];
    }
  }
  // A connection nobody holds any more is listed with no inode: the kernel's, waiting out its own timeout.
  if (!inode || inode === "0") return false;
  return readdirSync(`/proc/${server.pid}/fd`).some((fd) => {
    try {
      return readlinkSync(`/proc/${server.pid}/fd/${fd}`) === `socket:[${inode}]`;
    } catch {
      return false;
    }
  });
}

test("clients that reset the connection while an upgrade is refused do not take the portal down", async () => {
  // Written, and reset as soon as the bytes are out: the answer the portal then writes meets a closed connection.
  const resets = [];
  for (const url of ["/", "/browser-ui/websockify", "/browser-ui/websockify"]) {
    for (let i = 0; i < 30; i++) {
      resets.push(new Promise((resolve) => {
        const socket = net.connect(port, "127.0.0.1");
        socket.on("error", () => {});
        socket.on("close", resolve);
        socket.write(
          [`GET ${url} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "", ""].join("\r\n"),
          () => socket.resetAndDestroy(),
        );
      }));
    }
  }
  await Promise.all(resets);
  // Whatever the portal did with them, it is the same portal, and it answers.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(server.exitCode, null, "the portal is still running");
  assert.equal((await fetch(`${base}/api/auth/status`)).status, 200);
});

test("a refused upgrade whose client keeps its side open is let go of after a few seconds", { skip: process.platform !== "linux" }, async () => {
  const client = net.connect({ port, host: "127.0.0.1", allowHalfOpen: true });
  let text = "";
  client.on("data", (d) => { text += d; });
  client.on("error", () => {});
  client.write([`GET /api/sessions HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "", ""].join("\r\n"));
  try {
    await until(() => text.includes("\r\n\r\n"), "an answer");
    assert.match(text, /^HTTP\/1\.1 404 /);
    // Answered and closed on the portal's side; ours is never closed. The portal has it until it gives up.
    assert.equal(heldByServer(client.localPort), true, "the portal still has the connection just after the answer");
    // It gives up after five seconds; a loaded machine may be later than that.
    for (let end = Date.now() + 20_000; heldByServer(client.localPort) && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(heldByServer(client.localPort), false, "and no longer once it has given up");
  } finally {
    client.destroy();
  }
});

test("signed in, the page is the browser's, with the browser's own login added and the portal's left out", async () => {
  browser.requests.length = 0;
  const cookie = await signedIn();
  const page = await fetch(`${base}/browser-ui/vnc.html?x=1`, { headers: { Cookie: `${cookie}; other=1`, Authorization: basic("someone", "else") } });
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "the desktop");
  assert.equal(page.headers.get("content-security-policy"), "frame-ancestors 'self'", "only the portal's own pages may frame it");
  const [seen] = browser.requests;
  assert.equal(seen.url, "/vnc.html?x=1");
  assert.equal(seen.headers.authorization, basic("agent", BROWSER_PASSWORD), "the client's own credentials are not passed on");
  assert.equal(seen.headers.cookie, undefined, "the portal's login stays with the portal");
});

test("a stream of another site's page is refused, and the one of the portal's own is passed on, each side's first bytes to the other", async () => {
  const cookie = await signedIn();
  browser.upgrades.length = 0;
  const foreign = upgrade({ Cookie: cookie, Origin: "https://elsewhere.example" });
  await until(() => foreign.text().includes("\r\n\r\n"), "an answer to another site's page");
  assert.match(foreign.text(), /^HTTP\/1\.1 403 /);
  foreign.socket.destroy();
  assert.equal(browser.upgrades.length, 0);

  browser.mode = "accept";
  const mine = upgrade({ Cookie: `${cookie}; other=1`, Origin: `http://127.0.0.1:${port}`, Authorization: basic("someone", "else") }, "client-first");
  await until(() => mine.text().includes("RFB 003.008"), "the container's greeting reaching the page");
  assert.match(mine.text(), /^HTTP\/1\.1 101 /);
  await until(() => browser.received.includes("client-first"), "the page's first bytes reaching the container");
  assert.doesNotMatch(mine.text(), /client-first/, "not sent back to where they came from");
  assert.doesNotMatch(browser.received, /RFB/, "nor the container's");
  const [seen] = browser.upgrades;
  assert.equal(seen.url, "/websockify");
  assert.equal(seen.headers.authorization, basic("agent", BROWSER_PASSWORD));
  assert.equal(seen.headers.cookie, undefined);
  mine.socket.destroy();
  await browser.socketClosed;
});

test("behind a reverse proxy that rewrites Host, the page of the host it was asked for is accepted, and another site's still is not", async () => {
  const cookie = await signedIn();
  browser.mode = "accept";
  browser.upgrades.length = 0;
  // Host is the portal's own address behind the proxy; the page's origin is what the visitor typed.
  const asked = { Cookie: cookie, "X-Forwarded-Host": "portal.example" };
  const mine = upgrade({ ...asked, Origin: "https://portal.example" });
  await until(() => mine.text().includes("RFB 003.008"), "the stream of the page behind the proxy");
  assert.match(mine.text(), /^HTTP\/1\.1 101 /);
  mine.socket.destroy();
  await browser.socketClosed;

  // The default port of the scheme is the same host, and a list of proxies names the visitor's first.
  const withPort = upgrade({ Cookie: cookie, "X-Forwarded-Host": "portal.example:443, inner.proxy:8080", Origin: "https://portal.example" });
  await until(() => withPort.text().includes("RFB 003.008"), "the stream with the port spelled out");
  withPort.socket.destroy();
  await browser.socketClosed;

  browser.upgrades.length = 0;
  for (const origin of ["https://elsewhere.example", "https://portal.example.elsewhere.example", "null"]) {
    const foreign = upgrade({ ...asked, Origin: origin });
    await until(() => foreign.text().includes("\r\n\r\n"), `an answer to ${origin}`);
    assert.match(foreign.text(), /^HTTP\/1\.1 403 /, origin);
    foreign.socket.destroy();
  }
  // A forwarded host that is no address does not stand for anything.
  const tricked = upgrade({ Cookie: cookie, "X-Forwarded-Host": "elsewhere.example@portal.example", Origin: "https://elsewhere.example" });
  await until(() => tricked.text().includes("\r\n\r\n"), "an answer to a made-up host");
  assert.match(tricked.text(), /^HTTP\/1\.1 403 /);
  tricked.socket.destroy();
  assert.equal(browser.upgrades.length, 0, "the browser was never asked");
});

test("a stream the browser refuses is answered, not left waiting", async () => {
  const cookie = await signedIn();
  browser.mode = "refuse";
  try {
    const stream = upgrade({ Cookie: cookie });
    await until(() => stream.text().includes("\r\n\r\n"), "an answer");
    assert.match(stream.text(), /^HTTP\/1\.1 401 /);
    stream.socket.destroy();
  } finally {
    browser.mode = "accept";
  }
});

test("a visitor who leaves during the handshake takes the portal's request to the browser with them", async () => {
  const cookie = await signedIn();
  browser.mode = "slow";
  browser.upgrades.length = 0;
  try {
    const stream = upgrade({ Cookie: cookie });
    await until(() => browser.release, "the browser being asked");
    // Gone as a closed tab or a lost connection is: not with a goodbye.
    stream.socket.resetAndDestroy();
    // Without being answered: the portal lets go of the request when its visitor has gone.
    await Promise.race([browser.socketClosed, new Promise((_, no) => setTimeout(() => no(new Error("the browser is still being asked for a stream nobody is waiting for")), 3000))]);
  } finally {
    browser.release?.();
    browser.release = undefined;
    browser.mode = "accept";
  }
  assert.equal((await api(cookie)).status, 200, "and the portal is still there");
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import WebSocket from "ws";

/**
 * A device as the Pithagoras Sync client is one, for tests of the portal's end:
 * the token in the Authorization header, no Origin, `hello` first, and answers
 * to what the portal asks. `answers` say what each method returns (a value, or
 * a function of the params, the id and the device); the rest is recorded.
 * Imports the built protocol module, so the test's home must be set first.
 */
const { decodeFrame, encodeFrame, FRAME } = await import("../dist/sync/protocol.js");

export class Device {
  constructor(ws, answers) {
    this.ws = ws;
    this.answers = answers;
    this.got = [];
    this.binary = [];
    ws.on("message", (data, isBinary) => {
      if (isBinary) return this.binary.push(decodeFrame(data));
      const m = JSON.parse(String(data));
      // The portal sends nothing but the four fields of JSON-RPC 2.0 (the device refuses any other).
      assert.deepEqual(Object.keys(m).filter((k) => !["jsonrpc", "id", "method", "params"].includes(k)), []);
      assert.equal(m.jsonrpc, "2.0");
      this.got.push(m);
      const answer = this.answers[m.method];
      if (m.id === undefined || answer === undefined) return;
      const out = typeof answer === "function" ? answer(m.params, m.id, this) : answer;
      if (out === undefined) return;
      Promise.resolve(out).then((o) => this.reply(m.id, o));
    });
  }
  reply(id, out) {
    if (out !== undefined) this.send(out.error ? { jsonrpc: "2.0", id, error: out.error } : { jsonrpc: "2.0", id, result: out });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  notify(method, params) { this.send({ jsonrpc: "2.0", method, params }); }
  frame(kind, stream, seq, payload) { this.ws.send(encodeFrame(kind, stream, seq, Buffer.from(payload))); }
  /** A file's content as fs.read sends it: its frames, then the result. */
  sendFile(params, id, content) {
    const data = Buffer.from(content);
    let chunks = 0;
    for (let at = 0; at < data.length; at += 65536) this.frame(FRAME.fileData, params.stream, chunks++, data.subarray(at, at + 65536));
    return { size: data.length, sha256: sha256(data), chunks };
  }
  /** The upload of an fs.write, once all its frames are in. */
  async upload(params) {
    for (let i = 0; i < 300 && this.uploaded(params.stream).length < params.size; i++) await new Promise((r) => setTimeout(r, 10));
    return this.uploaded(params.stream);
  }
  uploaded(stream) {
    return Buffer.concat(this.binary.filter((f) => f.kind === FRAME.fileUpload && f.stream === stream).map((f) => f.payload));
  }
  asked(method) { return this.got.filter((m) => m.method === method); }
  async waitFor(method, n = 1) {
    for (let i = 0; i < 300 && this.asked(method).length < n; i++) await new Promise((r) => setTimeout(r, 10));
    return this.asked(method);
  }
}

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export const INFO = { name: "laptop", os: "linux", arch: "x86_64", os_release: null, hostname: "laptop", user: "alice", uid: 4242, home: "/home/alice", shell: "bash", session: "headless", mode: "ask", mode_expires_ms: null, folders: [{ path: "/home/alice/src", access: "rw", execute: true }], folders_shell: "landlock", tools: ["read", "write", "edit", "bash", "grep", "find", "ls"], mcp_tools: [], client_version: "0.1.0" };
export const BASE_ANSWERS = { "device.info": INFO, "device.probe": { found: false, sha256: null, user: "alice", uid: 4242 }, "approval.list": { approvals: [] } };

/** Opens the socket on `base` (host:port) as the client does; the status of a refused upgrade, or the device once it said hello. */
export function connect(base, token, { origin, hello = {}, answers = {}, sayHello = true, userAgent = "pithagoras-sync/0.1.0", autoPong = true } = {}) {
  return new Promise((resolve) => {
    const headers = { "User-Agent": userAgent, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const ws = new WebSocket(`ws://${base}/sync/v1/connect`, { headers, ...(origin ? { origin } : {}), perMessageDeflate: false, autoPong });
    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    ws.on("error", () => {});
    ws.on("open", () => {
      const device = new Device(ws, { ...BASE_ANSWERS, ...answers });
      device.closed = new Promise((r) => ws.on("close", (code, reason) => r({ code, reason: String(reason) })));
      const id = token.split(".")[0];
      if (sayHello) device.notify("hello", { proto: 1, device_id: id, client_version: "0.1.0", os: "linux", user: "alice", shell: "bash", capabilities: ["fs", "grep", "find", "exec", "probe", "approvals"], ...hello });
      resolve({ status: 101, device });
    });
  });
}

export const until = async (check, what) => {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`waited in vain for ${what}`);
};

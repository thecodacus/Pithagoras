import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { recordAudit } from "../db.js";
import {
  CLOSE,
  CODE,
  CONNECT_PATH,
  DeviceError,
  FRAME,
  MAX_APPROVALS,
  MAX_CALLS,
  MAX_CHUNK,
  MAX_FILE,
  MAX_MESSAGE,
  MAX_STOPS,
  PROTO_VERSION,
  decodeFrame,
  encodeFrame,
  readApproval,
  readAudit,
  readDeviceInfo,
  readExecExit,
  readHello,
  readPolicy,
  type ApprovalInfo,
  type Choice,
  type Ctx,
  type DeviceInfo,
  type ExecExit,
  type Hello,
  type PolicyDocument,
} from "./protocol.js";
import { NOT_AVAILABLE, deviceOfToken, devicesEnabled, getDevice, touchDevice } from "./store.js";

/**
 * The portal's end of Pithagoras Sync: one WebSocket per paired device, which
 * the device opens (`/sync/v1/connect`, docs/guide/devices.md), and the calls the
 * portal makes on it.
 *
 * Who may connect is decided before the upgrade, from the connector token in
 * the Authorization header, and nothing else: not a cookie, which a page of
 * another site could make a browser send, and so not from a browser at all. A
 * request that names an Origin is a browser's and is refused, whatever it
 * carries. One live connection per device: a second is refused (409) and said
 * on the Devices page, so a copied token cannot push the real device off.
 *
 * Nothing is resumed. When a connection ends, every call waiting on it fails at
 * once and the device kills every command it ran for it (protocol.md, 4).
 */

const HELLO_WITHIN_MS = 10_000;
const PING_EVERY_MS = 20_000;
/** Nothing at all for this long, not even a pong, and the connection is dead. */
const DEAD_AFTER_MS = 45_000;
/** Most calls answer at once; one may wait for the owner's approval, which the device gives up on after at most an hour. */
const CALL_TIMEOUT_MS = 65 * 60_000;
const QUICK_TIMEOUT_MS = 30_000;
/**
 * Waits that a test shortens. A second connection with a device's token gives
 * the first `replaceProbeMs` to show a sign of life (a pong, or anything else
 * it sends) before it is taken for the device's own, back after a sleep or a
 * change of network. A first that was heard from within `recentMs` before the
 * second came, as long as the regular pinger would still have kept it, is said
 * on the Devices page when it is replaced. A connection that is closed has
 * `closeGraceMs` to answer the close, and what a device says in a frame it
 * refuses is logged once per `refusedLogMs`, with a count of the rest. The
 * audit events left out are noted `auditNoteMs` after the first of them, when
 * the device says nothing more to note them with. A device that is told
 * something it must have read has `confirmMs` to answer (see `tell`).
 */
export const TIMING = {
  replaceProbeMs: 3_000,
  recentMs: DEAD_AFTER_MS,
  closeGraceMs: 2_000,
  refusedLogMs: 60_000,
  auditNoteMs: 1_000,
  confirmMs: QUICK_TIMEOUT_MS,
};
/** The longest wait a timer takes: past it Node fires the timer at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/**
 * What the portal puts up with from a command on a device. The device has its
 * own limits (16 MiB of output by default, four hours at most), but they are
 * its own: the output goes on into the portal's temp folder, and a command is
 * waited for until the device says it is over.
 */
const EXEC_LIMITS = {
  /** Bytes of output passed on; past them the command is killed. */
  output: 32 * 1024 * 1024,
  /** How long past its own timeout (or the device's longest) a command's end is waited for. */
  graceMs: 30_000,
  /** The longest a command is waited for when the device does not say how long it lets one run (its default is four hours). */
  maxMs: 4 * 60 * 60_000,
  /** How long a command that was told to stop is given before it is killed and given up on. */
  killMs: 10_000,
};
export type ExecLimits = typeof EXEC_LIMITS;

/**
 * What a device may add to the portal's audit log: a burst, then a steady few a second. Each is a write on the event loop.
 * It is the device's allowance, not its connection's: a connection that starts afresh does not get a new burst.
 */
export const AUDIT_BURST = 50;
const AUDIT_PER_SECOND = 5;

interface Pending {
  method: string;
  resolve: (result: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  /** Given up on by the portal (stopped, timed out): see abandon. */
  abandoned: boolean;
  /** The stream a read, a write or a command uses. */
  stream?: number;
  /** Counted against MAX_STOPS, not MAX_CALLS (see Waiting.apart). */
  apart: boolean;
}

/** What a stream's binary frames go to. */
interface Sink {
  kind: number;
  next: number;
  take(payload: Buffer): void;
  fail(e: Error): void;
}

export interface Waiting {
  /** Approvals the device asks for while this call waits on one. */
  onApproval?: (approval: ApprovalInfo) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Answers a question of the device or stops a command: counted apart from the calls, so that it goes out when they are many. */
  apart?: boolean;
}

const offline = () => new DeviceError(CODE.IO, "the device disconnected");

/** Where a connection came from, as the portal saw it: so that its owner can tell the device's own from another. Behind a proxy the address is the proxy's. */
export interface Remote {
  address: string;
  userAgent: string;
}

/** One live connection, from the hello on. */
export class DeviceLink extends EventEmitter {
  readonly connectedAt = Date.now();
  /** device.info, asked once the connection is up; refreshed when the policy changes. */
  info?: DeviceInfo;
  /** Whether the device sees the portal's own files as the same user: then it is offered nothing (the same-machine check). */
  sameMachine?: boolean;
  /** The settings it shares, when its owner lets the portal read them. */
  policy?: PolicyDocument;
  /** Approvals it is waiting on, by its own id. */
  readonly approvals = new Map<number, ApprovalInfo>();
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** How many of `pending` are counted apart (MAX_STOPS). */
  private apart = 0;
  /** Approvals a deny was sent for, until they are resolved: none is denied twice, and none is allowed after. */
  private readonly denying = new Set<number>();
  private nextStream = 1;
  private readonly sinks = new Map<number, Sink>();
  private readonly exits = new Map<number, (exit: ExecExit) => void>();
  private lastHeard = Date.now();
  private readonly pinger: NodeJS.Timeout;
  closed = false;

  constructor(
    private readonly ws: WebSocket,
    readonly deviceId: string,
    readonly hello: Hello,
    readonly remote: Remote,
  ) {
    super();
    this.setMaxListeners(0);
    ws.on("message", (data, isBinary) => {
      // Whatever a frame does, it ends this link and nothing else: an exception here reaches no one else's handler, and ends the process.
      try {
        this.receive(data, isBinary);
      } catch (e) {
        this.broke(e);
      }
    });
    ws.on("pong", () => this.heard());
    ws.on("close", () => this.ended());
    this.pinger = setInterval(() => {
      if (Date.now() - this.lastHeard > DEAD_AFTER_MS) return void ws.terminate();
      ws.ping();
    }, PING_EVERY_MS);
    this.pinger.unref();
  }

  /** Anything from the device, a pong or any message, is a sign of life. */
  private heard(): void {
    this.lastHeard = Date.now();
    this.emit("heard");
  }

  /** When the device was last heard from, in ms since the epoch. */
  get heardAt(): number {
    return this.lastHeard;
  }

  /**
   * Whether the device shows a sign of life within `ms` of a ping: its pong, or
   * anything else it sends. A pong can wait behind what the device is writing,
   * a command's output or a big file, so the data that keeps coming is as good
   * as the pong. One that slept or lost its network says nothing, and the
   * portal learns that only from its silence.
   */
  alive(ms: number): Promise<boolean> {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (answer: boolean) => {
        clearTimeout(timer);
        this.off("heard", yes);
        this.off("closed", no);
        resolve(answer);
      };
      const yes = () => done(true);
      const no = () => done(false);
      const timer = setTimeout(no, ms);
      this.once("heard", yes);
      this.once("closed", no);
      this.ws.ping();
    });
  }

  can(capability: string): boolean {
    return this.hello.capabilities.includes(capability);
  }

  /** A request, answered by the device; the result as it sent it. */
  call(method: string, params: Record<string, unknown>, waiting: Waiting = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(offline());
    const apart = waiting.apart === true;
    if (apart ? this.apart >= MAX_STOPS : this.pending.size - this.apart >= MAX_CALLS) {
      return Promise.reject(new DeviceError(CODE.BUSY, "too many calls to the device at once"));
    }
    if (waiting.signal?.aborted) return Promise.reject(new DeviceError(CODE.INTERNAL, "stopped"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(entry.timer);
        waiting.signal?.removeEventListener("abort", stop);
        if (waiting.onApproval) this.off(`approval:${id}`, waiting.onApproval);
      };
      const entry: Pending = {
        method,
        resolve: (r) => { done(); resolve(r); },
        reject: (e) => { done(); reject(e); },
        timer: setTimeout(() => this.abandon(id, new DeviceError(CODE.IO, `the device did not answer ${method} in time`)), waiting.timeoutMs ?? CALL_TIMEOUT_MS),
        abandoned: false,
        stream: typeof params.stream === "number" ? params.stream : undefined,
        apart,
      };
      const stop = () => this.abandon(id, new DeviceError(CODE.INTERNAL, "stopped"));
      waiting.signal?.addEventListener("abort", stop, { once: true });
      if (waiting.onApproval) this.on(`approval:${id}`, waiting.onApproval);
      this.pending.set(id, entry);
      if (apart) this.apart++;
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.closed) this.send({ jsonrpc: "2.0", method, params });
  }

  /**
   * A notification that the device is known to have read: sent, and then a
   * request whose answer comes only once the client has applied everything
   * before it (it reads its frames in order). A connection that is half open,
   * which the portal has not noticed yet, takes the notification and never
   * answers, and that fails here, where `notify` would pass without a sign.
   */
  async tell(method: string, params: Record<string, unknown>): Promise<void> {
    this.notify(method, params);
    await this.call("device.info", {}, { timeoutMs: TIMING.confirmMs });
  }

  /**
   * Stops waiting for a call. There is no way to take a call back from the
   * device, so what it would still do is stopped instead: an approval it waits
   * on for this call is denied, and a command it starts late is killed (see
   * the response handling).
   */
  private abandon(id: number, why: Error): void {
    const entry = this.pending.get(id);
    if (!entry || entry.abandoned) return;
    entry.abandoned = true;
    entry.reject(why);
    if (entry.apart) return void this.take(id);
    for (const approval of this.approvals.values()) {
      if (approval.call === id) this.deny(approval.id);
    }
    // Kept until the device answers, so that a late answer is known as this call's.
  }

  /** A call's entry, no longer pending: answered, or one that needs no late answer matched. */
  private take(id: number): Pending | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    if (entry.apart) this.apart--;
    return entry;
  }

  /**
   * Denies what the device still asks for a chat that no longer has it, each
   * question once: the ones of a call already given up on were denied with it,
   * and one whose deny could not go out is tried again here.
   */
  withdrawApprovals(chat: string): void {
    for (const approval of this.approvals.values()) if (approval.chat === chat) this.deny(approval.id);
  }

  /** Denies an approval, once: not again while the first is on its way or answered, and the owner cannot allow it after. */
  deny(id: number): void {
    if (this.denying.has(id)) return;
    this.denying.add(id);
    this.answerApproval(id, "deny").catch(() => this.denying.delete(id));
  }

  /** Whether a deny was sent for the approval, which then is not allowed any more. */
  isDenied(id: number): boolean {
    return this.denying.has(id);
  }

  /** The owner's answer to an approval, sent to the device. */
  answerApproval(id: number, answer: Choice, minutes?: number): Promise<unknown> {
    return this.call("approval.answer", { id, answer, ...(answer === "time" ? { minutes } : {}) }, { timeoutMs: QUICK_TIMEOUT_MS, apart: true });
  }

  /** A file's content, from FileData frames and the result that follows them. */
  async readFile(filePath: string, ctx: Ctx, waiting: Waiting = {}): Promise<{ data: Buffer; sha256: string }> {
    const stream = this.openStream();
    const chunks: Buffer[] = [];
    let size = 0;
    let failed: Error | undefined;
    this.sinks.set(stream, {
      kind: FRAME.fileData,
      next: 0,
      take: (payload) => {
        size += payload.length;
        if (size > MAX_FILE) failed ??= new DeviceError(CODE.TOO_LARGE, "the file is larger than the portal reads");
        else chunks.push(payload);
      },
      fail: (e) => (failed ??= e),
    });
    try {
      const result = (await this.call("fs.read", { path: filePath, stream, ctx }, waiting)) as { size?: unknown; sha256?: unknown; chunks?: unknown };
      if (failed) throw failed;
      const data = Buffer.concat(chunks);
      const sha256 = createHash("sha256").update(data).digest("hex");
      if (result?.size !== data.length || result?.sha256 !== sha256 || result?.chunks !== chunks.length) {
        throw new DeviceError(CODE.IO, "the file arrived incomplete");
      }
      return { data, sha256 };
    } finally {
      this.sinks.delete(stream);
    }
  }

  /** Writes a file: the request, then its content in FileUpload frames, each sent once the last has gone out. */
  async writeFile(filePath: string, data: Buffer, opts: { ifMatch?: string; createDirs?: boolean }, ctx: Ctx, waiting: Waiting = {}): Promise<{ size: number; sha256: string }> {
    if (data.length > MAX_FILE) throw new DeviceError(CODE.TOO_LARGE, "the file is larger than a device takes");
    const stream = this.openStream();
    const answer = this.call(
      "fs.write",
      { path: filePath, stream, size: data.length, ...(opts.ifMatch ? { if_match: opts.ifMatch } : {}), ...(opts.createDirs ? { create_dirs: true } : {}), ctx },
      waiting,
    );
    // The answer may come before every frame went out (a refusal): it is what counts then.
    let refused = false;
    answer.catch(() => (refused = true));
    for (let seq = 0, at = 0; at < data.length && !refused && !this.closed; seq++, at += MAX_CHUNK) {
      await this.sendBinary(encodeFrame(FRAME.fileUpload, stream, seq, data.subarray(at, at + MAX_CHUNK))).catch(() => {});
    }
    return (await answer) as { size: number; sha256: string };
  }

  /**
   * Runs a command: `exec.start`, its output as it comes, and its end. The
   * command runs in the device's own environment; nothing of the portal's is
   * sent. The portal bounds what it takes (see EXEC_LIMITS): more output than
   * that kills the command, one that does not end in time is killed and given
   * up on, and so is one that was told to stop and does not.
   */
  async exec(opts: { command: string; cwd: string; timeoutMs?: number; ctx: Ctx; onData: (data: Buffer) => void; limits?: Partial<ExecLimits> } & Waiting): Promise<ExecExit> {
    const limit = { ...EXEC_LIMITS, ...opts.limits };
    // How long the device lets a command run, as it says in the settings it shares, which hold the command to it whatever is asked;
    // without them the portal's own default. The portal's wait is never longer: it is a wait for the device's word, not a second limit.
    const shared = this.policy?.settings.exec;
    const secs = typeof shared === "object" && shared !== null ? (shared as Record<string, unknown>).max_timeout_secs : undefined;
    const longest = Math.min(typeof secs === "number" && Number.isFinite(secs) && secs > 0 ? secs * 1000 : limit.maxMs, MAX_TIMER_MS - limit.graceMs);
    const asked = typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : undefined;
    const stream = this.openStream();
    let ended: (exit: ExecExit) => void = () => {};
    const exit = new Promise<ExecExit>((resolve) => (ended = resolve));
    let printed = 0;
    let cut = false;
    this.sinks.set(stream, {
      kind: FRAME.execOutput,
      next: 0,
      take: (data) => {
        if (cut) return;
        printed += data.length;
        if (printed <= limit.output) return opts.onData(data);
        cut = true;
        this.notifySignal(stream, "SIGKILL");
        ended({ stream, code: null, signal: "SIGKILL", timed_out: false, truncated: true, cut: true });
      },
      fail: () => {},
    });
    this.exits.set(stream, ended);
    let started = false;
    let giveUp: (e: Error) => void = () => {};
    const gone = new Promise<never>((_, reject) => (giveUp = reject));
    gone.catch(() => {});
    let killer: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    const stop = () => {
      if (!started) return;
      this.notifySignal(stream, "SIGTERM");
      killer ??= setTimeout(() => {
        this.notifySignal(stream, "SIGKILL");
        giveUp(new DeviceError(CODE.INTERNAL, "stopped"));
      }, limit.killMs);
      killer.unref();
    };
    const onClosed = () => giveUp(offline());
    try {
      await this.call(
        "exec.start",
        { stream, command: opts.command, cwd: opts.cwd, ...(asked ? { timeout_ms: Math.max(1, Math.round(asked)) } : {}), ctx: opts.ctx },
        { onApproval: opts.onApproval, signal: opts.signal },
      );
      started = true;
      if (opts.signal?.aborted) stop();
      opts.signal?.addEventListener("abort", stop, { once: true });
      deadline = setTimeout(() => {
        this.notifySignal(stream, "SIGKILL");
        giveUp(new DeviceError(CODE.IO, "the device did not report the end of the command in time"));
      }, Math.min(asked ?? longest, longest) + limit.graceMs);
      deadline.unref();
      if (this.closed) onClosed();
      else this.once("closed", onClosed);
      return await Promise.race([exit, gone]);
    } finally {
      clearTimeout(deadline);
      clearTimeout(killer);
      this.off("closed", onClosed);
      opts.signal?.removeEventListener("abort", stop);
      this.sinks.delete(stream);
      this.exits.delete(stream);
    }
  }

  private notifySignal(stream: number, signal: "SIGINT" | "SIGTERM" | "SIGKILL"): void {
    this.call("exec.signal", { stream, signal }, { timeoutMs: QUICK_TIMEOUT_MS, apart: true }).catch(() => {});
  }

  /** A stream id no open read, write or command of this connection uses. */
  private openStream(): number {
    for (;;) {
      const id = this.nextStream;
      this.nextStream = this.nextStream >= 0xfffffffe ? 1 : this.nextStream + 1;
      if (!this.sinks.has(id) && !this.exits.has(id)) return id;
    }
  }

  close(code: number, reason: string): void {
    if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) this.ws.close(code, reason);
    // A device that does not answer the close is not waited for.
    setTimeout(() => this.ws.terminate(), TIMING.closeGraceMs).unref();
    this.ended();
  }

  private send(message: object): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(message));
  }

  private sendBinary(frame: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== this.ws.OPEN) return reject(offline());
      this.ws.send(frame, { binary: true }, (e) => (e ? reject(e) : resolve()));
    });
  }

  /** A frame the portal could not handle: said once in the log (quoted, as the text may come from the device), and the link is closed. */
  private broke(e: unknown): void {
    console.warn(`[devices] ${this.deviceId} sent a frame the portal could not handle, and the link is closed: ${JSON.stringify(e instanceof Error && typeof e.message === "string" ? e.message.slice(0, 200) : "")}`);
    this.close(CLOSE.violation, "the frame could not be handled");
  }

  private receive(data: RawData, isBinary: boolean): void {
    this.heard();
    const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    if (isBinary) return this.receiveFrame(buffer);
    let message: any;
    try {
      message = JSON.parse(buffer.toString("utf8"));
    } catch {
      return;
    }
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") return;
    if (typeof message.method === "string") return this.receiveNotification(message.method, message.params);
    if (typeof message.id !== "number") {
      // The device says the portal sent something it could not read: a bug here, worth a line in the log (never the frame).
      if (message.error) logRefused(this.deviceId, message.error?.message);
      return;
    }
    const entry = this.take(message.id);
    if (!entry) return;
    if (entry.abandoned) {
      // Started after all, for a call nobody waits for any more: it is stopped at once.
      if (entry.method === "exec.start" && !message.error && entry.stream !== undefined) this.notifySignal(entry.stream, "SIGKILL");
      return;
    }
    if (message.error && typeof message.error === "object") {
      const code = Number.isInteger(message.error.code) ? message.error.code : CODE.INTERNAL;
      // The message is the device's word and any JSON: it is text only when it is, as String() of some objects throws.
      const said = typeof message.error.message === "string" ? message.error.message.slice(0, 2000) : "the device refused";
      entry.reject(new DeviceError(code, said));
    } else entry.resolve(message.result);
  }

  private receiveFrame(buffer: Buffer): void {
    const frame = decodeFrame(buffer);
    if (!frame) return;
    const sink = this.sinks.get(frame.stream);
    if (!sink || sink.kind !== frame.kind) return;
    if (frame.seq !== sink.next) return sink.fail(new DeviceError(CODE.IO, "frames arrived out of order"));
    sink.next++;
    sink.take(frame.payload);
  }

  /**
   * Whether a question the device asks is taken up. Each is kept, shown on the
   * Devices page and asked in a chat until it is answered, so what a device
   * can open is bounded: a number of them in all, none that repeats one it has,
   * none for a call of this connection that is not waiting, and one at a time
   * for a call, which waits on a single answer.
   */
  private keepsApproval(approval: ApprovalInfo): boolean {
    if (this.approvals.has(approval.id) || this.approvals.size >= MAX_APPROVALS) return false;
    if (typeof approval.call !== "number") return true;
    if (!this.pending.has(approval.call)) return false;
    for (const open of this.approvals.values()) if (open.call === approval.call) return false;
    return true;
  }

  private receiveNotification(method: string, params: unknown): void {
    switch (method) {
      case "exec.exit": {
        const exit = readExecExit(params);
        if (exit) this.exits.get(exit.stream)?.(exit);
        return;
      }
      case "approval.requested": {
        const approval = readApproval(params);
        if (!approval || !this.keepsApproval(approval)) return;
        this.approvals.set(approval.id, approval);
        // Asked for a call the portal has stopped waiting for: nobody is there to answer it.
        const waiting = typeof approval.call === "number" ? this.pending.get(approval.call) : undefined;
        if (waiting?.abandoned) {
          this.deny(approval.id);
          return;
        }
        if (typeof approval.call === "number") this.emit(`approval:${approval.call}`, approval);
        hub.emit("approval", this.deviceId, approval);
        return;
      }
      case "approval.resolved": {
        const id = typeof (params as any)?.id === "number" ? (params as any).id : undefined;
        if (id === undefined) return;
        const was = this.approvals.get(id);
        this.approvals.delete(id);
        this.denying.delete(id);
        if (was) hub.emit("approval-resolved", this.deviceId, was);
        return;
      }
      case "audit": {
        const event = readAudit(params);
        if (!event || !mayAudit(this.deviceId)) return;
        recordAudit({
          kind: "device",
          tool: event.tool,
          subject: event.target,
          reason: `${getDevice(this.deviceId)?.name ?? this.deviceId}: ${event.decision}${event.reason ? ` — ${event.reason}` : ""}`,
          sessionId: event.chat,
        });
        return;
      }
      case "policy.changed": {
        // Only from a device that says it shares its settings.
        if (!this.can("policy")) return;
        const policy = readPolicy(params);
        if (!policy) return;
        this.policy = policy;
        // The mode, the folders and the tools are in device.info: read again so the page and the tools see them now.
        this.call("device.info", {}, { timeoutMs: QUICK_TIMEOUT_MS }).then((info) => {
          const read = readDeviceInfo(info);
          if (read) this.info = read;
          hub.emit("status", this.deviceId);
        }, () => {});
        return;
      }
      default:
        // A newer client may say more; nothing it says unasked is acted on.
        return;
    }
  }

  private ended(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pinger);
    for (const [, entry] of this.pending) if (!entry.abandoned) entry.reject(offline());
    this.pending.clear();
    this.apart = 0;
    for (const sink of this.sinks.values()) sink.fail(offline());
    this.approvals.clear();
    this.denying.clear();
    this.emit("closed");
  }
}

interface AuditGate {
  tokens: number;
  at: number;
  /** Events refused since the last note. */
  leftOut: number;
  /** The note that is due when the device says nothing more to write it with. */
  timer?: NodeJS.Timeout;
}
/** Each device's allowance of audit events, kept while the portal runs, whatever its connections do. */
const auditGates = new Map<string, AuditGate>();

function refill(gate: AuditGate): void {
  const now = Date.now();
  gate.tokens = Math.min(AUDIT_BURST, gate.tokens + ((now - gate.at) / 1000) * AUDIT_PER_SECOND);
  gate.at = now;
}

/** The note that says how many events were left out: one write, for all of them. */
function noteLeftOut(deviceId: string, gate: AuditGate): void {
  recordAudit({ kind: "device", tool: "audit", reason: `${getDevice(deviceId)?.name ?? deviceId}: ${gate.leftOut} events left out, as it sent more than ${AUDIT_PER_SECOND} a second` });
  gate.leftOut = 0;
}

/**
 * Whether a device may add another event to the audit log now. Past its rate
 * the events are dropped and counted, and the count is written as one note: by
 * the next event that is taken, or, when the device falls silent, a moment
 * later by itself. The log shows a device that talked too much, and a flood
 * costs the portal a counter, not a database write each.
 */
function mayAudit(deviceId: string): boolean {
  let gate = auditGates.get(deviceId);
  if (!gate) auditGates.set(deviceId, (gate = { tokens: AUDIT_BURST, at: Date.now(), leftOut: 0 }));
  refill(gate);
  if (gate.tokens < 1) {
    gate.leftOut++;
    noteSoon(deviceId, gate);
    return false;
  }
  gate.tokens--;
  if (gate.leftOut > 0) {
    gate.tokens--;
    noteLeftOut(deviceId, gate);
  }
  return true;
}

/** Writes the note for what was left out once the allowance has a token to spare, however quiet the device is. */
function noteSoon(deviceId: string, gate: AuditGate): void {
  if (gate.timer) return;
  gate.timer = setTimeout(() => {
    gate.timer = undefined;
    refill(gate);
    if (gate.leftOut === 0) return;
    if (gate.tokens >= 1) {
      gate.tokens--;
      noteLeftOut(deviceId, gate);
    } else noteSoon(deviceId, gate);
  }, TIMING.auditNoteMs);
  gate.timer.unref();
}

/** Devices that have had a refusal logged within the interval, with how many more it sent since. */
const refusedLogs = new Map<string, { skipped: number }>();

/**
 * What a device says about a frame it refused goes to the portal's log, but not
 * as often as it can send it, or the log would grow as fast as the device
 * uploads: the first of an interval is written (quoted, as it is the device's
 * own text and a line break in it could write a line of the log), the rest are
 * counted, and one line at the end of the interval says how many.
 */
function logRefused(deviceId: string, said: unknown): void {
  const open = refusedLogs.get(deviceId);
  if (open) {
    open.skipped++;
    return;
  }
  const gate = { skipped: 0 };
  refusedLogs.set(deviceId, gate);
  console.warn(`[devices] ${deviceId} refused a frame: ${JSON.stringify(typeof said === "string" ? said.slice(0, 200) : "")}`);
  setTimeout(() => {
    refusedLogs.delete(deviceId);
    if (gate.skipped) console.warn(`[devices] ${deviceId} refused ${gate.skipped} more frames in the last ${Math.round(TIMING.refusedLogMs / 1000)} seconds`);
  }, TIMING.refusedLogMs).unref();
}

// --- the registry ---

/** Says what changed: "status" (a device came, went or changed), "approval", "approval-resolved". */
export const hub = new EventEmitter();
hub.setMaxListeners(0);

const links = new Map<string, DeviceLink>();
/**
 * Devices whose upgrade is under way, by the attempt that holds the place, so
 * that two at once cannot both get through the one-connection check. Each
 * attempt gives up its own place and nobody else's: a connection that ends
 * (the one that was just replaced, say, up to a moment after) must not free
 * the place of the one that is still waiting for its hello.
 */
const arriving = new Map<string, symbol>();
/**
 * A second connection with a device's token, by device: said on the Devices page, with where each came from. It was refused
 * because the device had one that answered, or it took the place of one that had been heard from a moment before (`replaced`;
 * `refused` is then the connection that took over).
 */
const alerts = new Map<string, { at: number; message: string; existing: Remote | null; refused: Remote; replaced: boolean }>();

export const linkOf = (deviceId: string): DeviceLink | undefined => links.get(deviceId);
export const alertOf = (deviceId: string) => alerts.get(deviceId);
export const clearAlert = (deviceId: string) => alerts.delete(deviceId);

/** Ends a device's connection now: removed (4001), or the add-on switched off (1001). */
export function dropDevice(deviceId: string, code: number = CLOSE.revoked, reason = "device removed"): void {
  links.get(deviceId)?.close(code, reason);
  links.delete(deviceId);
  if (code === CLOSE.revoked) {
    alerts.delete(deviceId);
    clearTimeout(auditGates.get(deviceId)?.timer);
    auditGates.delete(deviceId);
  }
  hub.emit("status", deviceId);
}

export function dropAll(code: number = CLOSE.goingAway, reason = "the portal is going away"): void {
  for (const id of [...links.keys()]) dropDevice(id, code, reason);
}

/** An answer to a connection that does not become a WebSocket, then closed. */
function refuse(socket: Duplex, status: number, message: string): void {
  const body = JSON.stringify({ error: message });
  socket.end(`HTTP/1.1 ${status} ${http_status(status)}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  setTimeout(() => socket.destroy(), 5_000).unref();
}

const http_status = (status: number) =>
  ({ 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 503: "Service Unavailable" })[status] ?? "Error";

/** Whether an upgrade is the sync connection's: only its exact path, without a query. */
export const isSyncUpgrade = (url: string | undefined): boolean => url === CONNECT_PATH;

/** The address and User-Agent of an upgrade request; the User-Agent is the client's own word, cut and cleaned as it is shown and logged. */
const remoteOf = (req: http.IncomingMessage): Remote => ({
  address: req.socket.remoteAddress ?? "",
  userAgent: String(req.headers["user-agent"] ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 200),
});

function conflict(deviceId: string, existing: Remote | null | undefined, refused: Remote): { status: number; message: string } {
  alerts.set(deviceId, { at: Date.now(), message: "A second connection with this device's token was refused while it was connected", existing: existing ?? null, refused, replaced: false });
  hub.emit("status", deviceId);
  return { status: 409, message: "This device is already connected" };
}

/** A connection took the place of one that had still been in touch: the owner is told, as a copied token would do the same. */
function tookOver(deviceId: string, existing: Remote, taken: Remote): void {
  alerts.set(deviceId, { at: Date.now(), message: "A connection with this device's token took the place of one that had just been in touch", existing, refused: taken, replaced: true });
  hub.emit("status", deviceId);
}

/**
 * Who an upgrade is from: a device, or the status and words to refuse it with.
 * Checked before the upgrade, so that nothing unauthenticated ever becomes a
 * WebSocket. A device that is connected already is not refused here: the
 * connection may be a dead one (see attachSyncUpgrade), so the answer says which.
 */
export function admit(
  headers: http.IncomingHttpHeaders,
  remote: Remote,
): { deviceId: string; existing?: DeviceLink; release: () => void } | { status: number; message: string } {
  if (!devicesEnabled()) return { status: 503, message: NOT_AVAILABLE };
  // A browser always names the page it opens a socket from; the device client never does.
  if (headers.origin !== undefined) return { status: 403, message: "Not from a browser" };
  const auth = headers.authorization ?? "";
  const token = /^Bearer ([\x21-\x7e]{16,512})$/.exec(auth)?.[1];
  const device = token ? deviceOfToken(token) : undefined;
  if (!device) return { status: 401, message: "Unknown or revoked token" };
  // Two connections at once, and the first not up yet: nothing says which is the device's own.
  if (arriving.has(device.id)) return conflict(device.id, links.get(device.id)?.remote, remote);
  const attempt = Symbol(device.id);
  arriving.set(device.id, attempt);
  return {
    deviceId: device.id,
    existing: links.get(device.id),
    // Only this attempt's own place, and as often as it likes.
    release: () => {
      if (arriving.get(device.id) === attempt) arriving.delete(device.id);
    },
  };
}

/**
 * The sync WebSocket, on the portal's own HTTP server. Registered before the
 * browser's upgrade listener, which leaves this path alone.
 *
 * One live connection per device, so a copied token cannot push the real
 * device off. But a laptop that slept, or changed network, leaves a connection
 * the portal still takes for live until its pings go unanswered, and the device
 * comes back at once: so a second connection pings the first. When it shows a
 * sign of life (a pong, or anything else it sends), the second is refused (409)
 * and the alert says where each came from. When it does not, it is closed and
 * the second takes over. That is said on the Devices page too when the first
 * had been heard from a moment before, which a device that slept hardly was
 * but a copied token that answers late was: the device's own return is then
 * told apart from another's by its owner, who sees where each came from.
 */
export function attachSyncUpgrade(server: http.Server): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE, perMessageDeflate: false, clientTracking: false });
  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!isSyncUpgrade(req.url)) return;
    socket.on("error", () => {});
    if (req.method !== "GET") return refuse(socket, 400, "Bad request");
    const remote = remoteOf(req);
    const admitted = admit(req.headers, remote);
    if ("status" in admitted) return refuse(socket, admitted.status, admitted.message);
    const { deviceId, existing, release } = admitted;
    // However the attempt ends, also while it waits for the ping below: a client that gave up must not block its next one.
    // handleUpgrade answers a malformed upgrade itself and never calls back.
    socket.once("close", release);
    const upgrade = () =>
      wss.handleUpgrade(req, socket, head, (ws) => {
        // From the first byte on: a frame that breaks the protocol (unmasked, over the limit, bad UTF-8) is an
        // 'error' of the socket, which ends the whole process when nobody listens.
        ws.on("error", () => ws.terminate());
        welcome(ws, deviceId, remote, release);
      });
    if (!existing) return upgrade();
    const heardAt = existing.heardAt;
    void existing.alive(TIMING.replaceProbeMs).then((answers) => {
      if (socket.destroyed) return;
      if (answers) {
        release();
        const refused = conflict(deviceId, existing.remote, remote);
        return refuse(socket, refused.status, refused.message);
      }
      const recent = Date.now() - heardAt < TIMING.recentMs;
      console.log(`[devices] ${getDevice(deviceId)?.name ?? deviceId} connected again from ${remote.address}; its earlier connection from ${existing.remote.address} no longer answered, and was closed${recent ? " (it had been heard from a moment before)" : ""}`);
      if (recent) tookOver(deviceId, existing.remote, remote);
      existing.close(CLOSE.replaced, "replaced by a new connection");
      upgrade();
    });
  });
}

/**
 * The first frame is the device's hello; then the link is up and the portal
 * asks what it needs to know. The link is made inside the hello's own
 * `message` handler: the socket may deliver the next frame in the same
 * breath, and a listener added later would not hear it.
 */
function welcome(ws: WebSocket, deviceId: string, remote: Remote, settled: () => void): void {
  const refused = (code: number, reason: string) => {
    settled();
    ws.close(code, reason);
  };
  const late = setTimeout(() => {
    ws.off("message", first);
    refused(CLOSE.violation, "hello expected");
  }, HELLO_WITHIN_MS);
  const gone = () => {
    clearTimeout(late);
    ws.off("message", first);
    settled();
  };
  const first = (data: RawData, isBinary: boolean) => {
    clearTimeout(late);
    ws.off("close", gone);
    const hello = isBinary ? undefined : readFirst(data);
    if (hello === "proto") return refused(CLOSE.unsupported, "unsupported protocol version");
    if (!hello || hello.device_id !== deviceId) return refused(CLOSE.violation, "hello expected");
    // Removed while it said hello: it stops. The add-on switched off: it tries again, as it does for the switch.
    if (!getDevice(deviceId)) return refused(CLOSE.revoked, "device removed");
    if (!devicesEnabled()) return refused(CLOSE.goingAway, "devices switched off");
    // Attempts come one at a time (see arriving), and a link that was replaced is closed and gone from `links` before the new
    // one is upgraded, so there is none here. If there ever is, it is kept and this one is turned away: never overwritten and left open.
    const held = links.get(deviceId);
    if (held && !held.closed) {
      conflict(deviceId, held.remote, remote);
      return refused(CLOSE.replaced, "this device is connected already");
    }
    const link = new DeviceLink(ws, deviceId, hello, remote);
    links.set(deviceId, link);
    touchDevice(deviceId);
    link.once("closed", () => {
      if (links.get(deviceId) === link) links.delete(deviceId);
      if (getDevice(deviceId)) touchDevice(deviceId);
      hub.emit("status", deviceId);
    });
    settled();
    hub.emit("status", deviceId);
    void learn(link);
  };
  ws.once("message", first);
  ws.once("close", gone);
}

/** The hello's params, "proto" for another protocol version, or undefined when the frame is not a hello. */
function readFirst(data: RawData): Hello | "proto" | undefined {
  try {
    const m = JSON.parse(String(data));
    if (m?.jsonrpc !== "2.0" || m.method !== "hello" || "id" in m) return undefined;
    const hello = readHello(m.params);
    return hello && hello.proto !== PROTO_VERSION ? "proto" : hello;
  } catch {
    return undefined;
  }
}

/** What the portal asks a device once it is connected: what it is, whether it is the portal's own machine, its approvals and its settings. */
async function learn(link: DeviceLink): Promise<void> {
  try {
    const info = readDeviceInfo(await link.call("device.info", {}, { timeoutMs: QUICK_TIMEOUT_MS }));
    if (info) link.info = info;
    link.sameMachine = await sameMachine(link);
    if (link.can("approvals")) {
      const listed = (await link.call("approval.list", {}, { timeoutMs: QUICK_TIMEOUT_MS })) as { approvals?: unknown[] };
      for (const a of Array.isArray(listed?.approvals) ? listed.approvals.slice(0, MAX_APPROVALS) : []) {
        const approval = readApproval(a);
        if (approval) link.approvals.set(approval.id, approval);
      }
    }
    if (link.can("policy")) link.policy = readPolicy(await link.call("policy.get", {}, { timeoutMs: QUICK_TIMEOUT_MS }).catch(() => undefined));
  } catch {
    // A device that does not answer these is still connected; it is offered nothing until it has said what it is.
  }
  hub.emit("status", link.deviceId);
}

/**
 * The same-machine check (architecture, section 4): a random file in the
 * portal's temp folders, and whether the device reads the same content there
 * as the same user. Such a device would reach nothing the portal's own tools
 * do not, so it is not offered for files or the shell.
 */
export async function sameMachine(link: DeviceLink): Promise<boolean> {
  const content = randomBytes(32).toString("hex");
  const sha = createHash("sha256").update(content).digest("hex");
  const me = os.userInfo();
  const dirs = [...new Set([os.tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp"])])];
  for (const dir of dirs) {
    const file = path.join(dir, `pithagoras-probe-${randomBytes(16).toString("hex")}`);
    try {
      writeFileSync(file, content, { mode: 0o600, flag: "wx" });
      const answer = (await link.call("device.probe", { path: file }, { timeoutMs: QUICK_TIMEOUT_MS })) as { found?: unknown; sha256?: unknown; user?: unknown; uid?: unknown };
      if (answer?.found === true && answer.sha256 === sha && answer.uid === me.uid && answer.user === me.username) return true;
    } catch {
      // Not seen there, or not asked: nothing shared in that folder.
    } finally {
      rmSync(file, { force: true });
    }
  }
  return false;
}

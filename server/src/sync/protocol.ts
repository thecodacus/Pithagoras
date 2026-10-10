/**
 * The wire protocol of Pithagoras Sync, version 1, as the device client speaks
 * it (docs/protocol.md in the client's repository is the contract; this is the
 * portal's half of it). Only what the portal needs: the paths, the frames, the
 * codes, and the checks on what a device sends.
 *
 * A device is not trusted more than it has to be: a stolen connector token
 * speaks as the device. So what it sends is read with bounds, and nothing it
 * says is taken for more than what it describes about itself.
 */

export const PROTO_VERSION = 1;
export const PAIR_PATH = "/sync/v1/pair";
export const CONNECT_PATH = "/sync/v1/connect";

/** The largest WebSocket message either side takes. */
export const MAX_MESSAGE = 4 * 1024 * 1024;
/** The largest payload of one binary frame. */
export const MAX_CHUNK = 64 * 1024;
/** The largest file a read or a write moves. */
export const MAX_FILE = 64 * 1024 * 1024;
/** Calls the device handles at once; more are refused here before they are sent. */
export const MAX_CALLS = 64;
/**
 * Answers to its questions and stops of its commands in flight at once, counted
 * apart from MAX_CALLS: they end what the device is doing rather than add to
 * it, so they must still go out when its table of calls is full.
 */
export const MAX_STOPS = 256;
/** Approvals one device may have open at once. A person answers them; a device that asks for more than this is not asking one. */
export const MAX_APPROVALS = 128;

/** Close codes the portal sends (protocol.md, section 4). */
export const CLOSE = {
  /** Device removed or token revoked: the client stops until it is paired again. */
  revoked: 4001,
  /** Another connection of the device took over. */
  replaced: 4002,
  /** A protocol version this portal does not speak. */
  unsupported: 4003,
  /** The portal goes away (restart, add-on switched off): the client retries. */
  goingAway: 1001,
  /** The device broke the protocol: no hello, a hello for another device. */
  violation: 1008,
} as const;

/** JSON-RPC error codes (protocol.md, section 5). */
export const CODE = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  DENIED: -32001,
  NOT_FOUND: -32002,
  CONFLICT: -32003,
  TOO_LARGE: -32004,
  IO: -32005,
  BUSY: -32006,
  BAD_PATH: -32007,
} as const;

export const FRAME = { execOutput: 1, fileData: 2, fileUpload: 3 } as const;
const HEADER = 9;

export interface BinaryFrame {
  kind: number;
  stream: number;
  seq: number;
  payload: Buffer;
}

/** `u8 kind | u32 stream | u32 seq | payload`, big-endian. */
export function encodeFrame(kind: number, stream: number, seq: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(HEADER);
  head.writeUInt8(kind, 0);
  head.writeUInt32BE(stream >>> 0, 1);
  head.writeUInt32BE(seq >>> 0, 5);
  return Buffer.concat([head, payload]);
}

/** A frame, or undefined for one the protocol says to drop: too short, too long, or of an unknown kind. */
export function decodeFrame(data: Buffer): BinaryFrame | undefined {
  if (data.length < HEADER || data.length > HEADER + MAX_CHUNK) return undefined;
  const kind = data.readUInt8(0);
  if (kind !== FRAME.execOutput && kind !== FRAME.fileData && kind !== FRAME.fileUpload) return undefined;
  return { kind, stream: data.readUInt32BE(1), seq: data.readUInt32BE(5), payload: data.subarray(HEADER) };
}

/** An error the device answered a call with, or one the portal raised for it (offline, timed out). */
export class DeviceError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

/** The pi tools a device can serve. */
export const PI_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"] as const;
export type PiTool = (typeof PI_TOOLS)[number];

/** The inline extension whose tools take a `device`: their source is `<inline:devices>`, which the guard checks. */
export const DEVICE_TOOLS_SOURCE = "devices";

/** What a call is for: which chat, the guard's taint flag, and the tool. Nothing else is accepted by the device. */
export interface Ctx {
  chat: string;
  tainted: boolean;
  tool?: PiTool;
}

/** A device's name: what the agent passes as `device`. */
export const DEVICE_NAME = /^[a-z0-9-]{1,24}$/;
export const RESERVED_NAMES = new Set(["server", "portal"]);
export const isDeviceName = (name: unknown): name is string => typeof name === "string" && DEVICE_NAME.test(name) && !RESERVED_NAMES.has(name);

// --- reading what the device sends ---

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Text of at most `max` characters, or undefined. */
const text = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length <= max ? v : undefined);
const int = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
/** Whether text has a control character: a line break among them lets a path read as a sentence of its own. */
export const hasControl = (s: string): boolean => /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(s);
/** Text of at most `max` characters without control characters, or undefined: for what the agent's prompt quotes. */
const plain = (v: unknown, max: number): string | undefined => {
  const t = text(v, max);
  return t !== undefined && !hasControl(t) ? t : undefined;
};
const textList = (v: unknown, max: number, each: number): string[] | undefined =>
  Array.isArray(v) && v.length <= max && v.every((s) => typeof s === "string" && s.length <= each) ? (v as string[]) : undefined;

export interface Hello {
  proto: number;
  device_id: string;
  client_version: string;
  os: string;
  user: string;
  shell: string;
  capabilities: string[];
}

/** `hello`'s params, or undefined when they are not one. */
export function readHello(params: unknown): Hello | undefined {
  if (!isObject(params)) return undefined;
  const proto = int(params.proto, 0, 0xffff);
  const device_id = text(params.device_id, 128);
  const client_version = text(params.client_version, 64);
  const os = text(params.os, 32);
  const user = text(params.user, 256);
  const shell = text(params.shell, 64);
  const capabilities = textList(params.capabilities, 32, 32);
  if (proto === undefined || !device_id || client_version === undefined || os === undefined || user === undefined || shell === undefined || !capabilities) return undefined;
  return { proto, device_id, client_version, os, user, shell, capabilities };
}

export interface FolderInfo {
  path: string;
  access: "ro" | "rw";
  execute: boolean;
}

export interface DeviceInfo {
  name: string;
  os: string;
  arch: string;
  os_release: string | null;
  hostname: string;
  user: string;
  uid: number;
  home: string;
  shell: string;
  session: string;
  mode: "ask" | "folders" | "full";
  mode_expires_ms: number | null;
  folders: FolderInfo[];
  folders_shell: string;
  tools: PiTool[];
  client_version: string;
}

/**
 * `device.info`'s result, or undefined. Tools the portal does not know are left
 * out. A home with a control character makes it undefined, and a folder with
 * one is left out: they would go into the system prompt of every chat the
 * device is given to, and a line break there is an instruction the device writes.
 */
export function readDeviceInfo(v: unknown): DeviceInfo | undefined {
  if (!isObject(v)) return undefined;
  const mode = v.mode === "ask" || v.mode === "folders" || v.mode === "full" ? v.mode : undefined;
  const folders = Array.isArray(v.folders) && v.folders.length <= 1000
    ? v.folders.flatMap((f): FolderInfo[] => {
        if (!isObject(f)) return [];
        const p = plain(f.path, 4096);
        return p && (f.access === "ro" || f.access === "rw") ? [{ path: p, access: f.access, execute: f.execute === true }] : [];
      })
    : undefined;
  const tools = Array.isArray(v.tools) ? (v.tools.filter((t) => (PI_TOOLS as readonly unknown[]).includes(t)) as PiTool[]) : [];
  const info = {
    name: text(v.name, 64),
    os: text(v.os, 32),
    arch: text(v.arch, 32),
    os_release: v.os_release === null || v.os_release === undefined ? null : text(v.os_release, 256),
    hostname: text(v.hostname, 256),
    user: text(v.user, 256),
    uid: int(v.uid, 0, 0xffffffff),
    home: plain(v.home, 4096),
    shell: text(v.shell, 64),
    session: text(v.session, 32),
    mode,
    mode_expires_ms: v.mode_expires_ms === null || v.mode_expires_ms === undefined ? null : int(v.mode_expires_ms),
    folders,
    folders_shell: text(v.folders_shell, 32),
    tools,
    client_version: text(v.client_version, 64),
  };
  return Object.values(info).some((x) => x === undefined) ? undefined : (info as DeviceInfo);
}

export type Choice = "once" | "chat" | "time" | "deny";
const CHOICES: readonly Choice[] = ["once", "chat", "time", "deny"];

/**
 * The longest command or path of an approval, in characters: the client's own limit (its `MAX_APPROVAL_TEXT` is 64 KiB, and a
 * character is at least a byte). The client cuts what is longer, says `cut` and offers only a deny, since nobody could read
 * whole what they would allow. The portal does the same with what it has to cut itself.
 */
const MAX_APPROVAL_TARGET = 64 * 1024;

export interface ApprovalInfo {
  id: number;
  call: number | string | null;
  chat: string;
  tool: string;
  target: string;
  reasons: string[];
  preview: string | null;
  choices: Choice[];
  max_minutes: number;
  created_ms: number;
  expires_ms: number;
  /** The command or path is not all there (the device cut it, or the portal did): it can only be denied. */
  cut: boolean;
}

/** An approval the device asks for (`approval.requested`, or one of `approval.list`), or undefined. */
export function readApproval(v: unknown): ApprovalInfo | undefined {
  if (!isObject(v)) return undefined;
  const id = int(v.id);
  const call = v.call === null || v.call === undefined ? null : typeof v.call === "string" ? text(v.call, 128) : int(v.call);
  const chat = text(v.chat, 128);
  const tool = text(v.tool, 32);
  const target = typeof v.target === "string" ? v.target : undefined;
  const reasons = textList(v.reasons, 16, 500);
  const preview = v.preview === null || v.preview === undefined ? null : typeof v.preview === "string" ? v.preview.slice(0, 4000) : undefined;
  const choices = Array.isArray(v.choices) && v.choices.every((c) => CHOICES.includes(c as Choice)) ? (v.choices as Choice[]) : undefined;
  const max_minutes = int(v.max_minutes, 0, 1_000_000);
  const created_ms = int(v.created_ms);
  const expires_ms = int(v.expires_ms);
  if ([id, call, chat, tool, target, reasons, preview, choices, max_minutes, created_ms, expires_ms].some((x) => x === undefined)) return undefined;
  const cut = v.cut === true || target!.length > MAX_APPROVAL_TARGET;
  return {
    id: id!,
    call: call!,
    chat: chat!,
    tool: tool!,
    target: target!.length > MAX_APPROVAL_TARGET ? `${target!.slice(0, MAX_APPROVAL_TARGET - 1)}…` : target!,
    reasons: reasons!,
    preview: preview!,
    // Whatever the device offers for it: a cut one takes only a deny, here as on the device.
    choices: cut ? ["deny"] : choices!,
    max_minutes: max_minutes!,
    created_ms: created_ms!,
    expires_ms: expires_ms!,
    cut,
  };
}

export interface ExecExit {
  stream: number;
  code: number | null;
  signal: string | null;
  timed_out: boolean;
  truncated: boolean;
  /** Set by the portal, never read from a device: the command printed more than the portal takes, and was killed. */
  cut?: boolean;
}

export function readExecExit(v: unknown): ExecExit | undefined {
  if (!isObject(v)) return undefined;
  const stream = int(v.stream, 0, 0xffffffff);
  const code = v.code === null || v.code === undefined ? null : typeof v.code === "number" && Number.isInteger(v.code) ? v.code : undefined;
  const signal = v.signal === null || v.signal === undefined ? null : text(v.signal, 32);
  if (stream === undefined || code === undefined || signal === undefined) return undefined;
  return { stream, code, signal, timed_out: v.timed_out === true, truncated: v.truncated === true };
}

export interface AuditEvent {
  time_ms: number;
  chat: string | null;
  tool: string;
  target: string;
  decision: string;
  reason: string | null;
}

export function readAudit(v: unknown): AuditEvent | undefined {
  if (!isObject(v)) return undefined;
  const time_ms = int(v.time_ms);
  const chat = v.chat === null || v.chat === undefined ? null : text(v.chat, 128);
  const tool = text(v.tool, 64);
  const target = typeof v.target === "string" ? v.target.slice(0, 2000) : undefined;
  const decision = text(v.decision, 64);
  const reason = v.reason === null || v.reason === undefined ? null : typeof v.reason === "string" ? v.reason.slice(0, 1000) : undefined;
  if ([time_ms, chat, tool, target, decision, reason].some((x) => x === undefined)) return undefined;
  return { time_ms: time_ms!, chat: chat!, tool: tool!, target: target!, decision: decision!, reason: reason! };
}

export interface PolicyDocument {
  portal_policy: string;
  version: string;
  settings: Record<string, unknown>;
  device_only: string[];
}

/**
 * What the portal keeps of a device's settings: they are the device's own words,
 * held while it is connected and sent to the page on every poll. A real document
 * nests a few levels and weighs a few KiB. Deeper than this, a document is one
 * that JSON.stringify (recursive on Node 22) cannot write, and the device list
 * would answer 500; larger, it is memory and bandwidth for nothing.
 */
export const MAX_SETTINGS_DEPTH = 32;
export const MAX_SETTINGS_CHARS = 256 * 1024;

/** Whether a parsed JSON value nests no deeper than `limit`. Walks without recursion, as it is asked of documents deeper than the stack. */
function nestsWithin(value: unknown, limit: number): boolean {
  const open: [object, number][] = [[value as object, 1]];
  while (open.length) {
    const [node, depth] = open.pop()!;
    if (depth > limit) return false;
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      if (typeof child === "object" && child !== null) open.push([child, depth + 1]);
    }
  }
  return true;
}

/** `policy.get`'s result (or `policy.changed`'s params), or undefined when it is not a settings document or it is too deep or too large to keep. */
export function readPolicy(v: unknown): PolicyDocument | undefined {
  if (!isObject(v) || !isObject(v.settings)) return undefined;
  const portal_policy = v.portal_policy === "read" || v.portal_policy === "write" ? v.portal_policy : undefined;
  const version = text(v.version, 128);
  const device_only = textList(v.device_only, 256, 256);
  if (!portal_policy || version === undefined || !device_only) return undefined;
  // The depth first: only a document that is not too deep can be written out to measure it.
  if (!nestsWithin(v.settings, MAX_SETTINGS_DEPTH) || JSON.stringify(v.settings).length > MAX_SETTINGS_CHARS) return undefined;
  return { portal_policy, version, settings: v.settings, device_only };
}

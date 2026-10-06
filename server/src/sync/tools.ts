import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { taintedNow } from "../pi/guard.js";
import { grantsOf, devicePath, grantedByName, trackCall, type Grant } from "./grants.js";
import { linkOf, type DeviceLink, type Waiting } from "./hub.js";
import { CODE, DEVICE_TOOLS_SOURCE, DeviceError, PI_TOOLS, type Ctx, type PiTool } from "./protocol.js";
import { devicesEnabled, getDevice, type DeviceRecord } from "./store.js";

/**
 * The agent's file and shell tools on a paired device (architecture, 3.1).
 *
 * Once a chat has a grant, `read`, `write`, `edit`, `bash`, `grep`, `find` and
 * `ls` are registered again under their own names with one more parameter,
 * `device`. Without it, read, write, edit and bash are pi's own and act on the
 * server as before; with it, the same pi tool runs with its file and shell
 * operations on the device, over the hub. grep, find and ls take a device
 * always: pi leaves them inactive on the server, and a grant is no reason to
 * switch them on there.
 *
 * Nothing falls back to the server: a device that is not granted, not
 * connected or has the tool switched off is an error that names the granted
 * ones. pi cannot take a tool back, so once registered the tools stay for the
 * life of the chat's pi and fail closed after the last grant ends; grep, find
 * and ls are then switched off again.
 *
 * The device decides every call on its own (mode, folders, protections,
 * approvals). The portal only says which chat a call is for, whether the guard
 * saw that chat read something untrusted, and which tool it is.
 */

/** The ones that only act on a device. */
const DEVICE_ONLY = new Set<PiTool>(["grep", "find", "ls"]);

const FACTORY: Record<PiTool, string> = {
  read: "createReadToolDefinition",
  write: "createWriteToolDefinition",
  edit: "createEditToolDefinition",
  bash: "createBashToolDefinition",
  grep: "createGrepToolDefinition",
  find: "createFindToolDefinition",
  ls: "createLsToolDefinition",
};

/** Tools of the seven names another extension owns in a chat, which then cannot take a device: said on the chat's device chip. */
const conflicts = new Map<string, PiTool[]>();
export const deviceToolConflicts = (sessionId: string): PiTool[] => conflicts.get(sessionId) ?? [];

export interface DeviceToolsOptions {
  sessionId: string;
  /** The chat's folder on the server. */
  cwd: string;
  /** pi itself, for its tool factories. */
  pi: any;
  /** pi's own definition of a tool as the session built it, with its settings (shell, prefix, image resizing); read at each call. */
  serverTool: (name: PiTool) => any | undefined;
}

/** An error the agent reads: what the device said, and which device said it. */
function failure(e: unknown, device: string): Error {
  if (!(e instanceof DeviceError)) return e instanceof Error ? e : new Error(String(e));
  if (e.code === CODE.DENIED) return new Error(`${device} refused: ${e.message}`);
  if (e.code === CODE.NOT_FOUND) return new Error(`Not found on ${device}: ${e.message}`);
  if (e.code === CODE.CONFLICT) return new Error(`The file changed on ${device} since it was read. Read it again, then edit.`);
  if (e.code === CODE.BAD_PATH) return new Error(`${device} cannot use this path: ${e.message}`);
  if (e.code === CODE.TOO_LARGE) return new Error(`Too large for ${device}: ${e.message}`);
  if (e.code === CODE.BUSY) return new Error(`${device} is busy: ${e.message}. Try again in a moment.`);
  return new Error(`${device}: ${e.message}`);
}

/** The pictures pi's read shows as pictures, by their first bytes. */
function imageType(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (data.subarray(0, 2).toString("latin1") === "BM" && data.length > 14) return "image/bmp";
  return undefined;
}

/** The extension factory: see the comment at the top. */
export function deviceTools(opts: DeviceToolsOptions) {
  // Once the tools are registered in this chat's pi they stay, through every reload: see the top.
  let registered = false;
  return (api: any): void => {
    const on = devicesEnabled();
    const grants = on ? grantsOf(opts.sessionId) : [];
    const registering = grants.length > 0 || registered;
    // Which tools another extension owns is known from the chat's start, grant or not: the first grant is refused for it, and not only the next.
    if (!registering && !on) return;
    registered = registering;
    const granted = grants.flatMap((g) => {
      const device = getDevice(g.deviceId);
      return device ? [{ device, grant: g }] : [];
    });
    const names = granted.map((g) => g.device.name);
    if (registering) for (const name of PI_TOOLS) api.registerTool(definition(name, names, granted));

    api.on("session_start", () => {
      let all: any[] = [];
      try {
        all = api.getAllTools?.() ?? [];
      } catch {
        // No tools to read: nothing to say about them.
      }
      // pi's own tools are what a grant replaces; any other source of these names keeps them, and the device tools are not registered.
      conflicts.set(
        opts.sessionId,
        PI_TOOLS.filter((n) => {
          const tool = all.find((t) => t?.name === n);
          const source = String(tool?.sourceInfo?.path ?? "");
          return tool && source !== `<inline:${DEVICE_TOOLS_SOURCE}>` && !source.startsWith("<builtin:");
        }),
      );
      // Left from an earlier grant: grep, find and ls take only a device, and there is none.
      if (registering && !granted.length) {
        const active: string[] = (api.getActiveTools?.() ?? []).map((t: any) => (typeof t === "string" ? t : t?.name));
        const left = active.filter((n) => !DEVICE_ONLY.has(n as PiTool));
        if (left.length !== active.length) api.setActiveTools(left);
      }
    });
  };

  function definition(name: PiTool, names: string[], granted: { device: DeviceRecord; grant: Grant }[]) {
    const base = opts.pi[FACTORY[name]](opts.cwd);
    const only = DEVICE_ONLY.has(name);
    const which = names.length ? `one of ${names.join(", ")}` : "no device is granted to this chat now";
    const device = Type.String({
      description: only
        ? `The paired computer to act on: ${which}.`
        : `A paired computer to act on instead of the server: ${which}. Omit it for the server.`,
    });
    const parameters = Type.Object({ ...base.parameters.properties, device: only ? device : Type.Optional(device) }, { additionalProperties: false });
    // Said once, with read: the tools' guidelines are one list in the prompt. Online state stays out, so the prompt does not change with it.
    // The folder is quoted: it is the device's own text, and a quoted one cannot read as an instruction of its own.
    const listed = granted.map(({ device: d, grant }) => `${d.name} (${d.os}, folder ${grant.cwd ? JSON.stringify(grant.cwd) : "its home"})`).join("; ");
    const guidelines = [
      ...(base.promptGuidelines ?? []),
      ...(name === "read" && listed
        ? [
            `Devices granted to this chat: ${listed}. Pass device: "<name>" to read, write, edit, bash, grep, find or ls to act there; without it read, write, edit and bash act on the server, and grep, find and ls need a device. A device's bash runs that device's shell. Subagents, background jobs and MCP tools always act on the server.`,
          ]
        : []),
    ];
    return {
      ...base,
      description: only ? `${base.description} Runs on a paired computer (device).` : `${base.description} Pass device to run on a paired computer instead of the server.`,
      parameters,
      promptGuidelines: guidelines.length ? guidelines : undefined,
      renderCall: undefined,
      renderResult: undefined,
      async execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
        const { device: wanted, ...rest } = params ?? {};
        if (wanted === undefined || wanted === null) {
          if (only) throw new Error(`${name} acts only on a paired computer: pass device (${which}). For the server, use bash.`);
          const server = opts.serverTool(name) ?? opts.pi[FACTORY[name]](opts.cwd);
          return server.execute(toolCallId, rest, signal, onUpdate, ctx);
        }
        return onDevice(name, String(wanted), name === "bash" ? asWritten(rest, toolCallId, ctx) : rest, signal, onUpdate, ctx);
      },
    };
  }

  /** The device a call names, connected and granted, or the error that says why not. Read anew at each call. */
  function reach(name: PiTool, wanted: string): { link: DeviceLink; device: DeviceRecord; grant: Grant } {
    if (!devicesEnabled()) throw new Error("Devices are switched off in this portal. Nothing can act on a paired computer now.");
    const names = grantsOf(opts.sessionId).flatMap((g) => getDevice(g.deviceId)?.name ?? []);
    const found = grantedByName(opts.sessionId, wanted);
    if (!found) {
      throw new Error(
        names.length
          ? `No device called "${wanted}" is granted to this chat. Granted: ${names.join(", ")}.`
          : "No device is granted to this chat. Its owner grants one in the chat's Devices menu.",
      );
    }
    const link = linkOf(found.device.id);
    if (!link?.info) throw new Error(`${found.device.name} is not connected right now. Nothing was done; try again once it is, or ask the user.`);
    if (link.sameMachine) throw new Error(`${found.device.name} is the portal's own machine and user: use the tools without device.`);
    if (!link.info.tools.includes(name)) throw new Error(`${found.device.name} has switched the ${name} tool off.`);
    const capability = name === "bash" ? "exec" : name === "grep" ? "grep" : name === "find" ? "find" : "fs";
    if (!link.can(capability)) throw new Error(`${found.device.name} does not offer ${name}.`);
    return { link, ...found };
  }

  async function onDevice(name: PiTool, wanted: string, params: Record<string, unknown>, stop: AbortSignal | undefined, onUpdate: any, ctx: any) {
    const reached = reach(name, wanted);
    // The call ends with the grant too (see grants.ts): the command is told to stop, the approval it waits on is denied.
    const track = trackCall(opts.sessionId, reached.device.id);
    try {
      return await onReached(name, reached, params, stop ? AbortSignal.any([stop, track.signal]) : track.signal, onUpdate, ctx);
    } catch (e) {
      if (track.signal.aborted && !stop?.aborted) throw new Error(`${reached.device.name} was taken back from this chat, so this call was stopped.`);
      throw e;
    } finally {
      track.done();
    }
  }

  async function onReached(
    name: PiTool,
    { link, device, grant }: { link: DeviceLink; device: DeviceRecord; grant: Grant },
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: any,
    ctx: any,
  ) {
    const info = link.info!;
    const cwd = grant.cwd || devicePath(info.home, info, "/")!;
    const where = (p: unknown, fallback = ".") => {
      const abs = devicePath(typeof p === "string" && p ? p : fallback, info, cwd);
      if (!abs) throw new Error(`${device.name} cannot use this path: it has a NUL byte`);
      return abs;
    };
    const call = (): Ctx => ({ chat: opts.sessionId, tainted: taintedNow(opts.sessionId), tool: name });
    // What the device asks its owner while a call waits is a card in the chat's page, read from the device's open approvals (see
    // api/devices.ts); here the call only says that it waits. The card goes when the approval does: answered anywhere, or the call ended.
    const waiting: Waiting = { signal, onApproval: () => onUpdate?.({ content: [{ type: "text", text: `Waiting for approval on ${device.name}…` }], details: undefined }) };
    const guarded = async <T,>(work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } catch (e) {
        throw failure(e, device.name);
      }
    };

    switch (name) {
      case "read": {
        const files = new Map<string, Buffer>();
        const fetch = async (abs: string) => files.get(abs) ?? files.set(abs, (await link.readFile(abs, call(), waiting)).data).get(abs)!;
        const tool = opts.pi.createReadToolDefinition(cwd, {
          operations: {
            access: async (abs: string) => void (await fetch(abs)),
            readFile: fetch,
            detectImageMimeType: async (abs: string) => imageType(await fetch(abs)),
          },
        });
        return guarded(() => tool.execute("", { ...params, path: where(params.path) }, signal, undefined, ctx));
      }
      case "write": {
        const tool = opts.pi.createWriteToolDefinition(cwd, {
          operations: {
            // Folders are made with the file, by the device (create_dirs), so that one approval covers both.
            mkdir: async () => {},
            writeFile: async (abs: string, content: string) => void (await link.writeFile(abs, Buffer.from(content, "utf8"), { createDirs: true }, call(), waiting)),
          },
        });
        return guarded(() => tool.execute("", { ...params, path: where(params.path) }, signal, undefined, ctx));
      }
      case "edit": {
        // Read, patched here, written back only if nobody changed it meanwhile (if_match).
        const read = new Map<string, { data: Buffer; sha256: string }>();
        const fetch = async (abs: string) => read.get(abs) ?? read.set(abs, await link.readFile(abs, call(), waiting)).get(abs)!;
        const tool = opts.pi.createEditToolDefinition(cwd, {
          operations: {
            access: async (abs: string) => void (await fetch(abs)),
            readFile: async (abs: string) => (await fetch(abs)).data,
            writeFile: async (abs: string, content: string) =>
              void (await link.writeFile(abs, Buffer.from(content, "utf8"), { ifMatch: (await fetch(abs)).sha256 }, call(), waiting)),
          },
        });
        const args = typeof tool.prepareArguments === "function" ? tool.prepareArguments({ ...params }) : params;
        return guarded(() => tool.execute("", { ...args, path: where(args.path) }, signal, undefined, ctx));
      }
      case "bash": {
        const tool = opts.pi.createBashToolDefinition(cwd, {
          // Nothing of the portal's environment, nor pi's PI_* variables: the device runs commands in its own.
          exposeSessionEnvironment: false,
          operations: {
            exec: async (command: string, dir: string, o: { onData: (d: Buffer) => void; signal?: AbortSignal; timeout?: number }) => {
              const timeoutMs = commandTimeoutMs(o.timeout);
              let exit;
              try {
                exit = await link.exec({ command, cwd: dir, timeoutMs, ctx: call(), onData: o.onData, signal: o.signal, onApproval: waiting.onApproval });
              } catch (e) {
                if (o.signal?.aborted) throw new Error("aborted");
                throw failure(e, device.name);
              }
              if (exit.cut) o.onData(Buffer.from(`\n[${device.name} sent more output than the portal takes, so the command was stopped]\n`));
              else if (exit.truncated) o.onData(Buffer.from(`\n[${device.name} dropped the output past its limit]\n`));
              if (o.signal?.aborted) throw new Error("aborted");
              if (exit.timed_out && o.timeout) throw new Error(`timeout:${o.timeout}`);
              if (exit.timed_out) {
                // The device's own limit, not one the agent gave: said in the output, and ended as `timeout` ends one.
                o.onData(Buffer.from(`\n[${device.name} stopped the command at its time limit]\n`));
                return { exitCode: 124 };
              }
              if (exit.code === null && exit.signal) return { exitCode: 128 + (SIGNALS[exit.signal] ?? 1) };
              return { exitCode: exit.code };
            },
          },
        });
        // pi keeps the whole output of a long command in a file of the portal's temp folder and points the model at it. For a command
        // on a device that is a file per command, up to the cap, which nothing ever removes (and on a tmpfs it is memory): it goes
        // when the command is over, and the model is told that the full output is not kept.
        const logs = new Set<string>();
        const noted = (r: any) => {
          const log = r?.details?.fullOutputPath;
          if (isPiLog(log)) logs.add(log);
        };
        try {
          const result = await tool.execute("", params, signal, (update: any) => (noted(update), onUpdate?.(withoutLog(update, logs))), ctx);
          noted(result);
          return withoutLog(result, logs);
        } catch (e) {
          if (e instanceof Error) e.message = withoutPath(e.message, logs);
          throw e;
        } finally {
          for (const log of logs) rmSync(log, { force: true });
        }
      }
      case "ls":
        return guarded(async () => {
          const dir = where(params.path);
          const limit = positive(params.limit) ?? 500;
          const listed = (await link.call("fs.list", { path: dir, ctx: call() }, waiting)) as { entries?: { name: string; kind: string }[]; truncated?: boolean };
          const entries = (listed?.entries ?? []).filter((e) => typeof e?.name === "string").sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
          if (!entries.length) return text("(empty directory)");
          const shown = entries.slice(0, limit).map((e) => e.name + (e.kind === "dir" ? "/" : ""));
          const notices = [];
          if (entries.length > limit) notices.push(`${limit} entries limit reached. Use limit=${limit * 2} for more`);
          if (listed?.truncated) notices.push(`${device.name} lists at most 20000 entries`);
          return text(bounded(shown.join("\n"), notices));
        });
      case "find":
        return guarded(async () => {
          const dir = where(params.path);
          const limit = Math.min(positive(params.limit) ?? 1000, 10_000);
          const found = (await link.call("fs.find", { path: dir, pattern: String(params.pattern ?? ""), limit, ctx: call() }, waiting)) as { paths?: string[]; truncated?: boolean; skipped?: number };
          const paths = (found?.paths ?? []).filter((p) => typeof p === "string");
          if (!paths.length) return text(`No files found matching pattern${skippedAfter(found?.skipped, device.name)}`);
          const notices = [];
          if (found?.truncated || paths.length >= limit) notices.push(`${limit} results limit reached`);
          if (found?.skipped) notices.push(skippedNote(found.skipped, device.name));
          return text(bounded(paths.map((p) => relative(dir, p)).join("\n"), notices));
        });
      case "grep":
        return guarded(async () => {
          const dir = where(params.path);
          const limit = Math.min(positive(params.limit) ?? 100, 10_000);
          const context = positive(params.context, true) ?? 0;
          const found = (await link.call(
            "fs.grep",
            {
              path: dir,
              pattern: String(params.pattern ?? ""),
              ...(typeof params.glob === "string" ? { glob: params.glob } : {}),
              ignore_case: params.ignoreCase === true,
              literal: params.literal === true,
              context,
              limit,
              ctx: call(),
            },
            waiting,
          )) as { lines?: { path: string; line: number; text: string; context: boolean }[]; truncated?: boolean; skipped?: number };
          const lines = (found?.lines ?? []).filter((l) => typeof l?.path === "string");
          if (!lines.length) return text(`No matches found${skippedAfter(found?.skipped, device.name)}`);
          let cut = false;
          const out = lines.map((l) => {
            const file = l.path === dir ? path.posix.basename(l.path) : relative(dir, l.path);
            const clean = String(l.text ?? "").replace(/\r/g, "");
            const shown = clean.length > 500 ? `${clean.slice(0, 500)}... [truncated]` : clean;
            if (shown !== clean) cut = true;
            return l.context ? `${file}-${l.line}- ${shown}` : `${file}:${l.line}: ${shown}`;
          });
          const notices = [];
          if (found?.truncated || lines.filter((l) => !l.context).length >= limit) notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
          if (cut) notices.push("Some lines truncated to 500 chars. Use read tool to see full lines");
          if (found?.skipped) notices.push(skippedNote(found.skipped, device.name));
          return text(bounded(out.join("\n"), notices));
        });
    }

    function text(t: string) {
      return { content: [{ type: "text", text: t }], details: undefined };
    }
    /** pi's byte limit on what a listing gives the model, and the notices after it. */
    function bounded(raw: string, notices: string[]): string {
      const truncation = opts.pi.truncateHead(raw, { maxLines: Number.MAX_SAFE_INTEGER });
      if (truncation.truncated) notices.push(`${opts.pi.formatSize(opts.pi.DEFAULT_MAX_BYTES)} limit reached`);
      return truncation.content + (notices.length ? `\n\n[${notices.join(". ")}]` : "");
    }
  }
}

/**
 * The call's params with the command as the model wrote it.
 *
 * Every extension's `tool_call` handler may rewrite `input.command` of any tool called "bash" in place, and the device's bash has
 * that name: a command optimiser that puts `rtk` in front of it checked for rtk on the portal, and the device has none. The
 * rewrite is made on a copy that pi validates the params into; the assistant message pi keeps in the session still has what the
 * model wrote, and it is there before any tool runs. That, and not a handler of ours, because which handler runs first is not
 * ours to say (installed packages' extensions go before the portal's). Without a session to read (a call outside pi), or when
 * the message has more than one call with this id (which one this is cannot be told), the params stay as they are.
 */
function asWritten(params: Record<string, unknown>, toolCallId: string, ctx: any): Record<string, unknown> {
  try {
    const sessions = ctx?.sessionManager;
    // The newest assistant message is the one whose calls are running; the results of its other calls may be after it.
    let entry = sessions?.getLeafEntry?.();
    while (entry && !(entry.type === "message" && entry.message?.role === "assistant")) {
      entry = entry.parentId ? sessions.getEntry(entry.parentId) : undefined;
    }
    // Only a call that the message names once: a provider that sends no ids, or repeats one, gives two calls the same, and the first's
    // command must not run for the second.
    const named = (entry?.message?.content ?? []).filter((c: any) => c?.type === "toolCall" && c.id === toolCallId && c.name === "bash");
    const command = named.length === 1 ? named[0].arguments?.command : undefined;
    return typeof command === "string" ? { ...params, command } : params;
  } catch {
    return params;
  }
}

/** The longest timeout pi's bash takes, in ms: the longest a timer waits. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** pi's own check of a bash command's timeout (seconds), which its local shell makes and a device's operations do not go through; in ms. */
function commandTimeoutMs(timeout: unknown): number | undefined {
  if (timeout === undefined) return undefined;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid timeout: must be a finite number of seconds");
  if (timeout * 1000 > MAX_TIMEOUT_MS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
  return timeout * 1000;
}

/** The file pi writes a command's full output to: in the temp folder, by this name, and no other path is removed. */
const isPiLog = (p: unknown): p is string => typeof p === "string" && path.dirname(p) === os.tmpdir() && /^pi-bash-[0-9a-f]{16}\.log$/.test(path.basename(p));

const NOT_KEPT = "The full output is not kept";

/** pi's text with the pointer to a log that is removed replaced by saying so. */
const withoutPath = (text: string, logs: Set<string>): string => [...logs].reduce((t, log) => t.replaceAll(`Full output: ${log}`, NOT_KEPT), text);

/** A tool result or update of pi's bash as the model and the chat see it: nothing points at a log that is removed. */
function withoutLog(result: any, logs: Set<string>): any {
  if (!result || typeof result !== "object") return result;
  return {
    ...result,
    content: Array.isArray(result.content) ? result.content.map((part: any) => (part?.type === "text" && typeof part.text === "string" ? { ...part, text: withoutPath(part.text, logs) } : part)) : result.content,
    details: result.details && typeof result.details === "object" ? { ...result.details, fullOutputPath: undefined } : result.details,
  };
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };

const positive = (v: unknown, zero = false): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && (zero ? v >= 0 : v > 0) ? Math.floor(v) : undefined;

/** A device path as pi's find and grep give theirs: from the folder searched. */
const relative = (dir: string, p: string): string => {
  const rel = path.posix.relative(dir, p);
  return rel && !rel.startsWith("..") ? rel : p;
};

const skippedNote = (skipped: number | undefined, device: string): string =>
  skipped ? `${skipped} files left out by ${device}: protected, outside its folders or unreadable` : "";
const skippedAfter = (skipped: number | undefined, device: string): string => (skipped ? ` (${skippedNote(skipped, device)})` : "");


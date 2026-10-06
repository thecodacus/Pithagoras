import { X509Certificate, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import express, { type Router } from "express";
import { tlsFiles } from "../http-security.js";
import { getSession } from "../db.js";
import { sessions } from "../session-manager.js";
import { defaultCwd, devicePath, endGrant, grantOf, grantRefused, grantsOf, startGrant, tellEnded } from "../sync/grants.js";
import { deviceToolConflicts } from "../sync/tools.js";
import { CLOSE, CODE, DeviceError, readPolicy, type Choice } from "../sync/protocol.js";
import { alertOf, clearAlert, dropAll, dropDevice, linkOf } from "../sync/hub.js";
import {
  CODE_ATTEMPTS,
  NameTaken,
  cancelPairingCode,
  devicesEnabled,
  devicesOffBecause,
  devicesSwitchedOn,
  getDevice,
  hasPassword,
  listDevices,
  newPairingCode,
  NO_PASSWORD,
  pairingOpen,
  removeDevice,
  renameDevice,
  setDevicesEnabled,
  type DeviceRecord,
} from "../sync/store.js";

/**
 * The SPKI pin of the certificate the portal serves, for the pairing URI: the
 * client pins it, so a self-signed certificate works and no other does. Only
 * when the portal serves TLS itself; behind a TLS proxy the proxy's certificate
 * is the one the device sees, and the system's roots check it.
 */
function spkiPin(): string | null {
  const tls = tlsFiles();
  if (!tls) return null;
  try {
    const der = new X509Certificate(readFileSync(tls.cert)).publicKey.export({ type: "spki", format: "der" });
    return createHash("sha256").update(der).digest("base64url");
  } catch {
    return null;
  }
}

/**
 * Why the add-on cannot be switched on here, or undefined when it can. A portal
 * without a password would hand every paired computer to whoever reaches it.
 */
const devicesRefused = (): string | undefined => (hasPassword() ? undefined : NO_PASSWORD);

/** The switch as Settings shows it: whether the add-on answers, whether it was switched on, and why it cannot answer. */
const feature = () => ({ enabled: devicesEnabled(), switchedOn: devicesSwitchedOn(), refused: devicesRefused() ?? null });

/** A device as the page shows it: the row, and what its live connection says. */
function shown(device: DeviceRecord) {
  const link = linkOf(device.id);
  return {
    ...device,
    online: Boolean(link),
    connectedAt: link ? new Date(link.connectedAt).toISOString() : null,
    remote: link?.remote ?? null,
    hello: link ? { clientVersion: link.hello.client_version, user: link.hello.user, shell: link.hello.shell, capabilities: link.hello.capabilities } : null,
    info: link?.info ?? null,
    sameMachine: link?.sameMachine ?? null,
    approvals: link ? [...link.approvals.values()] : [],
    policy: link?.policy ?? null,
    alert: alertOf(device.id) ?? null,
  };
}

const failed = (res: express.Response, e: unknown) => {
  if (e instanceof DeviceError) {
    const status = e.code === CODE.DENIED ? 403 : e.code === CODE.CONFLICT ? 409 : e.code === CODE.NOT_FOUND ? 404 : e.code === CODE.INVALID_PARAMS ? 400 : 502;
    return res.status(status).json({ error: e.message, code: e.code });
  }
  res.status(500).json({ error: (e as Error).message });
};

const CHOICES: Choice[] = ["once", "chat", "time", "deny"];

/**
 * The Devices add-on: its switch, pairing, the list, and what the owner may do
 * with a connected device from the portal — answer its approvals, and read or
 * change its settings where its owner allowed that on the device.
 */
export function devicesRouter(): Router {
  const router = express.Router();

  router.get("/features/devices", (_req, res) => {
    res.json(feature());
  });

  router.put("/features/devices", async (req, res) => {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled must be true or false" });
    try {
      const was = devicesEnabled();
      if (enabled && devicesRefused()) throw new Error(devicesRefused());
      setDevicesEnabled(enabled);
      if (!enabled) {
        cancelPairingCode();
        // The devices stay paired and try again on their own; until the add-on is back on nothing answers them.
        dropAll(CLOSE.goingAway, "devices switched off");
      }
      // Whether a chat has the device tools is settled when it loads.
      const { reloaded, waiting } = was !== enabled ? await sessions.reloadIdle() : { reloaded: 0, waiting: 0 };
      res.json({ ...feature(), reloaded, waiting });
    } catch (e) {
      res.status(409).json({ error: (e as Error).message });
    }
  });

  // Everything below only while the add-on is on.
  router.use("/devices", (_req, res, next) => {
    if (!devicesEnabled()) return res.status(404).json({ error: devicesOffBecause() });
    next();
  });

  router.get("/devices", (_req, res) => {
    const open = pairingOpen();
    res.json({ devices: listDevices().map(shown), pairing: open ? { expires: new Date(open.expires).toISOString() } : null, spki: spkiPin() });
  });

  /** A new one-time code, which replaces any open one. Said this once: only its expiry is kept to show again. */
  router.post("/devices/pair", (_req, res) => {
    const { code, expires } = newPairingCode();
    res.setHeader("Cache-Control", "no-store");
    res.json({ code, expires: new Date(expires).toISOString(), attempts: CODE_ATTEMPTS, spki: spkiPin() });
  });

  router.delete("/devices/pair", (_req, res) => {
    cancelPairingCode();
    res.json({ ok: true });
  });

  router.put("/devices/:id", (req, res) => {
    if (!getDevice(req.params.id)) return res.status(404).json({ error: "No such device" });
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    try {
      const device = renameDevice(req.params.id, name)!;
      // The chats that have it name it in their prompt: reloaded when idle.
      void sessions.reloadIdle().catch(() => {});
      res.json({ device: shown(device) });
    } catch (e) {
      res.status(e instanceof NameTaken ? 409 : 400).json({ error: (e as Error).message });
    }
  });

  /** Removes a device: its token stops working and its connection is closed now, before the answer, after it was told that its chats' grants are over. */
  router.delete("/devices/:id", (req, res) => {
    const device = getDevice(req.params.id);
    if (!device) return res.status(404).json({ error: "No such device" });
    const chats = removeDevice(device.id);
    // As for any grant that ends: what the chats run there stops, and the device forgets what it allowed them, if it hears. The close follows.
    for (const chat of chats) tellEnded(device.id, chat);
    dropDevice(device.id, CLOSE.revoked, "device removed");
    console.log(`[devices] removed ${device.name}`);
    if (chats.length) void sessions.reloadIdle().catch(() => {});
    res.json({ ok: true });
  });

  router.delete("/devices/:id/alert", (req, res) => {
    clearAlert(req.params.id);
    res.json({ ok: true });
  });

  /** The owner's answer to one of the device's approvals. */
  router.post("/devices/:id/approvals/:approval", async (req, res) => {
    const link = linkOf(req.params.id);
    if (!link) return res.status(409).json({ error: "The device is not connected" });
    const id = Number(req.params.approval);
    const { answer, minutes } = req.body ?? {};
    if (!Number.isInteger(id) || !CHOICES.includes(answer)) return res.status(400).json({ error: "answer must be once, chat, time or deny" });
    if (answer === "time" && !(Number.isInteger(minutes) && minutes >= 1)) return res.status(400).json({ error: "minutes must be a whole number of at least 1" });
    // A question of a chat that no longer has the device (or that was denied for it) is only ever denied: a late Allow, from a page
    // that was open when the grant ended, would let the device run what the chat has no right to any more.
    const asked = link.approvals.get(id);
    if (answer !== "deny" && asked && (link.isDenied(id) || (getSession(asked.chat) && !grantOf(asked.chat, req.params.id)))) {
      link.deny(id);
      return res.status(409).json({ error: "That chat no longer has this device, so the question is denied" });
    }
    try {
      await link.answerApproval(id, answer, minutes);
      res.json({ ok: true });
    } catch (e) {
      failed(res, e);
    }
  });

  /** The device's settings, as it shares them; read anew, so the page shows what holds now. */
  router.get("/devices/:id/policy", async (req, res) => {
    const link = linkOf(req.params.id);
    if (!link) return res.status(409).json({ error: "The device is not connected" });
    if (!link.can("policy")) return res.status(403).json({ error: "The device's owner does not share its settings with the portal" });
    try {
      const policy = readPolicy(await link.call("policy.get", {}, { timeoutMs: 30_000 }));
      if (!policy) return res.status(502).json({ error: "The device answered something that is not its settings" });
      link.policy = policy;
      res.json({ policy });
    } catch (e) {
      failed(res, e);
    }
  });

  /**
   * Changes the device's settings: only where its owner set portal_policy to
   * write on the device, which the device checks, not the portal. Only this
   * route sends policy.set, and only the signed-in owner reaches it: no tool of
   * the agent's does.
   */
  router.put("/devices/:id/policy", async (req, res) => {
    const link = linkOf(req.params.id);
    if (!link) return res.status(409).json({ error: "The device is not connected" });
    const { settings, ifVersion } = req.body ?? {};
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return res.status(400).json({ error: "settings must be an object" });
    if (ifVersion !== undefined && typeof ifVersion !== "string") return res.status(400).json({ error: "ifVersion must be text" });
    try {
      const policy = readPolicy(await link.call("policy.set", { settings, ...(ifVersion ? { if_version: ifVersion } : {}) }, { timeoutMs: 30_000 }));
      if (policy) link.policy = policy;
      res.json({ policy: policy ?? null });
    } catch (e) {
      failed(res, e);
    }
  });

  // --- a chat's devices ---

  router.use("/sessions/:id/devices", (req, res, next) => {
    if (!devicesEnabled()) return res.status(404).json({ error: devicesOffBecause() });
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "No such chat" });
    // Only a chat in the portal: the device's approvals are answered there, which a channel cannot do.
    if (session.kind !== "task") return res.status(409).json({ error: "Devices are granted to chats in the portal only" });
    next();
  });

  /** The paired devices as this chat sees them: which it has, in which folder, and which it could have. */
  router.get("/sessions/:id/devices", (req, res) => {
    const grants = new Map(grantsOf(req.params.id).map((g) => [g.deviceId, g]));
    const conflicts = deviceToolConflicts(req.params.id);
    // Said for a device the chat has as well: a grant given before the chat was loaded cannot be refused, and its calls are.
    const blocked = conflicts.length ? `Another extension owns ${conflicts.join(", ")} in this chat, so they cannot take a device` : null;
    res.json({
      devices: listDevices().map((device) => {
        const link = linkOf(device.id);
        const grant = grants.get(device.id);
        const why = blocked
          ? blocked
          : link?.info
            ? grantRefused(device, defaultCwd(link.info))
            : `${device.name} is not connected`;
        return {
          id: device.id,
          name: device.name,
          os: link?.info?.os ?? device.os,
          online: Boolean(link),
          granted: Boolean(grant),
          cwd: grant?.cwd || null,
          home: link?.info ? devicePath(link.info.home, link.info, "/") : null,
          mode: link?.info?.mode ?? null,
          folders: link?.info?.folders.map((f) => ({ ...f, path: devicePath(f.path, link.info!, "/") })) ?? [],
          offered: !why,
          why: why ?? null,
          blocked,
        };
      }),
    });
  });

  /**
   * The questions the chat's devices hold for it, which the chat shows as cards: the owner answers them where they are asked.
   * Read anew each time, so a chat that is opened while one waits shows it, and one that was answered elsewhere is gone.
   */
  router.get("/sessions/:id/devices/approvals", (req, res) => {
    const approvals = grantsOf(req.params.id).flatMap((grant) => {
      const device = getDevice(grant.deviceId);
      const link = linkOf(grant.deviceId);
      if (!device || !link) return [];
      return [...link.approvals.values()].filter((a) => a.chat === req.params.id && !link.isDenied(a.id)).map((approval) => ({ device: { id: device.id, name: device.name }, approval }));
    });
    res.json({ approvals });
  });

  /** Grants the chat a device, in a folder there (its home, or its first folder, unless one is given), or moves the grant to another folder. */
  router.put("/sessions/:id/devices/:deviceId", async (req, res) => {
    const device = getDevice(req.params.deviceId);
    if (!device) return res.status(404).json({ error: "No such device" });
    const conflicts = deviceToolConflicts(req.params.id);
    if (conflicts.length) return res.status(409).json({ error: `Another extension owns ${conflicts.join(", ")} in this chat, so they cannot take a device` });
    const info = linkOf(device.id)?.info;
    if (!info) return res.status(409).json({ error: `${device.name} is not connected` });
    const given = req.body?.cwd;
    if (given !== undefined && given !== null && (typeof given !== "string" || given.length > 4096)) return res.status(400).json({ error: "cwd must be a path" });
    const wanted = typeof given === "string" && given.trim() ? given.trim() : undefined;
    if (wanted && !/^(~(\/|$)|\/|[A-Za-z]:[\\/])/.test(wanted)) return res.status(400).json({ error: "The folder must be an absolute path" });
    const cwd = wanted ? devicePath(wanted, info, "/") : defaultCwd(info);
    const refused = cwd ? grantRefused(device, cwd) : "The folder must be an absolute path";
    if (refused) return res.status(409).json({ error: refused });
    const had = grantsOf(req.params.id).some((g) => g.deviceId === device.id);
    // A new grant waits for the device to confirm it was told the chat's last one is over: a link that went quiet has not been noticed yet.
    const started = await startGrant(req.params.id, device.id, cwd!);
    if (started === "no chat") return res.status(404).json({ error: "No such chat" });
    if (started === "no device") return res.status(404).json({ error: "No such device" });
    if (started === "cancelled") return res.status(409).json({ error: `${device.name} was taken back from this chat before it was granted` });
    if (started === "unreachable") return res.status(409).json({ error: `${device.name} did not answer, so the connection to it is not working. Try again in a moment` });
    console.log(`[devices] ${had ? "moved" : "granted"} ${device.name} for chat ${req.params.id}`);
    res.json({ ok: true, cwd, reload: await sessions.reloadSoon(req.params.id) });
  });

  /** Takes the device back from the chat: its tools fail from the next call, and a device that is connected forgets what it allowed the chat. */
  router.delete("/sessions/:id/devices/:deviceId", async (req, res) => {
    const gone = endGrant(req.params.id, req.params.deviceId);
    if (gone) console.log(`[devices] ended a grant for chat ${req.params.id}`);
    res.json({ ok: true, reload: gone ? await sessions.reloadSoon(req.params.id) : "not running" });
  });

  return router;
}

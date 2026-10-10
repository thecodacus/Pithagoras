import express, { type Router } from "express";
import { PAIR_PATH, isDeviceName } from "./protocol.js";
import { NOT_AVAILABLE, addDevice, devicesEnabled, takePairingCode } from "./store.js";

/**
 * `POST /sync/v1/pair`: a one-time code from the Devices page, traded for a
 * connector token. Before the portal's login, as the device has none; the code
 * is the login, good once, for ten minutes, and cancelled after ten wrong ones
 * (see store.ts). A browser cannot pair: a request that names an Origin is
 * refused, so a page of another site cannot spend a code it was shown.
 *
 * The answer carries the token once. No overlay token yet: nothing in the
 * portal takes one before the desktop app's routes exist (architecture 5.3, PR d).
 */
export function pairRouter(): Router {
  const router = express.Router();
  // Its own small parser: the body is four short fields.
  router.post(PAIR_PATH, express.json({ limit: "4kb" }), (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!devicesEnabled()) return res.status(404).json({ error: NOT_AVAILABLE });
    if (req.headers.origin !== undefined) return res.status(403).json({ error: "Pairing is done by the device, not a browser" });
    const { code, name, os, arch } = req.body ?? {};
    if (typeof code !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(code)) return res.status(400).json({ error: "A code is 1 to 64 letters and digits" });
    if (!isDeviceName(name)) return res.status(400).json({ error: "A device name is 1 to 24 of a-z, 0-9 and -, and not server or portal" });
    if (typeof os !== "string" || !/^[a-z0-9_]{1,32}$/.test(os) || typeof arch !== "string" || !/^[a-z0-9_]{1,32}$/.test(arch)) {
      return res.status(400).json({ error: "os and arch are the client's platform names" });
    }
    if (!takePairingCode(code)) return res.status(403).json({ error: "unknown or expired code" });
    const { device, token } = addDevice({ name, os, arch });
    console.log(`[devices] paired ${device.name} (${device.os} ${device.arch})`);
    res.json({ device_id: device.id, connector_token: token, name: device.name });
  });
  // A body the parser refused, said in JSON as the client reads it.
  router.use(PAIR_PATH, ((err: { status?: number; type?: string }, _req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(err.status ?? 400).json({ error: err.type === "entity.too.large" ? "The request is too large" : "The request was not valid JSON" });
  }) as express.ErrorRequestHandler);
  return router;
}

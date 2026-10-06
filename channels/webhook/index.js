/**
 * The simplest possible channel: an HTTP endpoint.
 *
 * POST { "message": "...", "from": { "id": "..." } } with the shared secret in
 * X-Portal-Secret, and the agent's reply comes back in the response body. The
 * sender can be pinned in the channel's settings instead of sent each time.
 * Useful for wiring the agent into anything that can make a request — cron, a
 * CI job, another service.
 */

import { createServer } from "node:http";

export const manifest = {
  id: "webhook",
  label: "Webhook",
  blurb: "POST a message in, get the agent's reply in the response body.",
  fields: [
    {
      key: "senderId",
      label: "Sender id",
      hint:
        "Pins every message to one person, so the secret is that person's credential. Without " +
        "it the caller names itself in the body (\"from\": {\"id\": \"…\"}) and can claim to be " +
        "anyone holding the secret. A message that names nobody is turned away once a primary " +
        "user is named.",
      placeholder: "priya",
    },
    {
      key: "senderName",
      label: "Sender name",
      placeholder: "Priya",
    },
    {
      key: "callbackUrl",
      label: "Callback URL",
      hint:
        "Optional. Without one this channel can only answer a request that is already open — " +
        "so it never receives anything sent later, like an answer to a question it raised.",
      placeholder: "https://chat.internal/hooks/agent",
    },
    {
      key: "secret",
      label: "Shared secret",
      secret: true,
      required: true,
      hint: "Sent as the X-Portal-Secret header. Requests without it are refused.",
    },
    {
      key: "port",
      label: "Port",
      hint: "Defaults to 4180. Must not clash with the portal or another channel.",
      placeholder: "4180",
    },
  ],
};

const readBody = (req, limit = 1_000_000) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

export async function start(ctx) {
  const secret = ctx.config.secret;
  const port = Number(ctx.config.port) || 4180;

  // Requests whose answer is still being written. One stays open for the whole of
  // an agent turn, so stopping has to tell them rather than wait for them.
  const open = new Set();

  const server = createServer(async (req, res) => {
    open.add(res);
    res.on("close", () => open.delete(res));
    const send = (status, payload) => {
      // Said once: a turn that ends after the channel was stopped has nobody to tell.
      if (res.headersSent || res.destroyed) return;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (req.method !== "POST") return send(405, { error: "POST only" });

    // Compared in full rather than short-circuiting on the first wrong byte.
    const given = req.headers["x-portal-secret"];
    if (typeof given !== "string" || !timingSafeEqual(given, secret)) {
      return send(401, { error: "Bad or missing X-Portal-Secret" });
    }

    let message;
    let session;
    let from = null;
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      message = typeof body.message === "string" ? body.message.trim() : "";
      // Configured identity wins. Pinned this way the secret *is* the person's
      // credential and a caller cannot claim to be somebody else; left unset,
      // the caller names itself and is trusted exactly as far as the secret is.
      from = ctx.config.senderId
        ? { id: String(ctx.config.senderId), name: String(ctx.config.senderName || ctx.config.senderId) }
        : body.from && typeof body.from.id === "string" && body.from.id
          ? { id: body.from.id, name: typeof body.from.name === "string" ? body.from.name : body.from.id }
          : null;
      // Only the caller knows what counts as a conversation here, so it picks.
      // Everything without one shares a single session, which is what you want
      // for a cron job talking to itself.
      session = (typeof body.session === "string" && body.session.trim()) || "default";
    } catch {
      return send(400, { error: "Body must be JSON" });
    }
    if (!message) return send(400, { error: "message required" });

    try {
      const reply = await ctx.ask(message, { session, title: `Webhook ${session}`, from });
      send(200, { reply });
    } catch (e) {
      ctx.log(`request failed: ${e.message}`);
      send(500, { error: e.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  ctx.log(`listening on :${port}`);

  return {
    async stop() {
      const closed = new Promise((resolve) => server.close(resolve));
      for (const res of open) {
        if (res.headersSent) continue;
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "This channel is stopping" }));
      }
      // Whatever has not hung up by now is cut: server.close() waits for every
      // connection, and a keep-alive one can sit there for as long as it likes.
      const cut = setTimeout(() => server.closeAllConnections?.(), 500);
      server.closeIdleConnections?.();
      await closed;
      clearTimeout(cut);
    },

    ...(ctx.config.callbackUrl
      ? {
          /**
           * Speak first, when somebody has said where to.
           *
           * The conversation key travels with the message: the receiving end has
           * to know which of its conversations this belongs to, and it is the
           * one that chose the key in the first place.
           */
          async send(target, text) {
            const res = await fetch(ctx.config.callbackUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ session: target, message: text }),
              signal: ctx.signal,
            });
            if (!res.ok) throw new Error(`Callback returned ${res.status}`);
          },
        }
      : {}),
  };
}

/** Constant time for equal-length input; length itself is not secret here. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Discord, over the Gateway.
 *
 * The Gateway is a plain WebSocket the bot keeps open, with a heartbeat it must
 * send on an interval Discord dictates. Miss the heartbeats and the connection
 * is dropped, so most of the code here is keeping that contract rather than
 * handling messages.
 *
 * Replies go back over the REST API — the Gateway is receive-only in practice.
 */

const API = "https://discord.com/api/v10";

// GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT.
// MESSAGE_CONTENT is privileged: without it every message arrives with empty
// content and the bot looks broken rather than unauthorised.
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15);

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

export const manifest = {
  id: "discord",
  label: "Discord",
  blurb: "Message the bot in a server channel or a DM.",
  fields: [
    {
      key: "botToken",
      label: "Bot token",
      secret: true,
      required: true,
      hint: "Developer Portal → Bot. Enable the Message Content intent there too, or messages arrive empty.",
    },
    {
      key: "channelId",
      label: "Channel ID",
      hint: "Restrict to one channel. Empty means anywhere the bot can see.",
      placeholder: "1234567890123456789",
    },
    {
      key: "requireMention",
      label: "Only when mentioned",
      hint: "Set to \"true\" to ignore messages that do not @ the bot. Sensible in a busy server.",
      placeholder: "false",
    },
  ],
};

async function rest(token, path, body, signal) {
  const res = await fetch(API + path, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bot ${token}`,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${path} → ${res.status} ${detail.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

export async function start(ctx) {
  const token = ctx.config.botToken;
  const onlyChannel = String(ctx.config.channelId || "").trim();
  const requireMention = /^(1|true|yes)$/i.test(String(ctx.config.requireMention || ""));

  const self = await rest(token, "/users/@me", null, ctx.signal);
  ctx.log(`connected as ${self.username}`);

  const { url } = await rest(token, "/gateway/bot", null, ctx.signal);

  let socket = null;
  let heartbeat = null;
  let lastSeq = null;
  let acked = true;
  let stopped = false;

  const clearHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  };

  const connect = () => {
    if (stopped || ctx.signal.aborted) return;

    socket = new WebSocket(`${url}/?v=10&encoding=json`);

    socket.addEventListener("message", async (frame) => {
      let packet;
      try {
        packet = JSON.parse(frame.data);
      } catch {
        return;
      }
      if (packet.s !== null && packet.s !== undefined) lastSeq = packet.s;

      switch (packet.op) {
        case OP.HELLO: {
          clearHeartbeat();
          acked = true;
          heartbeat = setInterval(() => {
            // A missed ack means the connection is half-open: it looks fine and
            // delivers nothing. Tear it down rather than sit there silently.
            if (!acked) {
              ctx.log("no heartbeat ack — reconnecting");
              socket.close();
              return;
            }
            acked = false;
            socket.send(JSON.stringify({ op: OP.HEARTBEAT, d: lastSeq }));
          }, packet.d.heartbeat_interval);

          socket.send(
            JSON.stringify({
              op: OP.IDENTIFY,
              d: {
                token,
                intents: INTENTS,
                properties: { os: "linux", browser: "pithagoras", device: "pithagoras" },
              },
            })
          );
          return;
        }

        case OP.HEARTBEAT:
          socket.send(JSON.stringify({ op: OP.HEARTBEAT, d: lastSeq }));
          return;

        case OP.HEARTBEAT_ACK:
          acked = true;
          return;

        case OP.RECONNECT:
        case OP.INVALID_SESSION:
          socket.close();
          return;

        case OP.DISPATCH:
          break;

        default:
          return;
      }

      if (packet.t !== "MESSAGE_CREATE") return;
      const message = packet.d;

      // Bots ignoring bots is what stops two of these talking to each other
      // until someone notices the bill.
      if (message.author?.bot) return;
      if (onlyChannel && message.channel_id !== onlyChannel) return;

      const mentioned = (message.mentions ?? []).some((m) => m.id === self.id);
      if (requireMention && !mentioned) return;

      const text = stripMention(message.content || "", self.id).trim();
      if (!text) return;

      try {
        // A DM is a channel as far as Discord is concerned, so keying on the
        // channel separates DMs from servers with no extra work.
        const say = async (body) => {
          // Discord rejects anything over 2000 characters.
          for (const chunk of split(body, 1900)) {
            await rest(token, `/channels/${message.channel_id}/messages`, { content: chunk });
          }
        };
        // Relayed between tool calls, so a long task is visibly working. What
        // comes back is the rest: the whole answer when nothing is relayed, and
        // always the portal's own words ("Stopped.", the refusal a stranger gets).
        const reply = await ctx.ask(text, {
          session: `channel:${message.channel_id}`,
          from: message.author?.id
            ? {
                id: String(message.author.id),
                name: message.author.global_name || message.author.username || String(message.author.id),
              }
            : null,
          title: message.guild_id
            ? `Discord ${message.channel_id}`
            : `DM ${message.author?.username ?? message.channel_id}`,
          channel: message.channel_id,
          user: message.author?.id,
          guild: message.guild_id,
          onReply: say,
        });
        if (reply) await say(reply);
      } catch (e) {
        ctx.log(`failed to answer in ${message.channel_id}: ${e.message}`);
        await rest(token, `/channels/${message.channel_id}/messages`, {
          content: `Something went wrong: ${e.message}`,
        }).catch(() => {});
      }
    });

    socket.addEventListener("close", () => {
      clearHeartbeat();
      if (stopped || ctx.signal.aborted) return;
      setTimeout(connect, 3000);
    });

    socket.addEventListener("error", () => {
      // "close" follows, which is where reconnection happens.
    });
  };

  connect();

  return {
    async stop() {
      stopped = true;
      clearHeartbeat();
      try {
        socket?.close();
      } catch {
        // already gone
      }
    },

    /**
     * Send without being asked — how a routine reports back. The target is the
     * conversation key handed to ctx.ask, so destinations are picked from
     * conversations that already exist.
     */
    async send(target, text) {
      const channel = String(target).replace(/^channel:/, "");
      for (const chunk of split(text, 1900)) {
        await rest(token, `/channels/${channel}/messages`, { content: chunk }, ctx.signal);
      }
    },
  };
}

/** "<@123> deploy staging" — the mention addresses us, it is not the request. */
const stripMention = (text, selfId) =>
  text.replace(new RegExp(`<@!?${selfId}>`, "g"), " ").replace(/\s+/g, " ");

function split(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [text];
}

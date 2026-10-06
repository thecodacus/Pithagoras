/**
 * Slack, over Socket Mode.
 *
 * Socket Mode exists precisely so an app does not need a public URL: Slack
 * hands out a short-lived WebSocket and pushes events down it. That suits a
 * portal behind Tailscale, and unlike Telegram there is a real socket to use.
 *
 * Two tokens, doing different jobs — the app-level token opens the socket, the
 * bot token posts messages.
 */

export const manifest = {
  id: "slack",
  label: "Slack",
  blurb: "Mention the app in a channel or DM it; replies land in the thread.",
  fields: [
    {
      key: "appToken",
      label: "App token",
      secret: true,
      required: true,
      hint: "Basic Information → App-Level Tokens, with connections:write",
      placeholder: "xapp-…",
    },
    {
      key: "botToken",
      label: "Bot token",
      secret: true,
      required: true,
      hint: "OAuth & Permissions. Needs chat:write, plus app_mentions:read or im:history",
      placeholder: "xoxb-…",
    },
    {
      key: "channelId",
      label: "Channel ID",
      hint: "Restrict to one channel. Empty means anywhere the app is invited.",
      placeholder: "C0123456789",
    },
  ],
};

const SLACK = "https://slack.com/api/";

async function web(token, method, body, signal) {
  const res = await fetch(SLACK + method, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || `${method} failed`);
  return data;
}

export async function start(ctx) {
  const { appToken, botToken, channelId } = ctx.config;

  const auth = await web(botToken, "auth.test", {}, ctx.signal);
  ctx.log(`connected as ${auth.user} in ${auth.team}`);
  const selfId = auth.user_id;

  let socket = null;
  let stopped = false;
  // A mention in a channel the app also reads arrives twice, as `message` and as
  // `app_mention`, and Slack redelivers what it thinks was not acknowledged. The
  // same message is one turn: remembered by where and when it was sent.
  const handled = new Set();

  const connect = async () => {
    if (stopped || ctx.signal.aborted) return;

    let url;
    try {
      ({ url } = await web(appToken, "apps.connections.open", {}, ctx.signal));
    } catch (e) {
      if (stopped || ctx.signal.aborted) return;
      ctx.log(`could not open a socket: ${e.message}`);
      setTimeout(connect, 5000);
      return;
    }

    socket = new WebSocket(url);

    socket.addEventListener("message", async (frame) => {
      let envelope;
      try {
        envelope = JSON.parse(frame.data);
      } catch {
        return;
      }

      // Slack expects an ack within three seconds or it redelivers, so it goes
      // out before the agent is asked — that can take far longer than three
      // seconds.
      if (envelope.envelope_id) {
        socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      }

      if (envelope.type === "disconnect") {
        // Slack rotates sockets deliberately; this is routine, not an error.
        ctx.log(`socket rotating (${envelope.reason})`);
        socket.close();
        return;
      }
      if (envelope.type !== "events_api") return;

      const event = envelope.payload?.event;
      if (!event) return;
      if (event.type !== "message" && event.type !== "app_mention") return;

      // Without this the app answers itself, forever.
      if (event.bot_id || event.subtype === "bot_message" || event.user === selfId) return;
      // Somebody joining, a message edited or deleted: events about the channel,
      // not something said to the agent. A person's own words, even with a file
      // or shared back into the channel from a thread, have no other subtype.
      if (event.subtype && event.subtype !== "thread_broadcast" && event.subtype !== "file_share") return;
      if (channelId && event.channel !== channelId) return;
      if (event.ts) {
        const once = `${event.channel}:${event.ts}`;
        if (handled.has(once)) return;
        handled.add(once);
        if (handled.size > 500) handled.delete(handled.values().next().value);
      }

      const text = stripMention(event.text || "", selfId).trim();
      if (!text) return;

      // Reply in the thread it came from, or start one on the message itself.
      const thread = event.thread_ts || event.ts;
      try {
        // Per channel, not per thread: a thread is a digression inside one
        // conversation, and splitting them would give the agent amnesia
        // halfway through a discussion.
        const say = async (body) => {
          for (const chunk of split(body, 3000)) {
            await web(botToken, "chat.postMessage", {
              channel: event.channel,
              thread_ts: thread,
              text: chunk,
            });
          }
        };
        // Relayed as the agent produces it, so the thread shows progress
        // rather than one wall of text at the end. What comes back is the rest:
        // the whole answer when nothing is relayed, and always the portal's own
        // words ("Stopped.", the refusal a stranger gets).
        const reply = await ctx.ask(text, {
          session: `channel:${event.channel}`,
          title: channelTitle(event),
          channel: event.channel,
          // Slack's user id is stable and theirs; the display name is not.
          from: event.user ? { id: String(event.user), name: String(event.user) } : null,
          thread,
          user: event.user,
          onReply: say,
        });
        if (reply) await say(reply);
      } catch (e) {
        ctx.log(`failed to answer in ${event.channel}: ${e.message}`);
        await web(botToken, "chat.postMessage", {
          channel: event.channel,
          thread_ts: thread,
          text: `Something went wrong: ${e.message}`,
        }).catch(() => {});
      }
    });

    socket.addEventListener("close", () => {
      if (stopped || ctx.signal.aborted) return;
      // Expected on rotation as well as on failure — just get a new one.
      setTimeout(connect, 1000);
    });

    socket.addEventListener("error", () => {
      // "close" always follows, which is where reconnection is handled.
    });
  };

  await connect();

  return {
    async stop() {
      stopped = true;
      try {
        socket?.close();
      } catch {
        // already gone
      }
    },

    /**
     * Send without being asked — how a routine reports back. The target is the
     * conversation key handed to ctx.ask, so destinations are picked from
     * conversations that already exist. Posted to the channel, not a thread:
     * an unprompted message belongs where it can be seen.
     */
    async send(target, text) {
      const channel = String(target).replace(/^channel:/, "");
      for (const chunk of split(text, 3000)) {
        await web(botToken, "chat.postMessage", { channel, text: chunk }, ctx.signal);
      }
    },
  };
}

/** Slack does not put a name on the event, so the id is what there is. */
const channelTitle = (event) =>
  event.channel_type === "im" ? `DM ${event.channel}` : `Slack ${event.channel}`;

/** "<@U123> deploy staging" is addressed to us; the mention is not the ask. */
const stripMention = (text, selfId) =>
  text.replace(new RegExp(`<@${selfId}>`, "g"), " ").replace(/\s+/g, " ");

function split(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [text];
}

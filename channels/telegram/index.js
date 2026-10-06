/**
 * Telegram, over long polling.
 *
 * Polling rather than webhooks on purpose: the portal is meant to run on a box
 * behind Tailscale with no inbound route from the internet, and getUpdates
 * needs only outbound HTTPS.
 */

export const manifest = {
  id: "telegram",
  label: "Telegram",
  blurb: "Message a bot; its replies come back in the same chat.",
  fields: [
    {
      key: "botToken",
      label: "Bot token",
      secret: true,
      required: true,
      hint: "From @BotFather",
      placeholder: "123456:ABC-DEF…",
    },
    {
      key: "allowedChatIds",
      label: "Allowed chat IDs",
      hint: "Comma separated. Leave empty and anyone who finds the bot can drive your agent.",
      placeholder: "12345678, -100987654321",
    },
  ],
};

const API = "https://api.telegram.org/bot";

/** A connection that failed to open is worth another go; a rejected one is not. */
const transient = (e) =>
  e?.name === "TypeError" ||
  /fetch failed|network|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(
    `${e?.message ?? ""} ${e?.cause?.code ?? ""}`
  );

/**
 * Retries the connection, not the request.
 *
 * This box loses its way to api.telegram.org in short bursts, and without this a
 * blip during a button press loses the press: the callback is answered, the
 * work never happens, and nothing says so. An error the API itself returned is
 * deterministic and raised immediately.
 */
async function call(token, method, body, signal, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${API}${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.description || `${method} failed`);
      return data.result;
    } catch (e) {
      if (signal?.aborted || attempt >= attempts || !transient(e)) throw e;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
}

export async function start(ctx) {
  const token = ctx.config.botToken;
  const allowed = String(ctx.config.allowedChatIds || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const me = await call(token, "getMe", {}, ctx.signal);
  ctx.log(`connected as @${me.username}`);
  if (!allowed.length) {
    ctx.log("no chat id restriction — anyone who finds this bot can drive the agent");
  }

  let offset = 0;
  let running = true;
  let offline = false;
  /** Questions waiting on a button press, by the id the portal gave them. */
  const waiting = new Map();

  const loop = (async () => {
    while (running && !ctx.signal.aborted) {
      let updates;
      try {
        // Long poll: the request parks server-side until something arrives.
        updates = await call(
          token,
          "getUpdates",
          { offset, timeout: 50, allowed_updates: ["message", "callback_query"] },
          ctx.signal
        );
      } catch (e) {
        if (ctx.signal.aborted) break;
        // One line for a blip, one line when it comes back — rather than a line
        // every five seconds for as long as the network is away.
        if (!offline) {
          offline = true;
          ctx.log(`lost connection: ${e.message}`);
        }
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      if (offline) {
        offline = false;
        ctx.log("connection back");
      }

      for (const update of updates) {
        offset = update.update_id + 1;

        // A button press on a question we asked. Answered here rather than
        // through the message loop: it is not a message, and the run waiting on
        // it is not waiting for one.
        if (update.callback_query) {
          const q = update.callback_query;
          const data = String(q.data || "");

          // A one-tap reply. Fed back in as if it were typed, so the button and
          // the text it stands for take exactly the same path.
          if (data.startsWith("say:")) {
            const said = data.slice(4);
            await call(token, "answerCallbackQuery", { callback_query_id: q.id }, ctx.signal).catch(
              () => {}
            );
            // The buttons come off only once the tap has been acted on. Taking
            // them away first meant a failure left a question with no way to
            // answer it and no sign anything had gone wrong.
            void handle({ ...q.message, from: q.from }, said, String(q.message.chat.id)).then(
              (ok) =>
                ok &&
                call(
                  token,
                  "editMessageReplyMarkup",
                  { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: {} },
                  ctx.signal
                ).catch(() => {})
            );
            continue;
          }

          const [promptId, index] = data.split(":");
          const pending = waiting.get(promptId);
          // Anybody in a group can press a button: only the person it was asked
          // of, or the primary user, may answer. The question stays open for them.
          if (pending && !pending.canAnswer(String(q.from?.id))) {
            await call(
              token,
              "answerCallbackQuery",
              { callback_query_id: q.id, text: "This question is not for you to answer." },
              ctx.signal
            ).catch(() => {});
            continue;
          }
          await call(token, "answerCallbackQuery", { callback_query_id: q.id }, ctx.signal).catch(
            () => {}
          );
          if (pending) {
            waiting.delete(promptId);
            const chosen = pending.options[Number(index)];
            // Replace the buttons with what was picked, so the chat reads as a
            // record of the decision rather than a question nobody answered.
            await call(
              token,
              "editMessageText",
              {
                chat_id: q.message.chat.id,
                message_id: q.message.message_id,
                text: `${pending.question}\n\n→ ${chosen}`,
              },
              ctx.signal
            ).catch(() => {});
            pending.resolve(pending.confirm ? { value: chosen === "Yes" } : { value: chosen });
          }
          continue;
        }

        const message = update.message;
        const text = message?.text?.trim();
        if (!text) continue;

        const chatId = String(message.chat.id);
        if (allowed.length && !allowed.includes(chatId)) {
          ctx.log(`ignored a message from ${chatId}`);
          continue;
        }

        // Deliberately not awaited. A command that opens a menu blocks until
        // somebody answers it — and the answer is the next message, which this
        // loop has to keep polling to receive. Awaiting here meant the reply
        // could never arrive and the chat hung until the dialog timed out.
        //
        // Ordering is safe: the portal serialises messages per conversation,
        // and an answer to an open question jumps that queue.
        void handle(message, text, chatId);
      }
    }
  })();

  return {
    async stop() {
      running = false;
      await loop.catch(() => {});
    },

    /**
     * Ask with buttons, which is how Telegram asks.
     *
     * Only for questions with a fixed set of answers: free text has no keyboard
     * to draw, so it returns null and the portal asks in words instead.
     */
    async prompt(target, request) {
      const options =
        request.method === "confirm" ? ["Yes", "No"] : (request.options ?? []).slice(0, 20);
      if (!options.length) return null;
      // Telegram caps callback_data at 64 bytes, so the payload is an index.
      const promptId = request.id.slice(-16);
      const chatId = String(target).replace(/^chat:/, "");

      await call(
        token,
        "sendMessage",
        {
          chat_id: chatId,
          text: request.question,
          reply_markup: {
            inline_keyboard: options.map((label, i) => [
              { text: String(label).slice(0, 60), callback_data: `${promptId}:${i}` },
            ]),
          },
        },
        ctx.signal
      );

      return new Promise((resolve) => {
        waiting.set(promptId, {
          options,
          question: request.question,
          confirm: request.method === "confirm",
          canAnswer: request.canAnswer ?? (() => true),
          resolve,
        });
        // The portal gives up on an unanswered dialog too; settling here as well
        // means the map does not grow a stale entry for every ignored question.
        const timer = setTimeout(
          () => {
            if (waiting.delete(promptId)) resolve({ cancelled: true });
          },
          5 * 60_000
        );
        if (typeof timer.unref === "function") timer.unref();
      });
    },

    /**
     * Send without being asked — how a routine reports back.
     *
     * The target is the same conversation key handed to ctx.ask, so a
     * destination is picked from conversations that already exist rather than
     * by finding a chat id somewhere.
     */
    async send(target, text, options) {
      const chatId = String(target).replace(/^chat:/, "");
      const chunks = split(text, 4000);
      for (const [i, chunk] of chunks.entries()) {
        const last = i === chunks.length - 1;
        await call(
          token,
          "sendMessage",
          {
            chat_id: chatId,
            text: chunk,
            // Buttons go on the last chunk, where the question ends.
            ...(last && options?.length
              ? {
                  reply_markup: {
                    inline_keyboard: [
                      options
                        // callback_data is capped at 64 bytes, so anything
                        // longer stays a typed reply rather than silently
                        // becoming a button that fails on tap.
                        .filter((o) => Buffer.byteLength(`say:${o.reply}`) <= 64)
                        .map((o) => ({ text: o.label, callback_data: `say:${o.reply}` })),
                    ],
                  },
                }
              : {}),
          },
          ctx.signal
        );
      }
    },
  };

  async function handle(message, text, chatId) {
    const say = async (body) => {
      // Telegram rejects anything over 4096 characters outright.
      for (const chunk of split(body, 4000)) {
        await call(token, "sendMessage", { chat_id: chatId, text: chunk }, ctx.signal);
      }
    };

    try {
      await call(token, "sendChatAction", { chat_id: chatId, action: "typing" }, ctx.signal);
      // The chat id is the conversation: a DM and a group have different ones,
      // so each gets its own session without any special casing. onReply
      // relays what the agent says between tool calls, and any question an
      // extension asks along the way.
      const reply = await ctx.ask(text, {
        session: `chat:${chatId}`,
        title: chatTitle(message.chat),
        chatId,
        // The conversation is the chat; the sender is the person. In a group
        // those differ every message, and only the id is theirs to prove — a
        // display name is whatever they set it to this morning.
        from: message.from
          ? { id: String(message.from.id), name: personName(message.from) }
          : null,
        onReply: say,
      });
      // Non-empty only when the portal was not relaying as it went.
      if (reply) await say(reply);
      return true;
    } catch (e) {
      ctx.log(`failed to answer ${chatId}: ${e.message}`);
      await say(
        transient(e)
          ? "I lost my connection for a moment and did not get that. Try again."
          : `Something went wrong: ${e.message}`
      ).catch(() => {});
      return false;
    }
  }
}

/** Their name if they have one, their handle if not. */
function personName(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return name || (user.username ? `@${user.username}` : `Telegram ${user.id}`);
}

/** Something recognisable in the session list rather than a bare number. */
function chatTitle(chat) {
  if (chat.title) return chat.title;
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ");
  return name || (chat.username ? `@${chat.username}` : `Chat ${chat.id}`);
}

function split(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [text];
}

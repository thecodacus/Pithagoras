import { test } from "node:test";
import assert from "node:assert/strict";

// The builtin channel packages against a stand-in for their platform, which is
// all they talk to: Telegram over fetch.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/** A Telegram that answers what the package asks, and hands it what the test puts in the inbox. */
function telegram() {
  const calls: { method: string; body: any }[] = [];
  const inbox: any[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    const method = String(url).split("/").pop()!;
    calls.push({ method, body: JSON.parse(init.body) });
    if (method === "getUpdates") {
      while (!inbox.length) {
        if (init.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        await sleep(5);
      }
      return json({ ok: true, result: inbox.splice(0) });
    }
    return json({ ok: true, result: method === "getMe" ? { username: "bot" } : {} });
  }) as any;
  return { calls, inbox, restore: () => (globalThis.fetch = real) };
}

test("a Telegram button is answered only by somebody the portal says may, and stays open for them", async () => {
  const api = telegram();
  const controller = new AbortController();
  const { start } = await import("../channels/telegram/index.js");
  const channel = await start({ config: { botToken: "t" }, log() {}, signal: controller.signal, ask: async () => "" });
  try {
    const answer = channel.prompt("chat:1", {
      id: "abcdefghijklmnopqrstuvwxyz",
      method: "confirm",
      question: "Delete branch release?",
      // As the portal answers it: the person it was put to, or the primary user.
      canAnswer: (senderId: string) => senderId === "111",
    });
    let settled: any;
    void answer.then((value: any) => (settled = value));
    await sleep(20);

    // The button's data is the last sixteen characters of the portal's id, and the index.
    const data = `${"abcdefghijklmnopqrstuvwxyz".slice(-16)}:0`;
    const tap = (from: number) => ({ update_id: Math.floor(Math.random() * 1e9), callback_query: { id: `q${from}`, data, from: { id: from }, message: { chat: { id: 1 }, message_id: 5 } } });

    api.inbox.push(tap(999));
    await sleep(60);
    assert.equal(settled, undefined, "a member of the group who is not that person did not answer it");
    assert.equal(api.calls.some((c) => c.method === "editMessageText"), false, "the buttons are still there");
    const refused = api.calls.find((c) => c.method === "answerCallbackQuery" && c.body.callback_query_id === "q999");
    assert.match(refused!.body.text, /not for you/);

    api.inbox.push(tap(111));
    await sleep(60);
    assert.deepEqual(settled, { value: true });
    assert.ok(api.calls.some((c) => c.method === "editMessageText"), "the question now reads as decided");
  } finally {
    controller.abort();
    await channel.stop();
    api.restore();
  }
});

/** A WebSocket the test drives by hand: what the platform would push, fired at the package. */
class FakeSocket {
  static all: FakeSocket[] = [];
  listeners: Record<string, ((event: any) => unknown)[]> = {};
  sent: string[] = [];
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  addEventListener(type: string, fn: (event: any) => unknown) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  async fire(type: string, event: any) {
    await Promise.all((this.listeners[type] ?? []).map((fn) => fn(event)));
  }
}

/** What a channel package gets from the portal, with `ask` answered by the test. */
function context(config: Record<string, unknown>, ask: (text: string, meta: any) => Promise<string>) {
  const controller = new AbortController();
  const asked: { text: string; meta: any }[] = [];
  return {
    controller,
    asked,
    ctx: { config, log() {}, signal: controller.signal, ask: async (text: string, meta: any) => (asked.push({ text, meta }), ask(text, meta)) },
  };
}

function platform(answer: (url: string, body: any) => unknown) {
  const posts: { url: string; body: any }[] = [];
  const real = { fetch: globalThis.fetch, WebSocket: (globalThis as any).WebSocket };
  FakeSocket.all = [];
  (globalThis as any).WebSocket = FakeSocket;
  globalThis.fetch = (async (url: string, init: any = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    posts.push({ url: String(url), body });
    return json(answer(String(url), body));
  }) as any;
  return { posts, socket: () => FakeSocket.all.at(-1)!, restore: () => Object.assign(globalThis, { fetch: real.fetch, WebSocket: real.WebSocket }) };
}

const slackEvent = (event: Record<string, unknown>) => ({
  data: JSON.stringify({ envelope_id: `e-${Math.random()}`, type: "events_api", payload: { event: { type: "message", channel: "C1", user: "U1", ts: "1.1", text: "hello", ...event } } }),
});

async function slack(ask: (text: string, meta: any) => Promise<string>) {
  const api = platform((url) => (url.endsWith("auth.test") ? { ok: true, user: "bot", team: "T", user_id: "UBOT" } : url.endsWith("apps.connections.open") ? { ok: true, url: "wss://fake" } : { ok: true }));
  const { start } = await import("../channels/slack/index.js");
  const { ctx, controller, asked } = context({ appToken: "a", botToken: "b" }, ask);
  const channel = await start(ctx);
  const posted = () => api.posts.filter((p) => p.url.endsWith("chat.postMessage")).map((p) => p.body.text);
  return { api, asked, posted, socket: api.socket(), done: async () => (controller.abort(), await channel.stop(), api.restore()) };
}

test("what the portal answers on Slack is posted, with Progress off or on: the return value is the rest", async () => {
  const s = await slack(async () => "Stopped.");
  try {
    await s.socket.fire("message", slackEvent({ text: "stop" }));
    assert.deepEqual(s.posted(), ["Stopped."], "the portal's own word is returned, never relayed");
  } finally {
    await s.done();
  }
});

test("a mention Slack delivers twice runs the agent once, and what is not said to it does not run it at all", async () => {
  const s = await slack(async () => "");
  try {
    await s.socket.fire("message", slackEvent({ ts: "5.5", text: "<@UBOT> summarise the incident" }));
    await s.socket.fire("message", slackEvent({ ts: "5.5", type: "app_mention", text: "<@UBOT> summarise the incident" }));
    assert.equal(s.asked.length, 1, "message and app_mention for the same message are one turn");
    assert.equal(s.asked[0].text, "summarise the incident");

    await s.socket.fire("message", slackEvent({ ts: "6.6", subtype: "channel_join", text: "<@U2> has joined the channel" }));
    await s.socket.fire("message", slackEvent({ ts: "7.7", subtype: "message_changed", text: "edited" }));
    assert.equal(s.asked.length, 1, "somebody joining, or a message edited, is not something said to the agent");

    await s.socket.fire("message", slackEvent({ ts: "8.8", subtype: "file_share", text: "here is the log" }));
    await s.socket.fire("message", slackEvent({ ts: "9.9", subtype: "thread_broadcast", text: "also for the channel" }));
    assert.equal(s.asked.length, 3);

    // Another channel's message at the same moment is its own.
    await s.socket.fire("message", slackEvent({ ts: "5.5", channel: "C2", text: "same instant elsewhere" }));
    assert.equal(s.asked.length, 4);
  } finally {
    await s.done();
  }
});

test("what the portal answers on Discord is posted too", async () => {
  const api = platform((url) => (url.endsWith("/users/@me") ? { id: "BOT", username: "bot" } : url.endsWith("/gateway/bot") ? { url: "wss://gw" } : {}));
  const { start } = await import("../channels/discord/index.js");
  const { ctx, controller } = context({ botToken: "t" }, async () => "I only talk to people I have been introduced to.");
  const channel = await start(ctx);
  try {
    const socket = api.socket();
    await socket.fire("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 1e9 } }) });
    await socket.fire("message", { data: JSON.stringify({ op: 0, t: "MESSAGE_CREATE", s: 1, d: { content: "hello", channel_id: "c1", author: { id: "u1", username: "kim" }, mentions: [] } }) });
    const said = api.posts.filter((p) => p.url.endsWith("/channels/c1/messages")).map((p) => p.body.content);
    assert.deepEqual(said, ["I only talk to people I have been introduced to."]);
  } finally {
    controller.abort();
    await channel.stop();
    api.restore();
  }
});

test("stopping the webhook does not wait for the turn of a request that is still open, and tells it", async () => {
  const { createServer } = await import("node:net");
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as any;
      probe.close(() => resolve(port));
    });
  });
  const { start } = await import("../channels/webhook/index.js");
  // An agent turn that takes as long as it likes.
  const { ctx, controller, asked } = context({ secret: "s3cret", port }, () => new Promise(() => {}));
  const channel = await start(ctx);
  const request = fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "x-portal-secret": "s3cret" }, body: JSON.stringify({ message: "run the report", from: { id: "ci" } }) });
  while (!asked.length) await sleep(5);

  controller.abort();
  const stopped = await Promise.race([channel.stop().then(() => "stopped"), sleep(3000).then(() => "still waiting")]);
  assert.equal(stopped, "stopped", "the channel stops without waiting for the agent");
  const answer = await request;
  assert.equal(answer.status, 503, "the caller is told the channel is stopping");
  assert.match((await answer.json()).error, /stopping/);
});

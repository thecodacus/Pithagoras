import test, { after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

// The model Understory thinks with, against a home of its own and an upstream
// of the test's own: one that answers only when it is told to, in whole — not
// in a stream, as Node's fetch gives up on after five quiet minutes.
inProcessHome("pithagoras-memory-llm-");
// The wait the proxy keeps, set short: long enough for what answers quickly,
// and short of the five minutes that killed a local model mid-answer in the field.
process.env.UNDERSTORY_LLM_HEADERS_TIMEOUT_MS = "500";
process.env.UNDERSTORY_LLM_BODY_TIMEOUT_MS = "500";

const requests = [];
let delay = 0;
const upstream = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    if (req.method !== "POST" || req.url !== "/chat/completions") return res.writeHead(500).end("not the model");
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    // A whole answer at once, as a non-streaming one comes: no byte until it is done.
    setTimeout(() => res.end(JSON.stringify({
      id: "c", object: "chat.completion", model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "the answer" }, finish_reason: "stop" }],
    })), delay);
  });
});
await once(upstream.listen(0, "127.0.0.1"), "listening");

// The one above reads it when the catalogue is built; no /v1 in its address —
// the proxy itself adds /chat/completions.
writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({
  providers: {
    fake: {
      baseUrl: `http://127.0.0.1:${upstream.address().port}`, api: "openai-completions", apiKey: "none",
      models: [{ id: "m", name: "M", reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 100 }],
    },
  },
}));

const express = (await import("express")).default;
const { memoryLlmRouter, noteToolCall, forgetAsking } = await import("../dist/memory-llm.js");
const { putSetting } = await import("../dist/db.js");
after(() => { upstream.close(); http.close(); forgetAsking(); });

putSetting("understory_llm_token", "test-key");
// A chat asking: the request goes to its model, which the test names.
noteToolCall("asking-chat", "call-1", "understory_remember", "start");

const app = express();
app.use(memoryLlmRouter(async () => ({ provider: "fake", id: "m" })));
const http = app.listen(0, "127.0.0.1");
await once(http, "listening");
const base = `http://127.0.0.1:${http.address().port}`;

const ask = (auth) => fetch(`${base}/understory-llm/v1/chat/completions`, {
  method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
});

test("the asking chat's model is asked, and its whole answer passes through", async () => {
  delay = 30;
  const r = await ask("test-key");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).choices[0].message.content, "the answer");
  // To the model it was given, under its own name, and signed for.
  assert.equal(requests.at(-1).body.model, "m");
  assert.equal(requests.at(-1).headers.authorization, "Bearer none");
});

test("when the wait comes round, the answer is a timeout that says so — not 'fetch failed' as a 502", async () => {
  delay = 1500; // longer than the 500ms of above; where Node's own five minutes would cut it
  const r = await ask("test-key");
  assert.equal(r.status, 504);
  const said = (await r.json()).error.message;
  assert.match(said, /within \d+ seconds/);
  assert.doesNotMatch(said, /fetch failed/);
});

test("a stranger does not reach the model", async () => {
  delay = 30;
  const before = requests.length;
  const r = await ask("not-the-key");
  assert.equal(r.status, 401);
  assert.equal(requests.length, before);
});

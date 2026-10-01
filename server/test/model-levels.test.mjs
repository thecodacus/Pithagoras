import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// pi's catalogue, against an agent directory of its own, with an installed
// extension that takes its time loading — as a package can after an install.
const dir = mkdtempSync(path.join(tmpdir(), "pi-agent-levels-"));
process.env.PI_CODING_AGENT_DIR = dir;
const map = (on) => Object.fromEntries(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((l) => [l, on.includes(l) ? l : null]));
writeFileSync(path.join(dir, "models.json"), JSON.stringify({
  providers: {
    "test-server": {
      baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "none",
      models: [{ id: "switch", name: "Switch", reasoning: true, thinkingLevelMap: map(["off", "medium"]), input: ["text"], contextWindow: 1000, maxTokens: 100 }],
    },
  },
}));
mkdirSync(path.join(dir, "ext"), { recursive: true });
// Far slower than the answer may take, so waiting for it cannot pass for a slow
// machine: pi's own loading, before the race starts, took 1.5s on CI.
writeFileSync(path.join(dir, "ext", "slow.js"), `await new Promise((r) => setTimeout(r, 5000));
export default function () {}`);
writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ extensions: [path.join(dir, "ext", "slow.js")] }));

const { modelLevels } = await import("../dist/api/providers.js");
const home = mkdtempSync(path.join(tmpdir(), "agent-home-"));
process.env.AGENT_HOME = home;

test("a chat's levels do not wait for pi's catalogue to be built", async () => {
  // Opening an idle chat asks for them. Waiting for the build — every
  // extension's code, loaded — held the answer up to 1.5s after each start
  // or install, where the page has what it last saw to draw meanwhile.
  const started = Date.now();
  assert.deepEqual(await modelLevels("test-server", "switch"), []);
  assert.ok(Date.now() - started < 3000, `answered after ${Date.now() - started}ms`);

  // The build was started, and the next chat opened has them.
  let levels = [];
  for (let i = 0; i < 120 && !levels.length; i++) {
    await new Promise((r) => setTimeout(r, 100));
    levels = await modelLevels("test-server", "switch");
  }
  assert.deepEqual(levels, ["off", "medium"]);
});

test("after a failed build, one made since is used at once", async () => {
  const pi = await import("@earendil-works/pi-coding-agent");
  const { modelRuntime } = await import("../dist/api/providers.js");
  const create = pi.ModelRuntime.create;
  // Something else installed, so the catalogue is made anew — and that fails.
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ extensions: [] }));
  pi.ModelRuntime.create = async () => { throw new Error("catalogue broke"); };
  try {
    assert.deepEqual(await modelLevels("test-server", "switch"), []);
    await modelRuntime().catch(() => {});
  } finally {
    pi.ModelRuntime.create = create;
  }
  // Settings, opened, builds it again, and that works. The chats opened in the
  // rest of the minute had no levels all the same: the wait after a failure
  // was looked at before whether there was a catalogue.
  await modelRuntime();
  assert.deepEqual(await modelLevels("test-server", "switch"), ["off", "medium"]);
});

test("a failed read of pi's files keeps the catalogue built", async () => {
  const { modelRuntime } = await import("../dist/api/providers.js");
  const rt = await modelRuntime();
  assert.deepEqual(await modelLevels("test-server", "switch"), ["off", "medium"]);
  // A file caught half written, say: the next read of them fails once.
  const refresh = rt.refresh.bind(rt);
  rt.refresh = async () => { rt.refresh = refresh; throw new Error("half written"); };
  writeFileSync(path.join(dir, "auth.json"), JSON.stringify({}));
  // Before, the catalogue was thrown away with it, and for a minute no chat
  // had levels — then every extension ran again to build another.
  assert.deepEqual(await modelLevels("test-server", "switch", 2000), ["off", "medium"]);
  assert.equal(await modelRuntime(), rt);
});

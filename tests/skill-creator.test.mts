import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { scratch } from "./helpers.mts";

// The built-in skill-creator tells the agent where to write a skill. pi loads skills from `PI_CODING_AGENT_DIR` when
// that is set, so a path of `$HOME/.pi/agent` writes a skill that never loads.
const dir = path.join(import.meta.dirname, "..", "skills", "skill-creator");
const files = ["SKILL.md", "reference/frontmatter.md"].map((file) => readFileSync(path.join(dir, file), "utf8"));
const WHERE = "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/skills";

test("every place the skill names is the one pi loads skills from, whichever way it is set", () => {
  for (const text of files) {
    // The agent's home is only ever named as the fallback of that expression.
    assert.equal(text.match(/\.pi\/agent/g)?.length ?? 0, text.split(WHERE).length - 1);
  }
  assert.ok(files.join("\n").includes(`mkdir -p "${WHERE}/<skill-name>"`));
});

test("the commands it gives write into the agent's folder when one is set, and into the home folder when not", () => {
  const commands = files.join("\n").match(/^(?:mkdir -p|cat|head -5) "\$\{PI_CODING_AGENT_DIR[^\n]*$/gm) ?? [];
  assert.equal(commands.length, 3);
  const home = scratch("skill-creator-");
  try {
    const mkdir = commands.find((c) => c.startsWith("mkdir"))!.replace("<skill-name>", "a-skill");
    const run = (env: Record<string, string>) => execFileSync("bash", ["-c", mkdir], { env: { PATH: process.env.PATH!, ...env } });
    run({ HOME: home, PI_CODING_AGENT_DIR: path.join(home, "data", "agent") });
    assert.ok(existsSync(path.join(home, "data", "agent", "skills", "a-skill")));
    assert.equal(existsSync(path.join(home, ".pi")), false, "not under the home folder");
    run({ HOME: home });
    assert.ok(existsSync(path.join(home, ".pi", "agent", "skills", "a-skill")));
  } finally {
  }
});

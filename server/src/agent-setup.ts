import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { agentHome } from "./agent.js";
import { understoryOn } from "./features.js";

/**
 * The agent's home directory.
 *
 * These three are handed to pi as context files when a session starts, through
 * the resource loader's agentsFilesOverride. Nothing is generated from them:
 * an earlier version composed an AGENTS.md because pi only discovers one
 * context file per directory, but the SDK takes an explicit list, which leaves
 * no second copy to drift and puts MEMORY.md genuinely in context rather than
 * relying on the agent to go and read it.
 */

export const AGENT_FILES = ["SOUL.md", "PrimaryUser.md", "MEMORY.md"] as const;
export type AgentFile = (typeof AGENT_FILES)[number];

/** A file of an agent's: the first agent's, unless another's home is given. */
const filePath = (name: string, home = agentHome()) => path.join(home, name);

export const isInitialised = (home = agentHome()): boolean => AGENT_FILES.every((f) => existsSync(filePath(f, home)));

export function readAgentFile(name: string, home = agentHome()): string {
  try {
    return readFileSync(filePath(name, home), "utf8");
  } catch {
    return "";
  }
}

export function agentFileStatus(home = agentHome()) {
  return {
    home,
    initialised: isInitialised(home),
    // Where the agent's memory is kept: while Understory holds it, MEMORY.md is not read.
    memory: understoryOn() ? ("understory" as const) : ("file" as const),
    files: AGENT_FILES.map((name) => ({
      name,
      exists: existsSync(filePath(name, home)),
      content: readAgentFile(name, home),
    })),
  };
}

export function writeAgentFile(name: string, content: string, home = agentHome()): void {
  if (!(AGENT_FILES as readonly string[]).includes(name)) {
    throw new Error(`"${name}" is not one of the agent's files`);
  }
  writeFileSync(filePath(name, home), content.endsWith("\n") ? content : `${content}\n`, "utf8");
}

export interface WizardInput {
  agentName: string;
  vibe?: string;
  principles?: string;
  userName: string;
  userAbout?: string;
  userPrefers?: string;
}

/**
 * Write the three files from the wizard's answers.
 *
 * The templates are opinionated on purpose: an empty SOUL.md produces a
 * characterless agent, and someone setting this up for the first time has no
 * reason to know what belongs in one.
 */
export function runWizard(input: WizardInput, home = agentHome()): void {
  const name = input.agentName.trim() || "the agent";
  const vibe = input.vibe?.trim();
  const principles = input.principles?.trim();
  const userName = input.userName.trim() || "the primary user";

  // Every file opens by saying what it is and what to do with it. Content on
  // its own is ambiguous — handed the same words with no instruction, the model
  // read SOUL.md as notes about a third party and answered as itself.
  const soul = `# SOUL.md — who you are

**This file is your identity.** It is not notes about someone else. The name,
character and working style below are yours: answer as this, in every
conversation, on every channel. If it conflicts with a habit of yours, this
wins.

To change how you behave, edit this file.

---

# ${name}

${vibe || `You are ${name}. You work for one person and you know them well.`}

## How you work

${
  principles ||
  [
    "- Answer the question. No preamble, no restating what was asked.",
    "- Have a view. If something is a bad idea, say so and say why.",
    "- Be brief. A sentence that does the job beats a paragraph that also does the job.",
    "- Say when you are unsure, and say what would settle it.",
    "- You are often reached from a phone. Long replies are hard to read there.",
  ].join("\n")
}

## What you do not do

- Guess at facts you could check.
- Claim something is done when it is not.
- Pad an answer to look thorough.
`;

  const user = `# PrimaryUser.md — who you work for

**This file describes the person you are talking to.** Assume what it says
rather than asking them to repeat it, and answer the way it describes. If you
learn something lasting about them, it belongs in MEMORY.md, not here — this
file is theirs to write.

---

# ${userName}

${input.userAbout?.trim() || "_What they work on, what they care about, what you should assume._"}

## Working with them

${input.userPrefers?.trim() || "_How they like to be answered — length, tone, how much detail, what to skip._"}
`;

  const memory = `# MEMORY.md — what you have learned

**This file is your long-term memory and you maintain it.** You are given it at
the start of every conversation, so anything written here you simply know.

Append to it when you learn something worth having next week: a decision and
the reason behind it, a preference you were corrected on, how something is set
up. Write what would not be obvious from the conversation you are in. Do not
record what you could look up, and do not restate what is already here.

Keep it in the sections below. Newest last.

---

## Decisions

_Choices that were made and why, so they are not argued twice._

## Preferences

_How things should be done, learned from being corrected._

## Context

_Names, systems, how things are set up. True and not obvious._
`;

  writeFileSync(filePath("SOUL.md", home), soul, "utf8");
  writeFileSync(filePath("PrimaryUser.md", home), user, "utf8");
  // Never clobber a memory that already exists — it is the one file here that
  // cannot be reconstructed.
  if (!existsSync(filePath("MEMORY.md", home))) {
    writeFileSync(filePath("MEMORY.md", home), memory, "utf8");
  }
}

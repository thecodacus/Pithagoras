import { execFileSync } from "node:child_process";
import path from "node:path";
import { getSetting, putSetting } from "../db.js";
import type { Agent } from "../agents.js";
import { SANDBOX_HOME, idOf, type SandboxSupport } from "./policy.js";

/**
 * Who an agent is in the sandbox: a user of its own, `pi-agent-<id>`, with a
 * group of its own that owns its home. One agent cannot read another's home,
 * nor reach it through the other's processes (/proc/<pid>/cwd is only open to
 * the same user) or its temporary files, since each has its own HOME and TMPDIR.
 * All are in the sandbox group, which owns what they share: the projects.
 *
 * The ids are kept in the portal's settings and the users made from them when
 * needed, as a container rebuilt from its image has none of them, while what
 * they own on the data volume keeps its ids.
 */

export interface Identity {
  user: string;
  uid: number;
  gid: number;
  /** The sandbox group, for what the agents share. */
  shared: number;
  /** Its HOME in the sandbox: caches, tools it installs, its own TMPDIR. */
  home: string;
  tmp: string;
}

const FIRST_ID = 10100;
const IDS_SETTING = "sandbox_agent_ids";

/** A user name for an agent: valid for useradd, at most 32 characters. */
export const userFor = (agentId: string) => `pi-agent-${agentId.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`.slice(0, 32);

function ids(): Record<string, number> {
  try {
    return JSON.parse(getSetting(IDS_SETTING) ?? "{}");
  } catch {
    return {};
  }
}

/** The agent's id, given it the first time it is asked for: the next one free. */
function idFor(agentId: string): number {
  const all = ids();
  if (all[agentId]) return all[agentId];
  const used = new Set(Object.values(all));
  let next = FIRST_ID;
  // Not one the system already uses for someone else: getent takes a number as well as a name.
  while (used.has(next) || idOf("user", String(next)) !== null || idOf("group", String(next)) !== null) next++;
  putSetting(IDS_SETTING, JSON.stringify({ ...all, [agentId]: next }));
  return next;
}

/** The user and its group as the system has them, made where they are missing. */
function ensureUser(user: string, id: number, shared: number, home: string) {
  if (idOf("group", user) === null) execFileSync("groupadd", ["--gid", String(id), user]);
  if (idOf("user", user) === null) {
    execFileSync("useradd", ["--uid", String(id), "--gid", String(id), "--groups", String(shared), "--no-create-home", "--home-dir", home, "--shell", "/bin/bash", user]);
  }
}

/** The agent's identity in the sandbox, its user made if it is not there yet. */
export function identityOf(agent: Pick<Agent, "id">, support: SandboxSupport): Identity {
  if (!support.ids) throw new Error("The sandbox is not available here");
  const user = userFor(agent.id);
  const id = idFor(agent.id);
  const home = path.join(SANDBOX_HOME, agent.id);
  ensureUser(user, id, support.ids.group, home);
  return { user, uid: id, gid: id, shared: support.ids.group, home, tmp: path.join(home, "tmp") };
}

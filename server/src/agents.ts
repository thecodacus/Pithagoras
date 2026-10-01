import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { getDb } from "./db.js";
import { agentHomePath } from "./agent-home.js";
import { isWithinText } from "./within.js";
import { normalizeOrb, type OrbStyle } from "./orb-style.js";

/**
 * The agents, each a home folder of its own with its own SOUL.md,
 * PrimaryUser.md and MEMORY.md: its own personality and memory.
 *
 * A chat is an agent's because it works in that agent's home; nothing else
 * records it. The first agent is the Home there always was (`home`), kept
 * where it was, and the one a chat, a channel or a routine goes to when none is
 * named. It can be renamed, not deleted.
 */

export interface Agent {
  id: string;
  name: string;
  home: string;
  /** Its avatar as stored: see orbOf. */
  orb: string | null;
  created_at: string;
}

export const DEFAULT_AGENT = "home";

/** Where agents other than the first are made: beside the first one's home, in `agents/`. */
export const agentsRoot = () => path.join(path.dirname(agentHomePath()), "agents");

/** The first agent's home is wherever AGENT_HOME says now, not where it was when its row was made. */
const placed = (a: Agent): Agent => (a.id === DEFAULT_AGENT ? { ...a, home: agentHomePath() } : a);

export function listAgents(): Agent[] {
  return (getDb().prepare("SELECT * FROM agents ORDER BY id = 'home' DESC, created_at ASC, name ASC").all() as Agent[]).map(placed);
}

export function getAgent(id: string): Agent | undefined {
  const row = getDb().prepare("SELECT * FROM agents WHERE id = ?").get(id) as Agent | undefined;
  return row && placed(row);
}

/** The first agent: the one a chat, channel or routine goes to when none is named. */
export function defaultAgent(): Agent {
  return getAgent(DEFAULT_AGENT) ?? listAgents()[0];
}

/** The agent whose home this is, if any. */
export function agentAt(home: string): Agent | undefined {
  const at = path.resolve(home);
  return listAgents().find((a) => a.home === at);
}

/** The agent a chat working here belongs to: its home, or inside it. */
export function agentOf(workspace: string | null | undefined): Agent | undefined {
  if (!workspace) return undefined;
  return listAgents().find((a) => isWithinText(a.home, path.resolve(workspace)));
}

/** A folder name from a name: lower case, letters and digits joined by dashes. */
export function slugOf(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";
}

const checkName = (name: unknown): string => {
  if (typeof name !== "string" || !name.trim()) throw new AgentError("An agent needs a name", 400);
  if (name.trim().length > 60) throw new AgentError("An agent's name is at most 60 characters", 400);
  return name.trim();
};

export class AgentError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * A new agent, with a home of its own under agentsRoot(). Named like one that
 * was deleted with its folder kept, it takes that folder up again, with its
 * files and memory: that is how a deleted agent comes back.
 */
export function createAgent(input: { name: unknown }): Agent {
  const name = checkName(input.name);
  const taken = new Set(listAgents().map((a) => a.id));
  const base = slugOf(name);
  let id = base;
  for (let n = 2; taken.has(id) || id === DEFAULT_AGENT; n++) id = `${base}-${n}`;
  const home = path.join(agentsRoot(), id);
  mkdirSync(home, { recursive: true });
  getDb().prepare("INSERT INTO agents (id, name, home) VALUES (?, ?, ?)").run(id, name, home);
  return getAgent(id)!;
}

export function renameAgent(id: string, name: unknown): Agent {
  const agent = getAgent(id);
  if (!agent) throw new AgentError("No such agent", 404);
  getDb().prepare("UPDATE agents SET name = ? WHERE id = ?").run(checkName(name), id);
  return getAgent(id)!;
}

/** An agent's avatar: the default orb where it has none, or one that no longer parses. */
export function orbOf(agent: Agent): OrbStyle {
  let stored: unknown;
  try {
    stored = agent.orb ? JSON.parse(agent.orb) : undefined;
  } catch {
    // The default orb, not a broken page.
  }
  return normalizeOrb(stored);
}

export function setOrb(id: string, style: unknown): OrbStyle {
  if (!getAgent(id)) throw new AgentError("No such agent", 404);
  if (!style || typeof style !== "object" || Array.isArray(style)) throw new AgentError("An orb style is required", 400);
  const orb = normalizeOrb(style);
  getDb().prepare("UPDATE agents SET orb = ? WHERE id = ?").run(JSON.stringify(orb), id);
  return orb;
}

/** The channels that talk as this agent: an agent with any cannot be deleted until they are moved. */
export function channelsOf(id: string): { slug: string; name: string }[] {
  return getDb()
    .prepare("SELECT slug, name FROM channels WHERE agent_id = ? OR (agent_id = '' AND ? = 'home')")
    .all(id, id) as { slug: string; name: string }[];
}

/** The agent, if it may be deleted: not the first one, and not one a channel talks as. Throws otherwise. */
export function deletable(id: string): Agent {
  const agent = getAgent(id);
  if (!agent) throw new AgentError("No such agent", 404);
  if (id === DEFAULT_AGENT) throw new AgentError("The first agent cannot be deleted. It can be renamed.", 409);
  const channels = channelsOf(id);
  if (channels.length) {
    throw new AgentError(`${channels.map((c) => c.name).join(", ")} ${channels.length === 1 ? "talks" : "talk"} as this agent. Give ${channels.length === 1 ? "it" : "them"} another agent first.`, 409);
  }
  return agent;
}

/**
 * Takes the agent out of the portal. Its folder stays unless `deleteFolder`
 * says otherwise. Its chats are removed by the caller, which knows whether any
 * is running; this refuses the first agent, and one a channel talks as.
 */
export function deleteAgent(id: string, { deleteFolder }: { deleteFolder: boolean }): Agent {
  const agent = deletable(id);
  getDb().prepare("DELETE FROM agents WHERE id = ?").run(id);
  // Only a folder this module made, under agentsRoot(): nothing else is ever removed.
  if (deleteFolder && isWithinText(agentsRoot(), agent.home) && agent.home !== agentsRoot() && existsSync(agent.home)) {
    rmSync(agent.home, { recursive: true, force: true });
  }
  return agent;
}

/** The home of the agent a channel talks as: its own, or the first agent's. */
export function channelAgentHome(agentId: string | null | undefined): string {
  return (agentId ? getAgent(agentId) : undefined)?.home ?? defaultAgent().home;
}

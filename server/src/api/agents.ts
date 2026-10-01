import express, { type Router } from "express";
import { AgentError, DEFAULT_AGENT, agentOf, channelsOf, createAgent, getAgent, listAgents, orbOf, renameAgent, setOrb, setVoice, type Agent } from "../agents.js";
import { agentFileStatus, isInitialised, runWizard, writeAgentFile, type WizardInput } from "../agent-setup.js";
import { listAgentSessions, listSessions } from "../db.js";
import { deleteNote, listNotes, markNotesRead, unreadNotes } from "../activity.js";
import { heartbeat, setHeartbeat, watchList } from "../heartbeat.js";
import { EXECUTOR_KIND } from "../session-manager.js";

/**
 * The agents: listing them, making one, naming it, and its own files and setup.
 * Deleting one is in server.ts, beside deleting a project: both have to stop
 * the chats working there first.
 */

const failed = (res: express.Response, e: unknown) =>
  res.status(e instanceof AgentError ? e.status : 400).json({ error: (e as Error).message });

/** An agent as the page sees it: what it is, whether it is set up, and what uses it. */
export function agentToApi(a: Agent, chats = 0) {
  return {
    id: a.id,
    name: a.name,
    home: a.home,
    first: a.id === DEFAULT_AGENT,
    initialised: isInitialised(a.home),
    chats,
    channels: channelsOf(a.id),
    orb: orbOf(a),
    voice: a.voice ?? "",
    heartbeat: {
      minutes: a.heartbeat_minutes ?? 0,
      quietStart: a.quiet_start ?? "",
      quietEnd: a.quiet_end ?? "",
      last: a.last_heartbeat,
      status: a.heartbeat_status,
      running: heartbeat.isRunning(a.id),
      // Whether there is anything to look at, and whether looks can happen here at all.
      watching: Boolean(watchList(a)),
      available: EXECUTOR_KIND === "host",
    },
    unread: unreadNotes(a.id),
  };
}

export function agentsRouter(): Router {
  const router = express.Router();

  router.get("/agents", (_req, res) => {
    // Read once, then counted per agent: every chat is read either way.
    const counts = new Map<string, number>();
    for (const s of [...listSessions(), ...listAgentSessions()]) {
      const a = agentOf(s.workspace);
      if (a) counts.set(a.id, (counts.get(a.id) ?? 0) + 1);
    }
    res.json({ agents: listAgents().map((a) => agentToApi(a, counts.get(a.id) ?? 0)) });
  });

  /** A new agent, with its home. Given the wizard's answers, it is set up as well. */
  router.post("/agents", (req, res) => {
    try {
      const agent = createAgent({ name: req.body?.name });
      const wizard = req.body?.setup as WizardInput | undefined;
      if (wizard && typeof wizard === "object") runWizard({ ...wizard, agentName: wizard.agentName || agent.name }, agent.home);
      res.json(agentToApi(agent));
    } catch (e) {
      failed(res, e);
    }
  });

  router.patch("/agents/:id", (req, res) => {
    try {
      res.json(agentToApi(renameAgent(req.params.id, req.body?.name)));
    } catch (e) {
      failed(res, e);
    }
  });

  const agentOr404 = (id: string, res: express.Response) => {
    const agent = getAgent(id);
    if (!agent) res.status(404).json({ error: "No such agent" });
    return agent;
  };

  /** Its avatar: the voice-mode orb's look and personality, the same on every device. */
  router.put("/agents/:id/orb", (req, res) => {
    try {
      res.json(setOrb(req.params.id, req.body));
    } catch (e) {
      failed(res, e);
    }
  });

  /** `{ voice }`: "design", a voice library id, or "" for the one in the voice settings. */
  router.put("/agents/:id/voice", (req, res) => {
    try {
      res.json(agentToApi(setVoice(req.params.id, req.body?.voice)));
    } catch (e) {
      failed(res, e);
    }
  });

  /** `{ minutes, quietStart, quietEnd }`: how often it looks around on its own; 0 never. */
  router.put("/agents/:id/heartbeat", (req, res) => {
    try {
      res.json(agentToApi(setHeartbeat(req.params.id, req.body ?? {})));
    } catch (e) {
      failed(res, e);
    }
  });

  /** A look now, whatever the interval says. Answers at once; the page follows the status. */
  router.post("/agents/:id/heartbeat/run", (req, res) => {
    const agent = agentOr404(req.params.id, res);
    if (!agent) return;
    if (heartbeat.isRunning(agent.id)) return res.status(409).json({ error: `${agent.name} is already looking` });
    void heartbeat.run(agent, "manual").catch(() => {});
    res.json(agentToApi(getAgent(agent.id)!));
  });

  router.get("/agents/:id/activity", (req, res) => {
    const agent = agentOr404(req.params.id, res);
    if (agent) res.json({ notes: listNotes(agent.id), unread: unreadNotes(agent.id) });
  });

  router.post("/agents/:id/activity/read", (req, res) => {
    const agent = agentOr404(req.params.id, res);
    if (!agent) return;
    markNotesRead(agent.id);
    res.json({ unread: 0 });
  });

  router.delete("/agents/:id/activity/:note", (req, res) => {
    const agent = agentOr404(req.params.id, res);
    if (!agent) return;
    if (!deleteNote(agent.id, req.params.note)) return res.status(404).json({ error: "No such note" });
    res.json({ ok: true });
  });

  router.get("/agents/:id/setup", (req, res) => {
    const agent = agentOr404(req.params.id, res);
    if (agent) res.json(agentFileStatus(agent.home));
  });

  /** The setup wizard, for this agent's home. Refuses to overwrite an existing MEMORY.md. */
  router.post("/agents/:id/setup", (req, res) => {
    const agent = agentOr404(req.params.id, res);
    if (!agent) return;
    const body = (req.body ?? {}) as WizardInput;
    if (typeof body.agentName !== "string" || !body.agentName.trim()) return res.status(400).json({ error: "The agent needs a name" });
    if (typeof body.userName !== "string" || !body.userName.trim()) return res.status(400).json({ error: "Who is it working for?" });
    try {
      runWizard(body, agent.home);
      res.json(agentFileStatus(agent.home));
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.put("/agents/:id/files/:name", (req, res) => {
    const agent = agentOr404(req.params.id, res);
    if (!agent) return;
    const content = req.body?.content;
    if (typeof content !== "string") return res.status(400).json({ error: "content required" });
    try {
      writeAgentFile(req.params.name, content, agent.home);
      res.json(agentFileStatus(agent.home));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  return router;
}

import express, { type Router } from "express";
import {
  browserAllowed,
  browserAllowlist,
  browserByDefault,
  browserExceptions,
  getDb,
  setBrowserAllowlist,
  type SessionRow,
} from "../db.js";
import { BROWSER_MCP } from "../tool-policy.js";
import { BROWSER_CDP, browserServers, findConnection, readMcpFile, writeMcpFile } from "./mcp.js";
import * as service from "../extensions/browser-service.js";

/**
 * The agent's browser: whether it is up, who may drive it, and where to.
 *
 * The browser itself runs in its own container with its own profile — a human
 * logs into it once and every later run finds itself already signed in. The
 * portal owns none of that; it owns the question of which sessions may reach it.
 */

const CDP = BROWSER_CDP;

/**
 * How the agent reaches the browser: an MCP server attached over the debugging
 * protocol. `--cdp-endpoint` is the whole point — without it the Playwright
 * server launches its own throwaway Chromium, signed into nothing.
 */
const MCP_NAME = BROWSER_MCP;

/**
 * Pointer tools by screen position, which `--caps vision` adds.
 *
 * A screenshot costs a local model far less to read than the page's text, and
 * it carries no element references. These let the agent act on what it sees
 * there when a search turns up no reference for it.
 */
const VISION_TOOLS = [
  "browser_mouse_click_xy",
  "browser_mouse_move_xy",
  "browser_mouse_drag_xy",
  "browser_mouse_wheel",
];

/**
 * The tools worth putting in the prompt, and the one worth hiding.
 *
 * Behind the adapter's proxy a tool's schema is not in context, so the agent
 * has to guess its arguments — it called navigate twice with no url before
 * working out that it needed one. These carry their signatures instead, at
 * roughly 200 tokens each; the remaining dozen stay behind the proxy, where
 * they are discoverable but cost nothing until asked for.
 */
const DIRECT_TOOLS = [
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_find",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_press_key",
  "browser_wait_for",
  "browser_take_screenshot",
  ...VISION_TOOLS,
];

/**
 * Arbitrary JavaScript in a browser signed into the agent's accounts is a
 * different thing from arbitrary JavaScript in a blank one. Hidden rather than
 * merely unregistered, so the proxy cannot reach it either.
 */
const EXCLUDE_TOOLS = ["browser_run_code_unsafe"];

/**
 * Pinned, not `@latest`.
 *
 * The tool signatures changed underneath a working setup: click and type took
 * `{element, ref}` and now take `{target}`. The agent went on calling the old
 * shape, every interaction failed, and nothing here had changed. A browser the
 * agent depends on is not the place for a silent upgrade.
 */
const MCP_VERSION = "0.0.79";

const mcpEntry = () => ({
  command: "npx",
  args: ["-y", `@playwright/mcp@${MCP_VERSION}`, "--cdp-endpoint", CDP, "--snapshot-mode", "none", "--caps", "vision"],
  lifecycle: "lazy",
  directTools: DIRECT_TOOLS,
  excludeTools: EXCLUDE_TOOLS,
});

/**
 * Pin existing connections, enable on-demand snapshots and add vision.
 *
 * The pin only reaches a config the portal writes, and nobody rewrites theirs
 * — an install from before this would go on tracking whatever npm publishes
 * next. Migrate only our package and debugging endpoint. Suppressing automatic
 * snapshots avoids repeating a whole page after every click or keystroke;
 * explicit snapshot and find calls still return their requested content.
 * Vision gives a connection made before it the pointer tools the reading rule
 * falls back to.
 */
export function pinConnection(): void {
  const { config, error } = readMcpFile();
  if (error) return;
  let changed = false;
  for (const entry of Object.values(config.mcpServers)) {
    const args = (entry as { args?: unknown }).args;
    if (!Array.isArray(args) || !args.includes("--cdp-endpoint") || !args.includes(CDP)) continue;
    const at = args.findIndex((a) => typeof a === "string" && a.startsWith("@playwright/mcp@"));
    if (at === -1) continue;
    if (args[at] !== `@playwright/mcp@${MCP_VERSION}`) {
      args[at] = `@playwright/mcp@${MCP_VERSION}`;
      changed = true;
    }
    const mode = args.indexOf("--snapshot-mode");
    if (mode === -1) {
      args.push("--snapshot-mode", "none");
      changed = true;
    } else if (args[mode + 1] !== "none") {
      args[mode + 1] = "none";
      changed = true;
    }
    // Vision joins whatever capabilities the entry already asks for, and its
    // pointer tools join the prompt-listed ones where the portal wrote that list.
    const caps = args.indexOf("--caps");
    const had = caps === -1 ? [] : String(args[caps + 1] ?? "").split(",").filter(Boolean);
    if (!had.includes("vision")) {
      if (caps === -1) args.push("--caps", "vision");
      else args[caps + 1] = [...had, "vision"].join(",");
      const direct = (entry as { directTools?: unknown }).directTools;
      if (Array.isArray(direct)) direct.push(...VISION_TOOLS.filter((t) => !direct.includes(t)));
      changed = true;
    }
  }
  if (changed) {
    writeMcpFile(config);
    console.log(`[portal] configured browser MCP @playwright/mcp@${MCP_VERSION} with on-demand snapshots and vision`);
  }
}

/**
 * The HTTPS port, not the HTTP one.
 *
 * KasmVNC refuses to run outside a secure context — it needs clipboard and
 * pointer-lock, which browsers only expose over HTTPS or on localhost. Over
 * plain HTTP from a LAN address it renders one error and nothing else.
 */
const uiPort = () => service.config().httpsPort;

export function browserRouter(): Router {
  const router = express.Router();

  router.get("/browser", async (_req, res) => {
    let version: string | null = null;
    let pages: { title: string; url: string }[] = [];
    try {
      const v = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(4000) });
      version = ((await v.json()) as { Browser?: string }).Browser ?? null;
      const l = await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(4000) });
      pages = ((await l.json()) as { type: string; title: string; url: string }[])
        .filter((t) => t.type === "page")
        .map((t) => ({ title: t.title, url: t.url }));
    } catch {
      // Not running is a normal state rather than an error: the sidecar is
      // optional, and the portal works without it.
    }

    // The conversations that disagree with the default, not every one that
    // may drive it: the browser is on unless switched off, so "all of them"
    // is the answer almost always and it tells nobody anything.
    const sessions = browserExceptions();
    const routines = getDb()
      .prepare("SELECT slug, name FROM routines WHERE browser = 1")
      .all() as { slug: string; name: string }[];

    res.json({
      running: Boolean(version),
      // An unauthenticated browser holding live logins is the worst outcome
      // here, and nothing else would tell you: the UI simply opens.
      unprotected: Boolean(version) && !service.config().password,
      version,
      pages,
      uiPort: uiPort(),
      allowlist: browserAllowlist().join("\n"),
      // Two separate things that each look fine alone: a browser nobody can
      // drive, and tools pointed at a browser that is gone.
      connectedAs: findConnection(),
      // The container itself, which the portal installs rather than compose.
      install: await service.status(),
      config: { user: service.config().user, hasPassword: Boolean(service.config().password) },
      // Whether a conversation that has never said anything about it has it,
      // and the ones that said otherwise.
      byDefault: browserByDefault(),
      configured: browserServers().length > 0,
      sessions: sessions.map((s) => ({
        id: s.id,
        title: s.title,
        kind: s.kind,
        allowed: browserAllowed(s),
      })),
      routines,
    });
  });

  /**
   * Wire the agent to the browser, or unwire it.
   *
   * Separate from starting the container on purpose — they are separate
   * machines to the portal — but not separate enough to leave to memory, which
   * is how the agent ended up holding tools for a browser that had been
   * removed.
   */
  router.post("/browser/connect", (_req, res) => {
    const { config, error } = readMcpFile();
    if (error) return res.status(409).json({ error: `Fix mcp.json first: ${error}` });
    // Already wired, under whatever name: a second entry would attach the same
    // browser twice, and rewriting somebody's own would lose what they put in it.
    const existing = findConnection();
    if (existing) return res.json({ connectedAs: existing });
    config.mcpServers[MCP_NAME] = mcpEntry();
    writeMcpFile(config);
    res.json({ connectedAs: MCP_NAME });
  });

  router.delete("/browser/connect", (_req, res) => {
    const { config, error } = readMcpFile();
    if (error) return res.status(409).json({ error: `Fix mcp.json first: ${error}` });
    const name = findConnection();
    if (name) delete config.mcpServers[name];
    writeMcpFile(config);
    res.json({ connectedAs: null });
  });

  /** Installing, and the lifecycle after it. */
  router.post("/browser/install", async (_req, res) => {
    try {
      await service.install();
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  const lifecycle = (fn: () => Promise<void>) => async (_req: express.Request, res: express.Response) => {
    try {
      await fn();
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  };
  router.post("/browser/start", lifecycle(() => service.start()));
  router.post("/browser/stop", lifecycle(() => service.stop()));

  /** Removes the container. `?profile=forget` also drops the logins. */
  router.delete("/browser/install", async (req, res) => {
    try {
      if (req.query.profile === "forget") await service.forgetProfile();
      else await service.remove();
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.put("/browser/config", (req, res) => {
    const { user, password, port, httpsPort } = req.body ?? {};
    const saved = service.saveConfig({ user, password, port, httpsPort });
    res.json({ user: saved.user, hasPassword: Boolean(saved.password) });
  });

  router.get("/browser/suggest-password", (_req, res) => {
    res.json({ password: service.suggestPassword() });
  });

  /** Domains the browser may be pointed at. Empty means no restriction. */
  router.put("/browser/allowlist", (req, res) => {
    const domains = req.body?.domains;
    if (typeof domains !== "string") return res.status(400).json({ error: "domains required" });
    setBrowserAllowlist(domains);
    res.json({ allowlist: browserAllowlist().join("\n") });
  });

  /**
   * Turn the browser on or off for one session. Takes effect on its next
   * launch: the tool list is fixed when pi starts.
   */
  /**
   * Grant the browser to one conversation, where the tool switches cannot.
   *
   * With EXECUTOR=container pi is reached over RPC and never reports what it
   * registered, so the portal has no tool list to switch and browserAllowed()
   * falls back to this column. On a host deployment the tools list is the
   * answer and this would be a second one, so it is refused there rather than
   * quietly writing a column nothing reads.
   */
  router.put("/sessions/:id/browser", (req, res) => {
    if ((process.env.EXECUTOR || "host") !== "container") {
      return res.status(400).json({
        error:
          "The browser is switched with its tools — open the tools list beside the composer, or Settings → Tools for every conversation",
      });
    }
    const on = Boolean(req.body?.enabled);
    const row = getDb().prepare("SELECT id FROM sessions WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    getDb().prepare("UPDATE sessions SET browser = ? WHERE id = ?").run(on ? 1 : 0, req.params.id);
    res.json({ enabled: on });
  });

  return router;
}

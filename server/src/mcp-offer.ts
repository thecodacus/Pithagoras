/**
 * Whether the MCP adapter still offers a tool somebody once saw it register,
 * as its configuration and its cache stand now.
 *
 * The portal remembers every tool a chat reported (`tools_seen`), so that a
 * default can be set without a chat being open. The adapter does not register
 * a tool by what the portal remembers: it registers a server's tools directly
 * from its own cache file (`mcp-cache.json`), and only those its configuration
 * still allows. A server switched off, a tool left out by `Only these tools` or
 * `Except these tools`, a server no longer registering its tools directly, a
 * tool the server no longer has: each is a tool the portal went on listing,
 * and a chat that had it loaded went on offering, after the configuration had
 * said no. This is where that is read, kept apart from the files so the rule
 * can be tested on its own.
 *
 * Only for the `server` prefix the adapter uses by default, which is the one
 * `mcpServerOf` can tell a server's tools by. A server named another way is not
 * judged here, and its tools are left as they are.
 */
import { mcpServerOf } from "./tool-policy.js";

export interface McpConfigLike {
  mcpServers?: Record<string, Record<string, unknown>>;
  settings?: Record<string, unknown>;
}

export interface McpCacheLike {
  servers?: Record<string, { tools?: unknown; resources?: unknown } | undefined>;
}

/**
 * - `offered`: the adapter registers it, from a server it starts with the chat.
 * - `cached`: the adapter registers it from its cache, for a server it starts
 *   only when a tool of it is first used: what is listed is what the server had
 *   when it last ran.
 * - `proxied`: the server's tools are no longer registered one by one, so it
 *   is not in any list to switch; it is reached through the `mcp` tool, which
 *   is switched as itself.
 * - `withdrawn`: the configuration says no to it: its server is switched off,
 *   `Only these tools` or `Except these tools` leave it out, or its server no
 *   longer has it. The adapter's own `mcp` tool does not reach it either.
 */
export type McpOffer = "offered" | "cached" | "proxied" | "withdrawn";

/** Not a tool to list: the configuration said no, or has it reached only through `mcp`. */
export const unlisted = (offer: McpOffer | undefined): boolean => offer === "withdrawn" || offer === "proxied";

/** The adapter writes a tool's name with its dots as underscores. */
const sanitized = (name: string): string => name.replace(/\./g, "_");
const normalized = (name: string): string => name.replace(/-/g, "_");

/** As the adapter makes a resource's name a tool's (resource-tools.ts). */
function resourceTool(name: string): string {
  let result = name
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "")
    .toLowerCase();
  if (!result || /^\d/.test(result)) result = "resource" + (result ? "_" + result : "");
  return `read_${result}`;
}

function globMatches(pattern: string, candidate: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(candidate);
}

/** As the adapter matches `includeTools` and `excludeTools`: the bare name or the prefixed one, hyphens as underscores. */
function matchesAny(patterns: unknown, candidates: string[]): boolean {
  if (!Array.isArray(patterns)) return false;
  const names = candidates.map(normalized);
  return patterns.some((pattern) => {
    if (typeof pattern !== "string") return false;
    const p = normalized(pattern);
    return p.includes("*") || p.includes("?") ? names.some((name) => globMatches(p, name)) : names.includes(p);
  });
}

/**
 * The names a server's cache entry lists, as the adapter would register them
 * (without the prefix), or undefined where there is no entry to go by.
 */
function cachedNames(entry: { tools?: unknown; resources?: unknown } | undefined, definition: Record<string, unknown>): Set<string> | undefined {
  if (!entry || !Array.isArray(entry.tools)) return undefined;
  const names = new Set<string>();
  for (const tool of entry.tools) {
    const name = (tool as { name?: unknown } | null)?.name;
    if (typeof name === "string") names.add(sanitized(name));
  }
  if (definition.exposeResources !== false && Array.isArray(entry.resources)) {
    for (const resource of entry.resources) {
      const name = (resource as { name?: unknown } | null)?.name;
      if (typeof name === "string") names.add(resourceTool(name));
    }
  }
  return names;
}

/**
 * What the adapter does with a tool of this name, or undefined for a name no
 * configured server claims. The caller says which names are the adapter's: a
 * server's name is also the start of other tools' (`web` and `web_search`).
 *
 * `directOverride` is the adapter's `MCP_DIRECT_TOOLS`, which replaces what the
 * configuration says about registering tools directly.
 */
export function mcpOffer(
  config: McpConfigLike,
  cache: McpCacheLike | null,
  directOverride: string | undefined = process.env.MCP_DIRECT_TOOLS,
): (name: string) => McpOffer | undefined {
  const servers = config.mcpServers ?? {};
  const settings = config.settings ?? {};
  const names = Object.keys(servers);
  return (name) => {
    const server = mcpServerOf(name, names);
    if (server === undefined) return undefined;
    const definition = servers[server] ?? {};
    if ((definition.toolPrefix ?? settings.toolPrefix ?? "server") !== "server") return undefined;
    const bare = name.slice(server.replace(/-/g, "_").length + 1);

    if (definition.disabled === true) return "withdrawn";

    const candidates = [bare, name];
    if (Array.isArray(definition.includeTools) && definition.includeTools.length && !matchesAny(definition.includeTools, candidates)) {
      return "withdrawn";
    }
    if (matchesAny(definition.excludeTools, candidates)) return "withdrawn";

    // The cache is what the adapter registers from. A server it has an entry
    // for and which no longer lists the tool does not have it any more; one it
    // has none for is not judged on that.
    const listed = cachedNames(cache?.servers?.[server], definition);
    if (listed && !listed.has(bare)) return "withdrawn";

    // Registered one by one or only behind the proxy.
    if (directOverride === "__none__") return "proxied";
    if (directOverride === undefined) {
      const direct = definition.directTools !== undefined ? definition.directTools : settings.directTools;
      if (!direct) return "proxied";
      if (Array.isArray(direct) && !direct.some((wanted) => typeof wanted === "string" && sanitized(wanted) === bare)) {
        return "proxied";
      }
    }

    const lifecycle = definition.lifecycle ?? "lazy";
    return listed && (lifecycle === "lazy" || lifecycle === "lazy-keep-alive") ? "cached" : "offered";
  };
}

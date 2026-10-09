import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/** A wait in milliseconds as it is asked for: whole numbers only, `0` being no wait at all; what is not
 * a number stays the default. Taken here rather than kept twice: memory-llm's model waits are cut with
 * the same knife. */
export const waitMs = (raw: string | undefined, fallback: number): number => {
  if (raw == null) return fallback;
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return fallback;
  return Math.min(Number(t), 2_147_483_647);
};

/** How long Node's own fetch may go quiet on an answer. Its five quiet minutes are no wait the portal chose:
 * they cut Understory's tool calls off mid-thought — its model moves no byte between the ask and the one JSON
 * it answers with — and everything else that reaches out from this process, pi's MCP adapters among them (pi runs
 * in it), ran on them too. memory-llm took waits of its own for its own fetch; these are the ones the rest takes:
 * long enough for one run by default, settable from where the portal starts, `0` turning the wait off. The timer
 * is between bytes, not against the clock: a flowing answer may go on as long as it flows.
 *
 * They ride on every fetch the process makes — pi's provider calls and any extension's included — so the default
 * is a ceiling of quiet, not of work: ten minutes of silence ends a hung upstream, while an answer that keeps
 * moving is never cut by these waits. */
export const globalWaits = {
  headers: waitMs(process.env.PORTAL_FETCH_HEADERS_TIMEOUT_MS, 10 * 60_000), // between the ask and the first byte of the answer
  body: waitMs(process.env.PORTAL_FETCH_BODY_TIMEOUT_MS, 10 * 60_000), // between the bytes of a streaming answer
};

/** Whether node itself was asked to route through the environment's proxies. Node takes `NODE_USE_ENV_PROXY=1`
 * (or its own --use-env-proxy flag, which nothing here can see); this takes any truthy saying of it, because the
 * cost of taking it when not needed is nil — a proxy agent with no proxies in the environment behaves as the
 * plain one — while missing a real one strands every outbound fetch behind the operator's corporate proxy. */
const throughEnvProxies = (): boolean => {
  const said = (process.env.NODE_USE_ENV_PROXY ?? "").trim().toLowerCase();
  return said !== "" && said !== "0" && said !== "false";
};

/** An agent carrying a pair of waits — the portal's own when node was asked to take the environment's proxies,
 * the plain one otherwise. Memory-llm's model agent is made the same way, so the rule lives here once. */
export const waitsAgent = (waits: { headers: number; body: number }): Agent | EnvHttpProxyAgent =>
  throughEnvProxies()
    ? new EnvHttpProxyAgent({ headersTimeout: waits.headers, bodyTimeout: waits.body })
    : new Agent({ headersTimeout: waits.headers, bodyTimeout: waits.body });

let installed = false;

/** Give the process its waits — before anything in it may reach out. Once, however often it is asked: the
 * waits are read at startup, and a second install would be the same dispatcher over the first. Called from the
 * entry on purpose rather than reached for by an import: importing a module should not change how every fetch
 * the importer makes behaves, even if its caller is the process's own start. */
export const installFetchWaits = (): void => {
  if (installed) return;
  installed = true;
  setGlobalDispatcher(waitsAgent(globalWaits));
};

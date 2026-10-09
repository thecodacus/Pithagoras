import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/** A wait in milliseconds as it is asked for: whole numbers only, `0` being no wait at all; what is not
 * a number stays the default. */
const waitMs = (raw: string | undefined, fallback: number): number => {
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
 * is between bytes, not against the clock: a flowing answer may go on as long as it flows. */
export const globalWaits = {
  headers: waitMs(process.env.PORTAL_FETCH_HEADERS_TIMEOUT_MS, 30 * 60_000), // between the ask and the first byte of the answer
  body: waitMs(process.env.PORTAL_FETCH_BODY_TIMEOUT_MS, 30 * 60_000), // between the bytes of a streaming answer
};

setGlobalDispatcher(
  process.env.NODE_USE_ENV_PROXY === "1"
    ? new EnvHttpProxyAgent({ headersTimeout: globalWaits.headers, bodyTimeout: globalWaits.body })
    : new Agent({ headersTimeout: globalWaits.headers, bodyTimeout: globalWaits.body }),
);

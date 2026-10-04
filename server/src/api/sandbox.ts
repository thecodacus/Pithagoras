import express, { type Router } from "express";
import { applySandbox, type ApplyReport } from "../sandbox/apply.js";
import { DEFAULT_POLICY, SECRETS_DIR, TRUSTED_DIR, parsePolicy, sandboxPolicy, sandboxSupport, saveSandboxPolicy } from "../sandbox/policy.js";

/** What the last apply did, for the page to show until the next one. */
let lastReport: ApplyReport | null = null;

/** Settings → Sandbox: the policy, whether this portal can sandbox, and putting a policy on. */
export function sandboxRouter(): Router {
  const router = express.Router();

  router.get("/sandbox", (_req, res) => {
    const support = sandboxSupport();
    res.json({
      policy: sandboxPolicy(),
      defaults: DEFAULT_POLICY(),
      available: support.available,
      reason: support.reason ?? null,
      trustedDir: TRUSTED_DIR,
      secretsDir: SECRETS_DIR,
      lastReport,
    });
  });

  /**
   * Saves a policy and puts it on the files at once. With a big workspace under
   * a read or write rule this walks every file in it, so it can take a while;
   * the answer says what was done and what could not be.
   */
  router.put("/sandbox", async (req, res) => {
    let policy;
    try {
      policy = parsePolicy(req.body);
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
    const support = sandboxSupport();
    if (policy.enabled && !support.available) return res.status(409).json({ error: support.reason });
    saveSandboxPolicy(policy);
    lastReport = await applySandbox(policy, support, true);
    res.json({ policy: sandboxPolicy(), report: lastReport });
  });

  return router;
}

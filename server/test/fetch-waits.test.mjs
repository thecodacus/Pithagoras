import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";

// The waits the whole process's fetch is given — set short, as a run of the portal would ask for.
process.env.PORTAL_FETCH_HEADERS_TIMEOUT_MS = "400";
process.env.PORTAL_FETCH_BODY_TIMEOUT_MS = "600";
const { globalWaits } = await import("../dist/fetch-waits.js");

test("the waits are read from where the portal starts", () => {
  assert.equal(globalWaits.headers, 400);
  assert.equal(globalWaits.body, 600);
});

test("a fetch given the process's wait is cut off at it, not at node's five minutes", async () => {
  // An address that receives the ask and answers none of it — as Understory does while its model thinks.
  const server = http.createServer((req, res) => setTimeout(() => res.end("{}"), 5_000));
  await once(server.listen(0, "127.0.0.1"), "listening");
  const port = server.address().port;

  let failed = false;
  const began = Date.now();
  try {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
    } catch (e) {
      failed = true;
      assert.equal(e?.cause?.code ?? e?.code, "UND_ERR_HEADERS_TIMEOUT");
    }
    const elapsed = Date.now() - began;
    assert.ok(failed, "a headers timeout was raised");
    // The wait that cut it off was the one asked for — long of nothing to do with five minutes.
    assert.ok(elapsed >= 300 && elapsed < 1_500, `it was cut at its own wait (${elapsed} ms), not node's`);
  } finally {
    // Even on an assertion failure: the open listener would outlive the failed test and hold the process.
    server.close();
  }
});

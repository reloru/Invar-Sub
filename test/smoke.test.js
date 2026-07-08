/**
 * Smoke test for the worker's fetch handler, run with plain Node (>=18):
 *   node test/smoke.test.js
 * Uses Node's built-in Request/Response, so no wrangler install is needed.
 */
import worker from "../src/index.js";
import assert from "node:assert/strict";

const url = "http://localhost/";

// GET serves the UI
{
  const res = await worker.fetch(new Request(url));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const html = await res.text();
  assert.match(html, /Substitution Invariance Test/);
}

// POST analyzes text and mutates detected apparatus
{
  const text =
    "The Gaussian distribution is precisely what the stochastic gradient " +
    "requires; under this assumption the eigenbasis is not decorative but real.";
  const res = await worker.fetch(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, seed: 1 }),
    })
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.metrics.tokens > 0, "tokens counted");
  assert.ok(data.metrics.substitutions >= 2, "apparatus terms substituted");
  assert.ok(data.metrics.frames >= 2, "framing moves counted");
  assert.match(data.mutatedText, /⟦[^⟧]+⟧/, "mutation markers present");
  assert.ok(typeof data.verdict === "string" && data.verdict.length > 0);
}

// POST with bad payloads
{
  const empty = await worker.fetch(
    new Request(url, { method: "POST", body: JSON.stringify({ text: "  " }) })
  );
  assert.equal(empty.status, 400);

  const notJson = await worker.fetch(
    new Request(url, { method: "POST", body: "not json" })
  );
  assert.equal(notJson.status, 400);
}

// Other methods rejected
{
  const res = await worker.fetch(new Request(url, { method: "DELETE" }));
  assert.equal(res.status, 405);
}

console.log("smoke test passed");

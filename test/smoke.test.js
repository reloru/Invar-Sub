/**
 * Smoke test for the worker's fetch handler, run with plain Node (>=18):
 *   node test/smoke.test.js
 * Uses Node's built-in Request/Response, so no wrangler install is needed.
 */
import worker from "../src/index.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const url = "http://localhost/";

async function post(text, seed = 1) {
  const res = await worker.fetch(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, seed }),
    })
  );
  assert.equal(res.status, 200);
  return res.json();
}

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
  const data = await post(
    "The Gaussian distribution is precisely what the stochastic gradient " +
      "requires; under this assumption the eigenbasis is not decorative but real."
  );
  assert.ok(data.metrics.tokens > 0, "tokens counted");
  assert.ok(data.metrics.substitutions >= 2, "apparatus terms substituted");
  assert.ok(data.metrics.frames >= 2, "framing moves counted");
  assert.match(data.mutatedText, /⟦[^⟧]+⟧/, "mutation markers present");
  assert.match(data.assessment.apparatus, /^(NONE|LOW|MODERATE|HIGH)$/);
  assert.match(data.assessment.framing, /^(NONE|LOW|MODERATE|HIGH)$/);
  assert.equal(data.assessment.argumentDependence, "UNKNOWN");
  // One swap entry per substitution, each offering distinct non-identity
  // alternatives, first alternative being what mutatedText shows.
  assert.equal(data.swaps.length, data.metrics.substitutions);
  for (const s of data.swaps) {
    assert.ok(s.alternates.length >= 2, "multiple alternatives per span");
    assert.ok(!s.alternates.includes(s.original), "identity excluded");
    assert.equal(new Set(s.alternates).size, s.alternates.length, "alternates distinct");
  }
  assert.ok(data.mutatedText.includes("⟦" + data.swaps[0].alternates[0] + "⟧"));
}

// Pseudo-technical apparatus: coinages, neologisms, numeric claims
{
  const data = await post(
    "The Pneumatic Thought Calibrator recorded “lectro-memes” in 47.3 participants, " +
      "a statistically significant gain of 82% attributable to a factor of 6.4."
  );
  assert.ok(data.metrics.byClass.coinage >= 1, "Title Case coinage detected");
  assert.ok(data.metrics.byClass.neologism >= 1, "quoted neologism detected");
  assert.ok(data.metrics.byClass.quantity >= 3, "numeric claims detected");
  assert.ok(data.metrics.frames >= 1, "boilerplate frame counted");
  // Digit swap preserves format: still a decimal + "participants", still a %.
  assert.match(data.mutatedText, /⟦[1-9]\d*\.\d participants⟧/, "sample size digit-swapped");
  assert.match(data.mutatedText, /⟦[1-9]\d*%⟧/, "percentage digit-swapped");
  // Neologism swap lands between the original quotes.
  assert.match(data.mutatedText, /“⟦[a-z]+(?:-[a-z]+)+⟧”/, "neologism swapped inside quotes");
}

// Honest empirical prose: numbers without conceptual apparatus must not convict
{
  const data = await post(
    "The trial enrolled 240 participants across three sites. Blood pressure " +
      "fell by 12% in the treatment group. The effect was statistically " +
      "significant, and the confidence interval excluded zero. Adverse events " +
      "were rare and mild in both groups over the follow-up period."
  );
  assert.ok(data.metrics.byClass.quantity >= 2, "quantities still detected");
  assert.match(
    data.assessment.apparatus,
    /^(NONE|LOW)$/,
    `honest prose apparatus level was: ${data.assessment.apparatus}`
  );
}

// Regression: the ROARM nonsense paper must score HIGH (it scored LOW in v2.0)
{
  const text = await readFile(new URL("./fixtures/roarm.txt", import.meta.url), "utf8");
  const data = await post(text);
  assert.equal(data.assessment.apparatus, "HIGH", "ROARM apparatus level");
  assert.equal(data.assessment.framing, "HIGH", "ROARM framing level");
  assert.ok(data.metrics.substitutions >= 10, "dense apparatus flagged");
  assert.ok(data.metrics.frames >= 5, "boilerplate framing flagged");
  // “lectro-memes.” — period inside the closing quote must not block detection.
  assert.ok(data.metrics.byClass.neologism >= 1, "quoted neologism with inner period");
  // Title Case runs must not span line breaks: the coinage swap at the end of
  // the title/Conclusion lines must leave the next line's heading intact.
  assert.match(data.mutatedText, /\n\s*Abstract:/, "Abstract heading survives");
  assert.match(data.mutatedText, /\nConclusion\n/, "Conclusion heading survives");
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

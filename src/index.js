/**
 * Substitution Invariance Test — Cloudflare Worker (single file, zero dependencies)
 *
 * Principle: if a technical term can be swapped for an arbitrary same-class term
 * and the surrounding argument reads equally well, the term carried no semantic
 * load. This worker detects candidate terms generically, performs deterministic
 * class-preserving substitutions, and reports two independent signals:
 *   1. substitution density  — how much of the text is swappable apparatus
 *   2. frame density         — rhetorical framing moves per token
 *
 * POST /  { text: string, seed?: number }  →  JSON analysis
 * GET  /  →  UI
 */

export default {
  async fetch(request) {
    if (request.method === "GET") {
      return new Response(HTML_ASSET, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Body must be JSON: { text, seed? }" }, 400);
      }
      const raw = typeof body.text === "string" ? body.text : "";
      if (!raw.trim()) return json({ error: "Empty text payload" }, 400);
      if (raw.length > 60_000) return json({ error: "Text exceeds 60,000 characters" }, 413);

      const seed = Number.isInteger(body.seed) ? body.seed : 0;
      // Strip marker characters so input cannot forge highlight spans downstream.
      const text = raw.replace(/[⟦⟧]/g, "");

      return json(analyze(text, seed));
    }

    return json({ error: "Method not allowed" }, 405);
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/* ------------------------------------------------------------------ */
/*  Core engine                                                        */
/* ------------------------------------------------------------------ */

// Generic detectors. Each match on the ORIGINAL text is recorded with its
// index; overlaps are resolved and the string is rebuilt in one pass, so
// replacement text can never be re-matched by a later detector.
const DETECTORS = [
  {
    cls: "notation",
    // Greek symbols with optional sub/superscripts or arguments, single-letter
    // subscripted variables, differential/quantifier/turnstile symbols.
    regex:
      /[Α-Ωα-ω]\s?[⊢⊨]\s?\S{1,12}|[Α-Ωα-ω][_^]?[0-9a-zA-Z]*(?:\([^)\n]{1,10}\))?|\b[A-Z]_[0-9a-z]+\b|∂[_^]?[a-z0-9]*|[⊢⊨⇒≅≡∀∃∇]/g,
  },
  {
    cls: "eponymPair",
    // Eponymous adjective + noun: "Gaussian distribution", "Markovian process".
    regex: /\b[A-Z][a-z]{3,}(?:ian|ean)\s+[a-z]{3,}\b/g,
  },
  {
    cls: "jargonPair",
    // Latinate adjective + abstract noun by suffix heuristic:
    // "stochastic gradient", "homomorphic mapping", "isomorphic invariant".
    regex:
      /\b[a-z]{5,}(?:ic|ical|istic|morphic|metric|onomic|ological)\s+[a-z]{3,}(?:ity|ism|tion|sion|ance|ence|ology|phism|ure|ient|ant|ator|ctor|ema|old|ing)\b/g,
  },
  {
    cls: "standalone",
    // Single technical tokens that carry apparatus weight on their own.
    regex: /\beigen[a-z]+\b|\bcohomolog[a-z]*\b|\bfunctorial\b|\bmonoidal\b/gi,
  },
  {
    cls: "coinage",
    // Title Case runs of 3+ words: named models, frameworks, instruments
    // ("Pneumatic Thought Calibrator"). Leading articles/pronouns excluded
    // so ordinary sentence openings don't match; words join only across
    // horizontal whitespace so a run can't swallow a heading on the next
    // line. Will fire on real proper nouns of 3+ words — an accepted
    // misfire for the target domain.
    regex:
      /\b(?!(?:The|A|An|In|On|At|It|We|This|That|These|Those|Our|If|As|For|But|And|Or|To|By)\b)[A-Z][a-z]+(?:-[A-Z]?[a-z]+)*(?:[ \t]+[A-Z][a-z]+(?:-[A-Z]?[a-z]+)*){2,5}\b/g,
  },
  {
    cls: "neologism",
    // Quoted lowercase hyphenated coinages: “lectro-memes”. Quotes and any
    // American-style trailing punctuation (“lectro-memes.”) stay outside the
    // span so substitution preserves them.
    regex: /(?<=[“"'‘])[a-z]+(?:-[a-z]+)+(?=[.,;:!?]?[”"'’])/g,
  },
  {
    cls: "quantity",
    // Numeric claims: percentages, factors, sample sizes. Not pooled —
    // digits are swapped in place with format preserved, so "82%" mutates
    // to another percentage and "47.3 participants" to another decimal count.
    regex:
      /\b\d+(?:\.\d+)?\s*(?:%|percent\b)|\bfactors?\s+of\s+\d+(?:\.\d+)?\b|\b\d+(?:\.\d+)?\s+(?:participants|subjects|respondents|patients|trials|samples|observations)\b/gi,
  },
];

const POOLS = {
  notation: [
    "Ω_1", "Ψ(k)", "∂_t", "λ_max", "Γ ⊢ x:T",
    "∇·F", "⟨φ,ψ⟩", "σ-algebra", "μ-recursive", "mod-p",
  ],
  eponymPair: [
    "Gaussian distribution", "Markovian process", "Bayesian posterior",
    "Riemannian metric", "Hermitian operator", "Noetherian ring",
    "Lagrangian dual", "Kolmogorov complexity",
  ],
  standalone: [
    "eigenbasis", "spinor", "cotangent", "adjoint", "simplicial", "presheaf",
  ],
  jargonPair: [
    "homomorphic mapping", "stochastic gradient", "isomorphic invariant",
    "monadic functor", "ergodic decomposition", "spectral operator",
    "topological closure", "variational manifold", "categorical fibration",
    "asymptotic regularization",
  ],
  coinage: [
    "Ontological Drift Assembly", "Recursive Sentiment Lattice",
    "Harmonic Cognition Registry", "Distributed Epistemic Turbine",
    "Modular Inference Prism", "Sequential Abstraction Chamber",
    "Parametric Insight Manifold", "Fractal Attention Compass",
  ],
  neologism: [
    "chrono-glyphs", "psycho-lattices", "flux-tokens",
    "meta-spores", "gravito-memes", "somno-vectors",
  ],
};

// Rhetorical framing moves. Bounded patterns — no unanchored `.*?`, and no
// bare common words. Counted as a SEPARATE signal from substitutability.
const FRAMES = [
  /\bnot\s+(?:\w+[\s,]+){0,4}but\s+(?:rather\s+)?\w+/gi,
  /\bstructurally\s+(?:closer|equivalent|identical|analogous|distinct)\b/gi,
  /\bprecisely\s+(?:because|what|why|the)\b/gi,
  /\bin\s+a\s+(?:deep|strict|formal|real|very\s+real)\s+sense\b/gi,
  /\bdoing\s+something\s+else\s+entirely\b/gi,
  /\bunder\s+(?:that|this)\s+assumption\b/gi,
  /\bthis\s+is\s+(?:exactly|precisely)\s+(?:what|why|how|the)\b/gi,
  /\bwhat(?:'s| is)\s+(?:really|actually)\s+(?:happening|going on|at stake)\b/gi,
  // Academic boilerplate: authority moves that assert significance without
  // carrying evidence. A distinct family from the argumentative frames above.
  /\bstatistically\s+significant\b/gi,
  /\bgroundbreaking\s+(?:perspective|approach|framework|study|insight|finding)s?\b/gi,
  /\bchallenges?\s+conventional\s+(?:assumptions|wisdom|thinking|models)\b/gi,
  /\bfuture\s+(?:research|investigations?|studies|work)\s+(?:should|will|must|could|may)\b/gi,
  /\bpromising\s+(?:foundation|avenue|direction)s?\b/gi,
  /\bexpands?\s+upon\s+previous\s+\w+/gi,
  /\bincreasingly\s+focused\s+on\b/gi,
];

// DJB2-XOR kept unsigned via >>> 0 (Math.abs on a 32-bit signed hash fails at
// -2147483648 and biases the distribution).
function hash32(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (((h << 5) + h) ^ str.charCodeAt(i)) >>> 0;
  }
  return h;
}

function collectSpans(text) {
  const spans = [];
  for (const d of DETECTORS) {
    d.regex.lastIndex = 0;
    let m;
    while ((m = d.regex.exec(text)) !== null) {
      if (m[0].length === 0) { d.regex.lastIndex++; continue; }
      spans.push({ start: m.index, end: m.index + m[0].length, match: m[0], cls: d.cls });
    }
  }
  // Sort by position; on ties prefer the longer span. Then drop overlaps.
  spans.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const kept = [];
  let cursor = 0;
  for (const s of spans) {
    if (s.start >= cursor) { kept.push(s); cursor = s.end; }
  }
  return kept;
}

// Format-preserving digit swap: every digit is rehashed in place, run-leading
// digits stay 1-9 so magnitudes hold ("82" can't become "07"). Non-digits
// (decimal points, "%", "participants") pass through untouched.
function swapDigits(match, seed, start) {
  let runStart = true;
  let out = "";
  for (let i = 0; i < match.length; i++) {
    const c = match[i];
    if (c >= "0" && c <= "9") {
      const h = hash32(`${seed}:${match}:${start}:${i}`);
      out += String(runStart ? 1 + (h % 9) : h % 10);
      runStart = false;
    } else {
      out += c;
      runStart = true;
    }
  }
  // An identity swap is not a test; rotate the last digit ((d % 9) + 1 never
  // maps a digit to itself).
  if (out === match) {
    out = out.replace(/(\d)(?=\D*$)/, (d) => String((Number(d) % 9) + 1));
  }
  return out;
}

function mutate(text, seed) {
  const spans = collectSpans(text);
  const byClass = {};
  for (const d of DETECTORS) byClass[d.cls] = 0;
  let out = "";
  let pos = 0;
  for (const s of spans) {
    byClass[s.cls]++;
    let replacement;
    if (s.cls === "quantity") {
      replacement = swapDigits(s.match, seed, s.start);
    } else {
      const pool = POOLS[s.cls];
      let idx = hash32(`${seed}:${s.match}:${s.start}`) % pool.length;
      // An identity swap is not a test; advance to the next pool entry.
      if (pool[idx].toLowerCase() === s.match.toLowerCase()) idx = (idx + 1) % pool.length;
      replacement = pool[idx];
    }
    out += text.slice(pos, s.start) + "⟦" + replacement + "⟧";
    pos = s.end;
  }
  out += text.slice(pos);
  return { mutatedText: out, substitutions: spans.length, byClass };
}

function analyze(text, seed) {
  const { mutatedText, substitutions, byClass } = mutate(text, seed);

  let frames = 0;
  for (const f of FRAMES) {
    f.lastIndex = 0;
    const m = text.match(f);
    if (m) frames += m.length;
  }

  const tokens = text.split(/\s+/).filter(Boolean).length || 1;
  const subDensity = +((substitutions / tokens) * 100).toFixed(2);
  const frameDensity = +((frames / tokens) * 100).toFixed(2);

  // Numeric claims convict only in the company of swappable conceptual
  // apparatus — honest results sections are full of load-bearing numbers,
  // and numbers alone should not tip the verdict.
  const conceptual = substitutions - byClass.quantity;
  const effSubs = conceptual >= 2 ? substitutions : conceptual;
  const effDensity = (effSubs / tokens) * 100;

  // Density thresholds carry absolute floors so short snippets can't reach
  // a verdict on denominator luck alone.
  let verdict;
  if (substitutions === 0 && frames === 0) {
    verdict = "NO APPARATUS DETECTED";
  } else if (effDensity >= 2 && frameDensity >= 1 && effSubs >= 5 && frames >= 3) {
    verdict = "HIGH: DENSE APPARATUS + FRAMING RHETORIC";
  } else if ((effDensity >= 2 && effSubs >= 4) || (frameDensity >= 1.5 && frames >= 3)) {
    verdict = "ELEVATED: ONE SIGNAL HIGH";
  } else {
    verdict = "LOW / CONTENT-DEPENDENT";
  }

  return {
    seed,
    mutatedText,
    metrics: { tokens, substitutions, subDensity, frames, frameDensity, byClass },
    verdict,
    note:
      "The verdict is a prior, not a proof. The test is the mutation itself: " +
      "if successive mutations argue as convincingly as the original, the " +
      "substituted terms carried no semantic load.",
  };
}

/* ------------------------------------------------------------------ */
/*  UI — galley-proof aesthetic: the mutated terms read as an          */
/*  editor's correction stamps on a typescript.                        */
/* ------------------------------------------------------------------ */

const HTML_ASSET = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Substitution Invariance Test</title>
<style>
  :root{
    --paper:#fbfaf6; --ink:#191817; --rule:#c9c4b8;
    --mark:#b3261e; --pass:#2d6a4f; --dim:#7a756a;
  }
  *{box-sizing:border-box}
  body{
    margin:0; background:var(--paper); color:var(--ink);
    font-family:"Nimbus Mono PS","Courier Prime","Courier New",monospace;
    font-size:15px; line-height:1.55; padding:1.25rem;
  }
  .sheet{max-width:1100px;margin:0 auto}
  header{border-bottom:3px double var(--ink);padding-bottom:.6rem;margin-bottom:1.4rem}
  h1{font-size:1.15rem;margin:0;letter-spacing:.12em;text-transform:uppercase}
  header small{color:var(--dim)}
  .grid{display:grid;grid-template-columns:1fr;gap:1.25rem}
  @media(min-width:820px){.grid{grid-template-columns:1fr 1fr}}
  label{display:block;margin-bottom:.4rem;color:var(--dim);
        font-size:.8rem;letter-spacing:.08em;text-transform:uppercase}
  textarea,.proof{
    width:100%;min-height:320px;background:#fff;color:var(--ink);
    border:1px solid var(--rule);padding:1rem;font:inherit;
  }
  textarea{resize:vertical}
  textarea:focus{outline:2px solid var(--ink);outline-offset:-2px}
  .proof{overflow-y:auto;max-height:480px;white-space:pre-wrap;color:var(--dim)}
  .proof mark{
    background:transparent;color:var(--mark);font-weight:bold;
    border-bottom:2px solid var(--mark);padding:0 1px;
  }
  .controls{margin-top:.8rem;display:flex;gap:.6rem;flex-wrap:wrap;align-items:center}
  button{
    background:var(--ink);color:var(--paper);border:1px solid var(--ink);
    padding:.6rem 1.2rem;font:inherit;font-size:.85rem;cursor:pointer;
    letter-spacing:.08em;text-transform:uppercase;
  }
  button:hover{background:#000}
  button:focus-visible{outline:2px solid var(--mark);outline-offset:2px}
  button.secondary{background:transparent;color:var(--ink)}
  button:disabled{opacity:.4;cursor:default}
  .seed{color:var(--dim);font-size:.85rem}
  .ledger{
    margin-top:1.4rem;border-top:1px solid var(--rule);
    display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
  }
  .cell{border-bottom:1px solid var(--rule);padding:.7rem .4rem;font-size:.85rem}
  .cell b{display:block;font-size:1.25rem;font-weight:bold}
  .stamp{
    margin-top:1.2rem;display:inline-block;padding:.45rem .9rem;
    border:2px solid var(--pass);color:var(--pass);font-weight:bold;
    letter-spacing:.1em;transform:rotate(-1.2deg);
  }
  .stamp.hot{border-color:var(--mark);color:var(--mark)}
  .byclass{margin-top:.6rem;color:var(--dim);font-size:.8rem;letter-spacing:.04em}
  footer{margin-top:1.6rem;color:var(--dim);font-size:.78rem;max-width:70ch}
  @media(prefers-reduced-motion:no-preference){
    .stamp{transition:transform .12s ease}
    .stamp:hover{transform:rotate(0deg)}
  }
</style>
</head>
<body>
<div class="sheet">
  <header>
    <h1>Substitution Invariance Test</h1>
    <small>v2.1 — class-preserving mutation of technical and pseudo-technical apparatus, edge-executed</small>
  </header>

  <div class="grid">
    <section>
      <label for="input-text">Typescript under examination</label>
      <textarea id="input-text" spellcheck="false"
        placeholder="Paste prose whose rigor you suspect is decorative. Notation, eponyms, latinate term-pairs, Title-Case coinages, and quoted neologisms are swapped for arbitrary same-class terms; numeric claims get their digits swapped in place."></textarea>
      <div class="controls">
        <button id="run-btn">Run test</button>
        <button id="reroll-btn" class="secondary" disabled>Re-mutate</button>
        <span class="seed" id="seed-label"></span>
      </div>
    </section>
    <section>
      <label for="proof">Mutated proof</label>
      <div id="proof" class="proof">Awaiting typescript.</div>
    </section>
  </div>

  <div class="ledger">
    <div class="cell">Tokens <b id="m-tokens">—</b></div>
    <div class="cell">Substitutions <b id="m-subs">—</b></div>
    <div class="cell">Sub. density % <b id="m-sdens">—</b></div>
    <div class="cell">Frames <b id="m-frames">—</b></div>
    <div class="cell">Frame density % <b id="m-fdens">—</b></div>
  </div>
  <div class="byclass" id="m-byclass"></div>
  <div class="stamp" id="verdict" hidden></div>

  <footer>
    Detection is heuristic (suffix, notation, Title-Case, and numeric-claim
    patterns) and will misfire on ordinary prose — including real proper nouns
    and honest statistics. The verdict is a prior. The test is your own read of
    the proof: if each re-mutation argues as well as the original, the marked
    terms — and the swapped numbers — carried no semantic load.
  </footer>
</div>

<script>
(function(){
  var input = document.getElementById('input-text');
  var proof = document.getElementById('proof');
  var runBtn = document.getElementById('run-btn');
  var rerollBtn = document.getElementById('reroll-btn');
  var seedLabel = document.getElementById('seed-label');
  var verdict = document.getElementById('verdict');
  var seed = 0;

  function esc(s){
    return s.replace(/[&<>]/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];
    });
  }

  function setMetric(id, v){ document.getElementById(id).textContent = v; }

  async function run(){
    var text = input.value;
    if (!text.trim()) return;
    runBtn.disabled = true; rerollBtn.disabled = true;
    proof.textContent = 'Mutating at edge…';
    try {
      var res = await fetch('/', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({ text: text, seed: seed })
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));

      // Escape first, then promote markers to highlight spans. User content
      // never reaches innerHTML unescaped; marker chars are stripped server-side.
      proof.innerHTML = esc(data.mutatedText)
        .replace(/⟦([^⟧]*)⟧/g, '<mark>$1</mark>');
      proof.style.color = 'var(--ink)';

      setMetric('m-tokens', data.metrics.tokens);
      setMetric('m-subs', data.metrics.substitutions);
      setMetric('m-sdens', data.metrics.subDensity);
      setMetric('m-frames', data.metrics.frames);
      setMetric('m-fdens', data.metrics.frameDensity);

      var byClass = data.metrics.byClass || {};
      setMetric('m-byclass', Object.keys(byClass).map(function(k){
        return k + ' ' + byClass[k];
      }).join(' · '));

      verdict.hidden = false;
      verdict.textContent = data.verdict;
      verdict.className = /^(HIGH|ELEVATED)/.test(data.verdict) ? 'stamp hot' : 'stamp';

      seedLabel.textContent = 'seed ' + data.seed;
      rerollBtn.disabled = false;
    } catch (err) {
      proof.textContent = 'Error: ' + err.message;
      proof.style.color = 'var(--mark)';
    } finally {
      runBtn.disabled = false;
    }
  }

  runBtn.addEventListener('click', function(){ seed = 0; run(); });
  rerollBtn.addEventListener('click', function(){ seed += 1; run(); });
})();
</script>
</body>
</html>`;

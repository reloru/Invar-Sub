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
 * Optionally, a third signal from a model judge (Workers AI, Clef):
 *   3. coherence under substitution — the original and several mutations are
 *      scored for coherence; a collapse means the terms were load-bearing,
 *      no change means they weren't.
 *
 * POST /       { text: string, seed?: number }  →  JSON analysis
 * POST /score  { text: string }                 →  model-judged invariance
 * GET  /  →  UI
 */

export default {
  async fetch(request, env = {}) {
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
      if (!raw.trim()) return json({ error: "Paste some text first" }, 400);
      if (raw.length > 60_000) return json({ error: "Text is too long (60,000 character limit)" }, 413);

      // Strip marker characters so input cannot forge highlight spans downstream.
      const text = raw.replace(/[⟦⟧]/g, "");

      if (new URL(request.url).pathname === "/score") {
        if (!env.AI) return json({ error: "AI check isn't available here" }, 501);
        try {
          return json(await score(text, env.AI));
        } catch (err) {
          return json({ error: "AI check failed: " + (err && err.message || err) }, 502);
        }
      }

      const seed = Number.isInteger(body.seed) ? body.seed : 0;
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

// Several distinct pool picks per span, identity excluded — one plausible
// swap is invisible, but a fan of alternatives lets the reader see that the
// text cannot adjudicate between them.
function poolAlternates(pool, match, seed, start, want) {
  const alts = [];
  const idx = hash32(`${seed}:${match}:${start}`) % pool.length;
  for (let step = 0; step < pool.length && alts.length < want; step++) {
    const cand = pool[(idx + step) % pool.length];
    if (cand.toLowerCase() !== match.toLowerCase() && !alts.includes(cand)) alts.push(cand);
  }
  return alts;
}

function quantityAlternates(match, seed, start, want) {
  const alts = [];
  for (let salt = 0; alts.length < want && salt < 12; salt++) {
    const cand = swapDigits(match, `${seed}.${salt}`, start);
    if (cand !== match && !alts.includes(cand)) alts.push(cand);
  }
  return alts;
}

function mutate(text, seed) {
  const spans = collectSpans(text);
  const byClass = {};
  for (const d of DETECTORS) byClass[d.cls] = 0;
  const swaps = [];
  let out = "";
  let pos = 0;
  for (const s of spans) {
    byClass[s.cls]++;
    const alternates =
      s.cls === "quantity"
        ? quantityAlternates(s.match, seed, s.start, 3)
        : poolAlternates(POOLS[s.cls], s.match, seed, s.start, 3);
    swaps.push({ original: s.match, cls: s.cls, alternates });
    out += text.slice(pos, s.start) + "⟦" + alternates[0] + "⟧";
    pos = s.end;
  }
  out += text.slice(pos);
  return { mutatedText: out, substitutions: spans.length, byClass, swaps };
}

function analyze(text, seed) {
  const { mutatedText, substitutions, byClass, swaps } = mutate(text, seed);

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

  // Each signal is graded separately, with absolute floors so short snippets
  // can't reach a level on denominator luck alone. The tool reports priors;
  // whether the argument actually depends on its terms is the reader's call,
  // which is why argumentDependence is always UNKNOWN.
  const apparatus =
    substitutions === 0 ? "NONE"
    : effDensity >= 2 && effSubs >= 5 ? "HIGH"
    : effDensity >= 1 && effSubs >= 3 ? "MODERATE"
    : "LOW";
  const framing =
    frames === 0 ? "NONE"
    : frameDensity >= 1.5 && frames >= 3 ? "HIGH"
    : frameDensity >= 0.75 && frames >= 2 ? "MODERATE"
    : "LOW";

  return {
    seed,
    mutatedText,
    swaps,
    metrics: { tokens, substitutions, subDensity, frames, frameDensity, byClass },
    assessment: {
      apparatus,
      framing,
      argumentDependence: "UNKNOWN",
      recommendation:
        "If the swapped text sounds just as convincing, the original " +
        "terms weren't doing any work.",
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Model-judged invariance (Workers AI, Clef)                         */
/* ------------------------------------------------------------------ */

const SCORE_SEEDS = [0, 1, 2];
const CLEF_QUESTIONS = {
  coherent: {
    type: "noul",
    instructions:
      "Does this passage make a coherent, internally consistent argument in " +
      "which each technical term fits what is claimed about it?",
  },
};

async function judgeCoherence(ai, state) {
  const res = await ai.run("@cf/cloudflare/clef", {
    model: "clef",
    state,
    questions: CLEF_QUESTIONS,
  });
  const p = res && res.answers && res.answers.coherent && res.answers.coherent.noul;
  if (typeof p !== "number") throw new Error("unexpected Clef response");
  return p;
}

// The judge scores the original and several mutations with identical
// questions. Invariance is read from the change, not from any single score:
// a coherent original whose mutations collapse had load-bearing terms; a
// coherent original that survives substitution had decorative ones; an
// incoherent original has no argument for its terms to carry.
async function score(text, ai) {
  const mutations = SCORE_SEEDS.map((s) => {
    const { mutatedText, substitutions } = mutate(text, s);
    return { seed: s, text: mutatedText.replace(/[⟦⟧]/g, ""), substitutions };
  });
  if (mutations[0].substitutions === 0) {
    return { reading: "NOTHING TO SUBSTITUTE", original: null, mutations: [], coherenceLost: null };
  }

  const [original, ...mutated] = await Promise.all([
    judgeCoherence(ai, text),
    ...mutations.map((m) => judgeCoherence(ai, m.text)),
  ]);
  const meanMutated = mutated.reduce((a, b) => a + b, 0) / mutated.length;
  const coherenceLost = Math.max(0, original - meanMutated);

  const reading =
    original < 0.5 ? "INCOHERENT BEFORE SUBSTITUTION"
    : coherenceLost >= 0.3 ? "LOAD-BEARING"
    : "DECORATIVE";

  const r4 = (x) => +x.toFixed(4);
  return {
    reading,
    original: r4(original),
    mutations: mutations.map((m, i) => ({ seed: m.seed, coherence: r4(mutated[i]) })),
    coherenceLost: r4(coherenceLost),
    note:
      "AI can be fooled by fluent nonsense too.",
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
    border-bottom:2px solid var(--mark);padding:0 1px;cursor:pointer;
  }
  .proof mark.orig{color:var(--pass);border-bottom-color:var(--pass)}
  .proof mark:focus-visible{outline:2px solid var(--ink);outline-offset:1px}
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
  .ai{margin-top:1.6rem;border-top:3px double var(--ink);padding-top:1rem}
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
    <small>v2.3 — swaps technical terms to see if the argument still holds</small>
  </header>

  <div class="grid">
    <section>
      <label for="input-text">Text to test</label>
      <textarea id="input-text" spellcheck="false"
        placeholder="Paste text here. Technical terms and numbers get swapped for random look-alikes."></textarea>
      <div class="controls">
        <button id="run-btn">Run test</button>
        <button id="reroll-btn" class="secondary" disabled>Reshuffle</button>
        <button id="ai-btn" class="secondary" disabled>Score with AI</button>
        <span class="seed" id="seed-label"></span>
      </div>
    </section>
    <section>
      <label for="proof">Swapped text — tap a red word to cycle options</label>
      <div id="proof" class="proof">Results appear here.</div>
    </section>
  </div>

  <div class="ledger">
    <div class="cell">Words <b id="m-tokens">—</b></div>
    <div class="cell">Swaps <b id="m-subs">—</b></div>
    <div class="cell">Swaps per 100 words <b id="m-sdens">—</b></div>
    <div class="cell">Stock phrases <b id="m-frames">—</b></div>
    <div class="cell">Stock phrases per 100 words <b id="m-fdens">—</b></div>
  </div>
  <div class="byclass" id="m-byclass"></div>
  <div class="stamp" id="verdict" hidden></div>
  <div class="byclass" id="rec"></div>
  <section class="ai" id="ai-result" hidden>
    <label>AI check — does it still make sense after swapping?</label>
    <div class="ledger">
      <div class="cell">Original <b id="ai-orig">—</b></div>
      <div class="cell">Swap 1 <b id="ai-m0">—</b></div>
      <div class="cell">Swap 2 <b id="ai-m1">—</b></div>
      <div class="cell">Swap 3 <b id="ai-m2">—</b></div>
      <div class="cell">Sense lost <b id="ai-lost">—</b></div>
    </div>
    <div class="stamp" id="ai-reading"></div>
    <div class="byclass" id="ai-explain"></div>
  </section>

  <footer>
    Detection is rough and can flag normal writing. The real test is your own
    read: tap red words to cycle swaps (green is the original). If every
    version sounds equally convincing, the terms weren't doing any work.
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
  var rec = document.getElementById('rec');
  var seed = 0;
  var cycles = [];

  function cycleMark(el) {
    var i = +el.dataset.i;
    if (!cycles[i]) return;
    var pos = ((+el.dataset.pos || 0) + 1) % cycles[i].length;
    el.dataset.pos = pos;
    el.textContent = cycles[i][pos];
    // Last entry in the cycle is the author's original.
    el.classList.toggle('orig', pos === cycles[i].length - 1);
  }
  proof.addEventListener('click', function(e){
    if (e.target.tagName === 'MARK') cycleMark(e.target);
  });
  proof.addEventListener('keydown', function(e){
    if ((e.key === 'Enter' || e.key === ' ') && e.target.tagName === 'MARK') {
      e.preventDefault(); cycleMark(e.target);
    }
  });

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
    proof.textContent = 'Working…';
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
      // Marks are numbered in document order, which matches the swaps array.
      var n = 0;
      proof.innerHTML = esc(data.mutatedText)
        .replace(/⟦([^⟧]*)⟧/g, function(_, t){
          return '<mark tabindex="0" data-i="' + (n++) + '">' + t + '</mark>';
        });
      proof.style.color = 'var(--ink)';
      cycles = (data.swaps || []).map(function(s){
        return s.alternates.concat([s.original]);
      });

      setMetric('m-tokens', data.metrics.tokens);
      setMetric('m-subs', data.metrics.substitutions);
      setMetric('m-sdens', data.metrics.subDensity);
      setMetric('m-frames', data.metrics.frames);
      setMetric('m-fdens', data.metrics.frameDensity);

      var CLASS_LABELS = {
        notation: 'symbols', eponymPair: 'named terms', jargonPair: 'jargon pairs',
        standalone: 'math terms', coinage: 'made-up names',
        neologism: 'made-up words', quantity: 'numbers'
      };
      var byClass = data.metrics.byClass || {};
      setMetric('m-byclass', Object.keys(byClass).map(function(k){
        return (CLASS_LABELS[k] || k) + ' ' + byClass[k];
      }).join(' · '));

      var a = data.assessment;
      verdict.hidden = false;
      verdict.textContent = 'JARGON: ' + a.apparatus + ' · STOCK PHRASES: ' + a.framing;
      verdict.className = (a.apparatus === 'HIGH' || a.framing === 'HIGH') ? 'stamp hot' : 'stamp';
      rec.textContent = a.recommendation;

      seedLabel.textContent = 'seed ' + data.seed;
      rerollBtn.disabled = false;
      aiBtn.disabled = false;
    } catch (err) {
      proof.textContent = 'Error: ' + err.message;
      proof.style.color = 'var(--mark)';
    } finally {
      runBtn.disabled = false;
    }
  }

  var aiBtn = document.getElementById('ai-btn');
  var aiResult = document.getElementById('ai-result');
  var aiReading = document.getElementById('ai-reading');
  var aiExplain = document.getElementById('ai-explain');
  var READING = {
    'LOAD-BEARING': ['TERMS MATTER', "The original makes sense and the swapped versions don't."],
    'DECORATIVE': ['DECORATIVE', 'It makes sense either way, so the terms were just decoration.'],
    'INCOHERENT BEFORE SUBSTITUTION': ["DOESN'T MAKE SENSE", "The original doesn't make sense to begin with."],
    'NOTHING TO SUBSTITUTE': ['NOTHING TO SWAP', 'No technical terms found.']
  };
  function pct(x){ return x == null ? '—' : Math.round(x * 100) + '%'; }

  async function scoreAI(){
    var text = input.value;
    if (!text.trim()) return;
    aiBtn.disabled = true;
    aiResult.hidden = false;
    aiReading.className = 'stamp';
    aiReading.textContent = 'Checking…';
    aiExplain.textContent = '';
    try {
      var res = await fetch('/score', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({ text: text })
      });
      var d = await res.json();
      if (!res.ok) throw new Error(d.error || ('HTTP ' + res.status));
      setMetric('ai-orig', pct(d.original));
      for (var i = 0; i < 3; i++) {
        setMetric('ai-m' + i, pct(d.mutations[i] && d.mutations[i].coherence));
      }
      setMetric('ai-lost', pct(d.coherenceLost));
      var r = READING[d.reading] || [d.reading, ''];
      aiReading.textContent = r[0];
      aiReading.className = d.reading === 'LOAD-BEARING' ? 'stamp' : 'stamp hot';
      aiExplain.textContent = r[1] + (d.note ? ' ' + d.note : '');
    } catch (err) {
      aiReading.className = 'stamp hot';
      aiReading.textContent = 'Error: ' + err.message;
    } finally {
      aiBtn.disabled = false;
    }
  }

  runBtn.addEventListener('click', function(){ seed = 0; aiResult.hidden = true; run(); });
  rerollBtn.addEventListener('click', function(){ seed += 1; run(); });
  aiBtn.addEventListener('click', scoreAI);
})();
</script>
</body>
</html>`;

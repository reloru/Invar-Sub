# Invar-Sub — Substitution Invariance Test

A single-file, zero-dependency Cloudflare Worker that stress-tests prose for
decorative rigor.

**Principle:** if a technical term can be swapped for an arbitrary same-class
term and the surrounding argument reads equally well, the term carried no
semantic load. The worker detects candidate terms (notation, eponymous pairs,
latinate jargon pairs, standalone apparatus words, Title-Case coinages like
"Pneumatic Thought Calibrator", quoted neologisms like "lectro-memes"),
performs deterministic class-preserving substitutions, and reports two
independent signals:

1. **Substitution density** — how much of the text is swappable apparatus
2. **Frame density** — rhetorical framing moves per token

Numeric claims (percentages, factors, sample sizes) get their digits swapped
in place, format preserved — if "82% more" survives becoming "58% more", the
number was decoration. Because honest results sections are full of
load-bearing numbers, quantities only count toward the verdict when they
appear alongside swappable conceptual apparatus, and verdict thresholds carry
absolute floors so short snippets can't score on density alone.

The verdict is a prior, not a proof. The real test is your own read of the
mutated output: if each re-mutation argues as well as the original, the marked
terms carried no semantic load.

## API

| Route | Method | Behavior |
|-------|--------|----------|
| `/` | `GET` | Serves the UI |
| `/` | `POST` | `{ "text": string, "seed": number? }` → JSON analysis |

The response includes the mutated text (substitutions wrapped in `⟦…⟧`
markers), a `swaps` array giving each mark's same-class alternatives,
token/substitution/frame metrics, and an `assessment` — apparatus and framing
levels (NONE/LOW/MODERATE/HIGH) plus a recommendation. Argument dependence is
always reported `UNKNOWN`: the tool reports priors, and only a reader can
score whether the argument survived. In the UI, tap any correction to cycle
through its alternatives and back to the author's original (shown in green).
Re-posting with an incremented `seed` produces a different deterministic
mutation. Input is capped at 60,000 characters.

### Model-judged invariance (`POST /score`)

`{ "text": string }` → the original and three mutations (seeds 0–2) are each
scored for coherence by Cloudflare's Clef decision model (Workers AI binding
`AI`). The reading comes from the *change*, not any single score:

| Reading | Meaning |
|---------|---------|
| `LOAD-BEARING` | Original coherent, mutations collapse: the terms did real work |
| `DECORATIVE` | Original coherent and still coherent after swaps: the terms carried no load |
| `INCOHERENT BEFORE SUBSTITUTION` | No argument for the terms to carry in the first place |
| `NOTHING TO SUBSTITUTE` | No apparatus detected; no model calls made |

A genuine Markov-chain passage scores ~95% → ~2% (load-bearing); the ROARM
nonsense paper scores ~1% → ~1%. In the UI this is the opt-in "Score with AI"
button. Without the binding the endpoint returns 501 and everything else works.

## Development

```sh
npm install        # installs wrangler (the only dev dependency)
npm run dev        # local dev server at http://localhost:8787
npm test           # smoke test, plain Node — no wrangler needed
```

## Deploy

```sh
npm run deploy
```

Deploys to `https://invar-sub.<your-account>.workers.dev` — no custom domain
required.

### Custom domain (later)

Once a domain is purchased and added to the Cloudflare account, uncomment the
`routes` block in [`wrangler.toml`](wrangler.toml) and set the pattern:

```toml
routes = [
  { pattern = "yourdomain.com", custom_domain = true }
]
```

Then `npm run deploy` again. Nothing else in the project needs to change.

## Layout

```
src/index.js        the entire worker: engine + inlined UI
test/smoke.test.js  exercises the fetch handler with plain Node
wrangler.toml       worker config (name, entry point, future routes)
```

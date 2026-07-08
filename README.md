# Invar-Sub — Substitution Invariance Test

A single-file, zero-dependency Cloudflare Worker that stress-tests prose for
decorative rigor.

**Principle:** if a technical term can be swapped for an arbitrary same-class
term and the surrounding argument reads equally well, the term carried no
semantic load. The worker detects candidate terms (notation, eponymous pairs,
latinate jargon pairs, standalone apparatus words), performs deterministic
class-preserving substitutions, and reports two independent signals:

1. **Substitution density** — how much of the text is swappable apparatus
2. **Frame density** — rhetorical framing moves per token

The verdict is a prior, not a proof. The real test is your own read of the
mutated output: if each re-mutation argues as well as the original, the marked
terms carried no semantic load.

## API

| Route | Method | Behavior |
|-------|--------|----------|
| `/` | `GET` | Serves the UI |
| `/` | `POST` | `{ "text": string, "seed": number? }` → JSON analysis |

The response includes the mutated text (substitutions wrapped in `⟦…⟧`
markers), token/substitution/frame metrics, and a verdict. Re-posting with an
incremented `seed` produces a different deterministic mutation. Input is
capped at 60,000 characters.

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

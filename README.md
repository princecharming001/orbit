# Orbit

A networking copilot for college students who are recruiting: coffee chats on autopilot.

Orbit connects Gmail, Google Calendar and your LinkedIn export, learns what you're recruiting for, finds the right people, drafts in your voice, tracks every conversation through an inferred pipeline, remembers what was said (Granola notes, voice capture), shows your network as an animated orbit map with paths to anyone and the chains of introductions behind each person, and hands you a morning brief of one-tap suggestions. Every draft follows the outreach playbook in [`docs/plan/15-outreach-playbook.md`](docs/plan/15-outreach-playbook.md). Nothing is sent without your approval, and approval sends at once (there is no undo window in this version), so the draft editor is where you make changes.

"Try it with demo data" on the landing page loads a junior's recruiting season replayed through the real pipeline; see [`docs/plan/14-static-v1-architecture.md`](docs/plan/14-static-v1-architecture.md) §3.

**Live:** https://tryorbit.today

## Run locally

```
pnpm install
pnpm dev            # http://localhost:5173
pnpm test           # unit + integration tests
pnpm --filter @orbit/web build && pnpm e2e   # Playwright end-to-end
```

The build and the e2e preview default to the `/orbit/` base path (`ORBIT_BASE` overrides both); `E2E_PORT` runs the e2e preview on its own port.

## Layout

- `packages/core` — pure domain logic (entity resolution, closeness, graph and Reach paths, orbit layout, stage machine, email signals, note extraction, drafting + validator, LinkedIn warm-up, suggestion rules, recommendations, parsers, demo seed) with unit tests.
- `apps/web` — Vite + React app over IndexedDB; engines, Google and Anthropic adapters, all screens, integration and e2e tests. The chat is the home: its side panel (`src/chat/panel`) runs the app's own pages next to the conversation, so everything can be done without leaving it.
- `supabase/functions/orbit-claude` — Orbit's shared Claude access: a small proxy that holds an Anthropic key on the server so visitors without their own key can use the chat, with per-visitor limits (`supabase/migrations` has its tables). The site uses it when built with `VITE_ORBIT_CLAUDE_PROXY`; a visitor's own key always wins.
- `supabase/functions/orbit-connectors` — Orbit's connector proxy for **Unipile** (live LinkedIn: hosted sign-in, syncing the student's connections, mutual connections, unlinking) and **Village** (warm intro paths to a person or a company). It holds both keys on the server, answers only Orbit's origins, and limits each visitor (it shares `orbit-claude`'s counter table). Until a key is set, that provider's routes answer `503` with `x-orbit-connector: unconfigured` and the app falls back: the LinkedIn export for live sync, Orbit's own graph for warm intros. The site uses it when built with `VITE_ORBIT_LINKEDIN_PROXY` and `VITE_ORBIT_VILLAGE_PROXY` (the deploy workflow sets both). The demo uses a mock connector built from its own network, so both features are visible there without keys.
- `docs/plan` — the complete product and system plan (hosted architecture, data model, AI/ML design, integrations research, roadmap), the as-built note for this static version (14) and the outreach playbook the drafts follow (15). Start at [`docs/plan/README.md`](docs/plan/README.md).

## Deploy

`.github/workflows/deploy.yml` runs lint, typecheck, tests, build and e2e, then publishes `apps/web/dist` to GitHub Pages on pushes to `main`. Enable Pages once: Settings → Pages → Source: GitHub Actions.

### Turning on live LinkedIn (Unipile) and warm intros (Village)

The app build already points at the deployed `orbit-connectors` function. To switch each provider on, set its secrets on the Supabase project (Dashboard → Edge Functions → Secrets, or `supabase secrets set NAME=value`); no app redeploy is needed:

| Secret | What it is |
| --- | --- |
| `UNIPILE_API_KEY` | the Unipile access token |
| `UNIPILE_BASE_URL` | your Unipile DSN with `https://`, e.g. `https://api8.unipile.com:13851` |
| `VILLAGE_API_KEY` | the Village API key |
| `VILLAGE_BASE_URL` | optional; defaults to `https://api.village.do` |
| `ORBIT_CONNECTORS_PER_MINUTE`, `ORBIT_CONNECTORS_PER_DAY` | optional per-visitor limits (default 120 and 3000) |

Redeploy the function itself only when its code changes: `supabase functions deploy orbit-connectors --no-verify-jwt`. Students connect LinkedIn from the chat's setup widget or Settings, Integrations, and turn warm intros on there too.

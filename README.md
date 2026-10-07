# Orbit

A networking copilot for college students who are recruiting: coffee chats on autopilot.

Orbit connects Gmail, Google Calendar and your LinkedIn export, learns what you're recruiting for, finds the right people, drafts in your voice, tracks every conversation through an inferred pipeline, remembers what was said (Granola notes, voice capture), shows your network as an orbit map with paths to anyone, and hands you a morning brief of one-tap suggestions. Every draft follows the outreach playbook in [`docs/plan/15-outreach-playbook.md`](docs/plan/15-outreach-playbook.md). Nothing is sent without your approval, and approval sends at once (there is no undo window in this version), so the draft editor is where you make changes.

"Try it with demo data" on the landing page loads a junior's recruiting season replayed through the real pipeline; see [`docs/plan/14-static-v1-architecture.md`](docs/plan/14-static-v1-architecture.md) §3.

**Live:** https://princecharming001.github.io/orbit/

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
- `apps/web` — Vite + React app over IndexedDB; engines, Google and Anthropic adapters, all screens, integration and e2e tests.
- `docs/plan` — the complete product and system plan (hosted architecture, data model, AI/ML design, integrations research, roadmap), the as-built note for this static version (14) and the outreach playbook the drafts follow (15). Start at [`docs/plan/README.md`](docs/plan/README.md).

## Deploy

`.github/workflows/deploy.yml` runs lint, typecheck, tests, build and e2e, then publishes `apps/web/dist` to GitHub Pages on pushes to `main`. Enable Pages once: Settings → Pages → Source: GitHub Actions.

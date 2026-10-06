# Orbit: plan and build specification

Orbit (working name) is a networking copilot for college students who are recruiting: it connects to their Gmail, Google Calendar and LinkedIn data, learns what they are recruiting for, finds the right people for coffee chats, drafts outreach in their own voice, tracks every conversation through an inferred pipeline, remembers everything about each person (including meeting notes from Granola and voice capture), shows the network as an orbit map with paths to any target, and delivers a morning brief of one-tap suggestions. Nothing is sent without the student's approval.

**Status:** the static v1 is built (`apps/web`, `packages/core`) and deploys to GitHub Pages from `main`; see 14 for what is in it. This directory is the complete 0→1 plan. It is written to be executed in order, phase by phase, by an engineer with no other context. (It was first drafted next to an unrelated spec in another repository; this repository holds only Orbit.)

## Reading order

| # | Document | What it fixes |
|---|---|---|
| 01 | [Product specification](01-product-spec.md) | personas, the five engine rules, onboarding, every screen and state, notifications, design language, metrics |
| 02 | [Architecture and conventions](02-architecture.md) | stack (fixed), repo layout, environments, env vars, naming, flags |
| 03 | [Data model](03-data-model.md) | every table, enum, function, RLS policy, retention rule, migration file |
| 04 | [Integrations](04-integrations.md) | Google (OAuth, verification, Gmail sync, Calendar), LinkedIn (export, enrichment, Unipile), Resend, Granola, Wispr Flow, Fathom, with verified facts and citations |
| 05 | [AI/ML system](05-ai-ml-system.md) | task inventory, runtime, entity resolution, email understanding, stage machine, drafting and validation, recommendations, note extraction, embeddings, cost, guardrails |
| 06 | [Graph, strength and Reach](06-graph-and-reach.md) | touchpoint weights, strength formula, edge inference, path search, orbit layout |
| 07 | [Nurture engine and morning brief](07-nurture-and-morning-brief.md) | suggestion kinds and triggers, scoring, brief generation, approval and send pipeline, learning |
| 08 | [Jobs and sync](08-jobs-and-sync.md) | Inngest event catalogue, every function with steps and flow control, idempotency |
| 09 | [Application](09-api-and-frontend.md) | routes, server actions, repositories, realtime, components |
| 10 | [Security, privacy, compliance](10-security-privacy-compliance.md) | threat model, Google Limited Use, LinkedIn stance, data classes, incident response |
| 11 | [Testing, evals, observability](11-testing-evals-observability.md) | test layers, per-task eval datasets and thresholds, budgets, analytics events, cost alerts |
| 12 | [Roadmap and execution](12-roadmap-and-execution.md) | founder tasks, Phases 0–7 with acceptance criteria, decision log, open gaps, costs, launch checklist, runbook |
| 13 | [LinkedIn warm-up](13-linkedin-warm-up.md) | engage with a cold target's posts before messaging: stage, plan, cards, stance on automation |
| 14 | [Static v1 as built](14-static-v1-architecture.md) | what shipped on GitHub Pages, how it maps to the hosted plan, the demo, tests, migration steps |
| 15 | [Outreach playbook](15-outreach-playbook.md) | what every drafted message must say and must never say: limits per kind, sector notes, subject lines, cadence, anti-patterns (amends 05 §7) |

Precedence when documents disagree: 02 (names) > 03 (schema) > 01 (behaviour) > the subsystem document. File a fix against the lower one.

## Confidence legend

| Tag | Meaning |
|---|---|
| **[DECIDED]** | a product or architecture decision; do not reopen without the founder (log in 12 §9) |
| **[DEFAULT]** | a number or rule chosen so the build can proceed; tune with data |
| **[VERIFIED]** | seen on the vendor's official page or docs on 2026-10-02 (citations in 04 §9) |
| **[SECONDARY]** | third-party source; re-check before relying on it in code |
| **[UNCERTAIN]** | could not be confirmed |
| **[GAP]** | not researched or unknowable from the outside; listed in 12 §10 with how to close it |

## The five rules (from 01 §3.2)

1. Approval binds bytes: nothing is sent unless the student approved that exact text.
2. Every claim in a draft traces to a stored fact.
3. Stages are inferred with confidence; low confidence becomes a one-tap confirmation, never a silent change.
4. Cadence and send caps are enforced in code at send time, not in prompts.
5. The student can always see why: every suggestion, recommendation and path carries its reason.

## What was verified before writing (summary)

- LinkedIn offers no official API path to a US member's connections; the user's own data export (`Connections.csv`) and licensed enrichment (People Data Labs, Coresignal) are the viable inputs; Proxycurl is gone; session-based messaging vendors (Unipile) work but carry User Agreement risk for the student.
- Gmail read scopes are restricted and require Google verification plus an annual CASA Tier 2 assessment; Testing status caps the pilot at 100 users with weekly re-consent; Supabase Auth does not keep Google refresh tokens, so Gmail needs its own OAuth flow.
- Granola has a public API, webhooks and Zapier on Business/Enterprise plans only; Basic gets an MCP server with 30 days of notes; share-by-email works everywhere. Wispr Flow has no dictation API (only an export and a read-only MCP for its Notetaker), so the capture box is the integration. Fathom offers API + webhooks on its free plan.
- Resend supports inbound email with webhooks; Inngest fits the per-user fan-out; Voyage `voyage-4` is the embedding model; Supabase has pgvector with HNSW.

## Glossary

Person (a contact in the student's network, per user) · Organization (company; global) · Affiliation (person ↔ org or school with dates) · Identity (email, LinkedIn URL, … attached to a person) · Touchpoint (one interaction on the unified timeline) · Strength (0–1 closeness between student and person) · Edge (inferred person ↔ person relationship) · Coffee chat (one relationship-in-progress with stages) · Stage event (a transition with evidence and confidence) · Fact (an attributable statement about a person) · Suggestion (a brief card with a reason and optional draft) · Brief (the day's selected suggestions) · Outbound message (a draft that becomes an approved, sent message) · Recommendation (a candidate to start a chat with) · Reach (paths from the student to a target) · Context pack (the only inputs a draft is written from) · Style card (the student's learned writing style).

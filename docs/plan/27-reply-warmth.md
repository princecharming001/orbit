# 27. Closeness that reads the replies

Status: proposed 2026-10-26. Nothing built.

Today closeness (0 to 100, `packages/core/src/scoring/tieScore.ts`) is scored from the pattern of contact only. The one
text signal is note warmth (f13, a three-value label from a keyword regex or an LLM, `notes/extract.ts:60-63`). Reply
text is read only to move the chat forward (yes, no, times, questions). So "Absolutely, happy to help, and how did the
Stripe interview go?" and "ok" count the same.

This plan adds a **reply rapport** signal: how warm, personal and invested the other person is in what they write to
you, on every channel Orbit reads (Gmail, LinkedIn DMs, comments on your posts, and texts in local mode). It updates the
moment a reply is stored, in both local mode and account mode, and stays small enough that one nice reply can never
outrank years of contact.

## What other software and research do

- **Relationship-intelligence CRMs** (Affinity, Introhive, 4Degrees, Pega) score relationships from recency, frequency,
  responsiveness and, in Pega's case, email sentiment, with admin-set weights and a 90-day window. None publish a
  method; Pega's makes sentiment one weighted input among several, which is the shape used here.
- **Gilbert and Karahalios, "Predicting Tie Strength With Social Media" (CHI 2009)**: over 85% accuracy on 2,000 ties.
  Its features include intimacy and emotional-support words in the messages between two people, next to recency,
  frequency and mutual friends; recency and structure carry the most weight. Structure dominates, wording adds; that
  is the weighting used here.
- **Language style matching** (Ireland and Pennebaker, 2011): how closely two people's function-word use matches
  predicted mutual interest (odds ratio 3.05) and relationship stability (1.95). It measures attention more than liking,
  so it enters as a small engagement cue, not as warmth.
- **Politeness strategies** (Danescu-Niculescu-Mizil et al., ACL 2013; ConvoKit `PolitenessStrategies`, MIT): about
  20 lexical markers (gratitude, hedges, deference, direct questions, first and second person). Formal politeness is
  distance, not closeness, so these markers split into warm cues and formal cues.

## Open source to use, and what to skip

| Piece | Use | Why |
|---|---|---|
| `vader-sentiment` (npm, Apache-2.0) | valence of each reply, browser and Deno (`npm:`) | rule-based, handles negation ("not bad"), intensifiers, caps, emoji; no model download; lazy-loaded in the browser |
| ConvoKit politeness markers (MIT) | port the marker patterns into core, with attribution | the pattern list is the reusable part; ConvoKit itself is Python |
| LSM formula (Ireland and Pennebaker) | implement over open closed-class word lists (pronouns, articles, prepositions, auxiliaries, conjunctions, negations, quantifiers) | LIWC's dictionaries are proprietary; closed classes are short and can be listed in code |
| Claude Haiku (already in both classifiers) | content-aware rapport label, added to the existing classify call | reads context a lexicon cannot ("congrats on the offer!", sarcasm, a polite no that is still warm) |
| Skip: transformers.js sentiment models | | 60 to 120 MB download, worse on email than Haiku, too heavy for the edge worker |
| Skip: Empath, NRC lexicons, LIWC | | unclear, non-commercial or proprietary licences |

## The signal

### Per message: `RapportReading` (core, pure)

`packages/core/src/scoring/rapport.ts` (new), `replyRapport(message, context) -> RapportReading`:

```ts
interface RapportReading {
  score: number;          // -1 cold ... 0 neutral ... +1 warm toward the student
  by: 'lexical' | 'llm';  // the LLM reading replaces the lexical one when it arrives
  cues: RapportCue[];     // labels only, never quotes: 'asked_about_you', 'offered_help', 'personal_news', ...
  confidence: number;     // 0..1; short or ambiguous text is low
  v: 1;
}
```

Lexical score, computed at ingest on every channel, free and instant:
- **Warm cues** (+): asks about the student, offers help or an intro, shares personal news, uses the student's first
  name, future plans together ("let's", "next time", "catch up"), gratitude for something specific, informal register
  (contractions, "haha", emoji, warm sign-offs such as "talk soon").
- **Formal cues** (pull toward 0, never negative): "Dear", "Regards", "Sincerely", deference, hedging.
- **Cool cues** (−): explicit distancing ("please remove me", "not the right person to ask", "don't contact"),
  hostility. A **decline is about the ask, not the relationship**: "Unfortunately I can't, but good luck with it!" is
  warm; the decline already moves the chat stage elsewhere.
- **Effort**: reply length relative to the student's message it answers, capped. Brevity is never negative on its own.
  "ok" is neutral, not cold.
- **VADER compound** as one input, weighted down (it reads valence, not closeness).
- **LSM** over the exchange (both sides), a small positive cue only.

LLM reading, folded into the classifier that already runs on each reply (no extra call):
- Browser `llmSignal` (`apps/web/src/integrations/anthropic.ts:478-540`) and server `classify.message`
  (`supabase/functions/_shared/ingest/classify.ts:26-39`) gain `rapport: { warmth: -2..2, familiarity:
  'stranger'|'professional'|'friendly'|'friend', effort: 0..2, cues: RapportCue[] }`. The prompt separates "their
  answer to the ask" from "how they feel about the student".
- Server: today the LLM runs only below 0.75 heuristic confidence. Rapport needs it on every human networking reply of
  20+ characters. Haiku, low effort, about 700 tokens in: a fraction of a cent per reply, under $0.10 per active
  student a month.
- Browser, shared key: add a `reply_rapport` call type to the proxy's light-model allowlist (`orbit-claude/proxy.ts`
  `LIGHT_MODELS`), counted under the existing per-user cap. Own key: as today.

Excluded: outbound messages (except as LSM context), automated mail, auto-replies, recruiting systems and no-reply
senders (`isAutomated`, the recruiting-system check), assistants writing for someone, group threads larger than three
people, forwarded text, and quoted text (already stripped at ingest).

### Per person: a new feature, `reply_rapport` (f16)

In `computeTieFeatures` (`tieScore.ts:299-461`):

- A recency-weighted, shrunk mean of the person's readings:
  `sum(w_i * score_i) / (K + sum(w_i))`, with `w_i = confidence * decay(365-day half-life)` and prior `K = 3`. One
  reply moves the feature at most about a quarter of the way; a steady warm exchange over months reaches it.
- Its own feature, not mixed into note warmth (f13). Today the server adds inbound sentiment into f13 and the browser
  does not (`_shared/ingest/score.ts:208-213` vs `apps/web/src/db/repo.ts:96-107`); both sides move to f16 and the
  difference goes away.
- Weight starts small (0.6 in logit space, baseline 0) and is capped so the feature can move the score by at most
  about 8 points either way. It joins `fitCalibration` (`tieScore.ts:702-725`) so a student's own ratings tune it.
- **Silence never lowers closeness** (the plan 21 rule): no replies means f16 = 0, not negative.

Anchor tests (must hold before shipping):
1. A stranger with one effusive reply stays below the Warm band.
2. A five-year friend whose replies are all "ok" or "sounds good" loses no more than 3 points.
3. A three-month exchange where they ask about you, offer intros and use your name gains 5 to 10 points.
4. A polite decline ("can't this time, but good luck!") does not lower closeness.
5. "Please stop emailing me" lowers it and is named in the explanation.
6. Recruiter templates and auto-replies change nothing.

### Explanation

`explainTie` (`tieScore.ts:560-675`) gains sentences built from the cues, never quoting:
"Their replies are warm: they ask how you're doing and offered to help", "Their replies are brief and formal". These
show in `TieScoreCard` (`components/people/TieScoreCard.tsx:97-105`) and the chat's `explain_score`
(`chat/tools/network.ts:325-354`).

## Where it is computed, channel by channel

### Local mode (browser)

| Channel | Where the reply lands | Change |
|---|---|---|
| Gmail | `engine/ingest.ts:505-765` `processNetworkingThread` | compute the lexical reading next to `heuristicSignal` (`:563`) and store it in `extraction.rapport`; the LLM reading replaces it in the same place when `llmSignal` returns (`:567-586`); rescore after the write, not before (`:378` currently runs earlier) |
| LinkedIn DMs | `engine/conversation.ts:36-123` `storeLinkedInChat`, `engine/linkedinInbox.ts:116,146,190-223` | reading in `storeLinkedInChat`; LinkedIn DMs get the LLM reading too (today they are heuristic only) |
| LinkedIn comments on your posts | `engine/linkedinActivity.ts:139-174` `recordPostTouch` | the comment text exists only in `touchpoint.summary`; compute the reading there and store `rapport` on the touchpoint (`linkedin_comment_in` only) |
| Texts (local only) | `engine/imessage.ts`, `db.textThreads` | lexical reading only, never sent anywhere |

- `buildTieHistory` (`tieScore.ts:820-972`) carries readings from messages and comment touchpoints into the history.
- `repo.ts` `recomputePersonStrength` / `recomputeAllStrengths` need no new reads beyond the messages they already load.
- Backfill: a stamped repair (once per model version) computes lexical readings for stored messages and comments, then
  `recomputeAllStrengths`. LLM readings are not backfilled in local mode (cost); they arrive with new replies.

### Account mode (server)

| Path | File | Change |
|---|---|---|
| Gmail ingest | `_shared/ingest/gmail.ts:342-394` | lexical reading at insert into `orbit.messages.extraction.rapport` |
| LinkedIn sync job | `orbit-worker/handlers/linkedin.ts:149-248`, `_shared/ingest/linkedin.ts:164-226` | same |
| Unipile webhook | `orbit-webhooks/webhooks.ts:163-234` | same |
| Classifier | `_shared/ingest/classify.ts:50-192` | LLM rapport on every qualifying reply; writes `extraction.rapport` |
| Scoring loader | `_shared/ingest/score.ts:112-130, 208-213` | load `extraction->'rapport'`, build f16, stop adding sentiment to f13 |
| Comment engagement | not loaded on the server today (f15 is always 0 there) | load engagement and comment readings so both sides score the same |

- **Order fix:** ingest enqueues `classify.message` and `score.person` at the same moment, so the score can run before
  the reply is read. `classify.message` enqueues `score.person` for that person after it writes the reading (dedupe key
  per message). The ingest-time `score.person` stays for the counts.
- **Backfill job:** `rapport.backfill` (new kind on the classify queue) reads up to 365 days of stored networking
  replies per user, lexical first, LLM for the newest 50 per person, then `score.user`. Run once per user on deploy, and
  on first sign-in for new users after the Gmail backfill.
- Migration: the queue kind mapping, `model_version` bump on `orbit.tie_scores`, no new columns (`extraction` is jsonb).
  Per the 10-26 lesson: check `jsonb_typeof(extraction->'rapport') = 'object'` live after deploy.

### Live updates, end to end

- **Local mode**: a reply is stored → reading written → `recomputePersonStrength` → `people` row changes → every
  `useLiveQuery` on `people` re-renders: the person header, `TieScoreCard`, the map ring (with the existing spotlight
  when someone changes ring, `orbitScene.ts:608-633`), Discover Reach, the People sort. When the LLM reading lands a
  few seconds later, the same chain runs again.
- Reach views do not rebuild on a score change today (`pages/MapPage.tsx:476-554`,
  `components/map/ReachMutuals.tsx:80-108` re-run only on hop-evidence and pair-note events). Add a `people`
  write-stamp subscription, debounced, so an open route re-ranks when a hop's closeness moves.
- **Account mode**: Unipile webhook (seconds) or the Gmail sync (10 minutes; seconds once Gmail push is set up, plan 26
  #11) → `classify.message` → `score.person` → `orbit.tie_scores` → the browser's `/sync/status` poll (60 s) pulls the
  new score. To make that feel live: after a pull that changed `tie_scores`, the browser applies it at once (it already
  does, `serverSync.ts:205-240`); optionally drop the status poll to 15 s while the app is visible.
- How often replies are fetched does not change here: browser `ReplyWatch` every 10 minutes while open; server push as
  above. Plan 26 #12 (Unipile webhooks for browser-mode accounts) makes local-mode LinkedIn replies arrive in seconds.

## Bugs this plan has to fix on the way

1. **Pulled LinkedIn messages lose their channel**: `packages/core/src/server/mappers.ts:882-907` never sets
   `channel: 'linkedin'`, so in account mode `latestReply`, `linkedInRepliesByPerson` and `conversationWith` miss them.
   Rapport readings ride on these rows, so this is fixed first.
2. **Note warmth vs reply sentiment differ by side** (above): unified by f16.
3. **Server f15 (post engagement) is always 0**: loaded on the server so both sides agree.
4. **Local-mode ratings do not change strength** (`engine/closeness.ts:128`; `repo.ts:144,207` never pass `label` or a
   calibration to `tieStrength`): the score card shows the rating but the map and routes do not. Fixed here because
   `fitCalibration` is where f16's weight gets tuned.
5. **Explanation text differs by side** ("You rated them…" vs "You rated this tie N of 5"): one sentence builder.

## Privacy and settings

- Settings, under Closeness: "Read the tone of replies" (on by default; off keeps f16 at 0 and skips the LLM rapport
  call). Account mode stores the setting in `users.settings`.
- Readings store a number and cue labels, never quotes. Server `body_text` retention is unchanged.
- Privacy page (`apps/web/public/privacy/index.html`): add one line under Gmail and LinkedIn use: Orbit reads the tone
  of replies to estimate how close you are; it is shown only to you. Google Limited Use permits this as a user-facing
  feature of the app.

## Pieces of code touched

- **Core**: `scoring/rapport.ts` (new), `scoring/tieScore.ts` (feature, weights, baseline, explain, history),
  `types.ts` (`MessageExtraction.rapport`, `Touchpoint.rapport`), `email/triage.ts` (shared exclusion helpers),
  `server/mappers.ts` (channel fix, rapport carried through).
- **Browser**: `engine/ingest.ts`, `engine/conversation.ts`, `engine/linkedinInbox.ts`, `engine/linkedinActivity.ts`,
  `engine/imessage.ts`, `db/repo.ts`, `engine/closeness.ts`, `engine/repairs` (backfill), `integrations/anthropic.ts`,
  `pages/MapPage.tsx`, `components/map/ReachMutuals.tsx`, `components/people/TieScoreCard.tsx`, `pages/Settings.tsx`,
  `chat/tools/network.ts`, `engine/serverSync.ts`, demo seed (warm and cool replies so the demo shows it).
- **Server**: `_shared/ingest/gmail.ts`, `_shared/ingest/linkedin.ts`, `_shared/ingest/classify.ts`,
  `_shared/ingest/score.ts`, `orbit-worker/handlers/classify.ts`, `orbit-worker/handlers/score.ts`, a new backfill
  handler, `orbit-webhooks/webhooks.ts`, `orbit-api/routes/scores.ts`, `orbit-claude/proxy.ts`, a migration, rebuilt
  bundles.
- **Docs and site**: privacy page, this plan.

## Tests

- Core: `rapport.test.ts` fixtures (warm, terse-but-fine, polite decline, cold, auto-reply, recruiter template,
  forwarded, emoji, non-English short reply), the shrinkage math, the six anchors on `scoreTie`, explanation sentences.
- Browser: ingest a warm Gmail reply → strength rises and the explanation names it; a LinkedIn DM likewise; a comment
  on your post; the LLM reading replacing the lexical one; the setting off → no change.
- Server (PGlite): classify writes `extraction.rapport` as an object; `score.person` runs after classify; the loader
  builds f16; the backfill job.
- e2e: on the demo, a new warm reply arrives and the person's score and sentence update without a reload; the map ring
  moves.
- Live check after deploy: `jsonb_typeof` on the stored readings, `job_runs` for classify and score, one real reply
  traced from webhook to the browser.

## Order of work

1. Core signal and feature with the anchors and tests (nothing user-facing changes yet).
2. Bug 1 (LinkedIn channel on pulled messages) and bug 4 (local ratings).
3. Browser: every channel, LLM schema, proxy call type, backfill repair, live reach refresh.
4. Server: ingest readings, classifier, loader, order fix, backfill job, migration, deploy, live check.
5. UI: explanation sentences, setting, privacy line, demo data.
6. Calibrate: run the six anchors on real accounts' readings, adjust the cap and weight, then ship.

## Open choices

- Default for "Read the tone of replies": on (recommended) or off.
- Whether your own warmth counts too (how you write to them). Recommended no: closeness here is how close they are to
  you, and your outreach is warm by design.
- Account-mode freshness: keep the 60-second sync poll, or 15 seconds while the app is open.

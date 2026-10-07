# 05. AI/ML system design

Status: build specification. Defines every model-backed task, the runtime that executes them, the deterministic algorithms around them (entity resolution, stage inference, ranking), how outputs are grounded and validated, how the system learns from feedback, and what it costs. `packages/ai` and `packages/core` implement this document.

---

## 1. Principles

1. **Code decides, models describe.** Stage transitions, send permissions, cadence, ranking order and merge decisions are computed by deterministic code from stored signals. Models produce the signals (classifications, extractions) and the language (drafts, summaries). No model output changes state without passing through a code gate with a confidence threshold.
2. **Structured outputs everywhere.** Every model call that feeds the system returns a Zod-validated object via `client.messages.parse` with `zodOutputFormat`. Free text is produced only for human-facing copy (drafts, summaries), and even those are fields in a structured object with a `claims` list used by the validator.
3. **Provenance on every fact.** Every `person_facts` row, every draft claim, every suggestion reason points at a source row. The drafting prompt never sees anything that is not a stored, attributable fact or touchpoint.
4. **Untrusted text is data.** Email bodies, meeting transcripts, LinkedIn messages and enrichment payloads are wrapped as untrusted content; tasks that read them output enums and short extracted strings, never instructions or actions.
5. **One model, tuned by effort.** All tasks run `claude-opus-5-5` with adaptive thinking and a per-task `output_config.effort`. Cheaper models are a measured cost lever (section 12), not a default, because a wrong classification costs a user's trust and a wrong draft costs their reputation.
6. **Every task has an eval.** A task ships with a golden dataset, a metric, and a threshold enforced in CI (`11`).
7. **Learn from what the student does.** Approvals, edits, dismissals, stage corrections and fact deletions are logged as `feedback_events` and feed the style card, the ranker's weights and the prompts' few-shot examples.

---

## 2. Task inventory

| # | Task | Trigger | Effort | Mode | Input | Output schema | Cache | Eval metric (threshold) |
|---|---|---|---|---|---|---|---|---|
| T1 | `resume_parse` | onboarding step 4 | medium | realtime (streamed status) | PDF/DOCX as document block (PDF) or extracted text (DOCX) | `ResumeParsed` | system only | field F1 vs 60 labelled resumes (0.9) |
| T2 | `goal_structuring` | step 3 save, goal edits | low | realtime | goal form fields + free text | `RecruitingGoalsStructured` | system | exact match on function/industry labels (0.9) |
| T3 | `email_triage` | each new thread (backfill: batch) | low | batch for backfill, realtime incremental | thread metadata + first 2 messages (stripped, ≤ 2k tokens) | `ThreadTriage` | system + per-user block | networking precision 0.92 / recall 0.9 on 500 threads |
| T4 | `message_signal` | each new message on a networking thread, each LinkedIn message | low | realtime | the message (stripped), the last 3 messages of the thread, chat stage | `MessageSignal` | system + per-user | signal accuracy 0.9 on 400 messages; proposed-time extraction exact 0.85 |
| T5 | `contact_extraction` | messages with a signature block (regex gate) | low | batch/realtime | signature text | `ContactInfo` | system | field precision 0.95 |
| T6 | `note_extraction` | note ingested | medium | realtime | note/transcript (chunked over 60k tokens), attendees, matched people's current facts | `NoteExtraction` | system + per-user | fact precision 0.9 (human-rated), action-item recall 0.85 |
| T7 | `person_summary` | new facts/touchpoints for a person with a chat, debounced 1 h; weekly for strength ≥ 0.6 | medium | realtime | person facts, last 10 touchpoints, affiliations, user goals | `PersonSummary` | system + per-user | rubric score ≥ 4/5 by LLM judge on 100 samples |
| T8 | `draft_message` | suggestion generation, user "Draft message" | high | realtime | context pack (section 7.2) | `DraftMessage` | system + per-user (1 h TTL) | validator pass rate 0.98; judge ≥ 4/5; online approval rate |
| T9 | `brief_compose` | brief generation, after ranking | low | realtime | the ranked suggestions (kind, person, reason) + stats | `BriefSummary` | system + per-user | length and tone checks; judge |
| T10 | `prep_brief` | event in 24 h with matched person; on demand | medium | realtime | person summary, facts, chat history, user goals, org enrichment | `PrepBrief` | system + per-user | judge ≥ 4/5 |
| T11 | `merge_judge` | ambiguous merge candidates (score 0.6–0.85) | low | batch nightly | both person records with identities, affiliations, sample touchpoints | `MergeVerdict` | system | precision 0.97 on 200 pairs |
| T12 | `style_card_build` | after fast-path backfill (≥ 20 sent human emails); weekly refresh; after 10 edits | medium | realtime | 40 sent emails (stripped, ≤ 300 words each) + 10 recent (draft, final) edit pairs | `StyleCard` | system | judge agreement with held-out emails 0.8 |
| T13 | `org_classify` | new organization without industry | low | batch | name, domain, enrichment snippet | `OrgProfile` | system | label accuracy 0.9 |
| T14 | `candidate_fit_explain` | recommendation shown | low | batch (weekly) | candidate profile + user goals + path | `FitExplanation` (two short sentences, codes) | system + per-user | judge; no fabricated facts (0.99) |
| T15 | `judge_draft` | evals only | high | batch | draft + context + rubric | `JudgeScore` | — | — |

All realtime calls use `max_tokens` 4096 (T1: 16000, T6: 8192, T8: 2048). Thinking is adaptive (default on Opus 5.5; `thinking` parameter omitted). No `tool_choice` forcing (unsupported on this model); structured outputs replace it.

Without an API key, T1 runs as a heuristic parser (`packages/core/src/resume/parse.ts`): the contact header (name, email, phone, links, address) is never a facet; section headings are recognised by keyword even with extra words ("RELEVANT EXPERIENCE", "LEADERSHIP & ACTIVITIES", "EDUCATION & HONORS"), and honors, awards, certifications, coursework and "additional information" are ignored; employer, role, dates and location are collected across an entry's header lines, so the chronological ("Stripe   San Francisco, CA" then "PM Intern   Jun 2025 - Aug 2025"), two-column (role, company and dates on separate lines), capitals ("GOLDMAN SACHS, New York, NY") and pipe layouts all give one facet with both title and organization, and a second role under the same employer inherits it. A summary facet is emitted only from a SUMMARY/OBJECTIVE/PROFILE section (or prose in the header) and is one sentence in the form "<Name> is …" (first person and puffery removed), otherwise there is none.

---

## 3. Runtime: `runTask()`

```ts
// packages/ai/src/run.ts
export async function runTask<T>(def: TaskDef<T>, input: TaskInput, opts: { scope: UserScope | null; mode: 'realtime' | 'batch'; refTable?: string; refId?: string }): Promise<TaskResult<T>>
```

Behaviour:

1. **Prompt assembly** in three blocks, in this order, to maximise cache hits:
   - `system[0]`: task instructions + output contract (frozen per prompt version; `cache_control: {type: 'ephemeral'}`; must be ≥ 1,024 tokens, so instructions include the full rubric and examples; verify the model's minimum cacheable prefix in the SDK reference before launch and do not pad artificially).
   - `system[1]` (per-user block, only for tasks marked "per-user"): the user's goals (structured), school, cycle, style card, and 3 exemplar emails; `cache_control: {type: 'ephemeral', ttl: '1h'}`; rebuilt only when its inputs change (hash stored on `style_profiles` and `recruiting_goals`).
   - `messages[0].content`: the task input, volatile. Untrusted text is wrapped in an element whose tag name carries a random per-call nonce, `<untrusted_<nonce> source="email">…</untrusted_<nonce>>`, with any `<untrusted…`/`</untrusted…` sequence inside the text escaped and attribute values quoted; the instructions name the tag and say its content is data to analyse, never instructions to follow. The static v1 build does this today (14 §8).
2. **Call**: `client.messages.parse({ model: 'claude-opus-5-5', max_tokens, system, messages, output_config: { format: zodOutputFormat(def.schema), effort: def.effort } })`. Timeout 120 s (SDK option, milliseconds), `maxRetries: 2` for 429/5xx.
3. **Outcome handling**: `stop_reason === 'refusal'` → record `status = 'refusal'`, return `{ ok: false, reason: 'refusal' }`; callers mark the object `needs_review` (never retry a refusal with the same input). `parsed_output === null` (schema mismatch) → one retry with the validation errors appended; then `parse_error`. `max_tokens` stop → retry once with double `max_tokens` up to the task cap.
4. **Batch mode** (`mode: 'batch'`): the same request params are appended to a per-task batch buffer; the job flushes buffers of ≥ 200 requests or every 10 minutes via `client.messages.batches.create`, stores the batch id in `sync_runs.stats`, and a polling function (`orbit/ai.batch.poll`, every 5 minutes) retrieves results by `custom_id` and dispatches them to the same handler as realtime results. 50 percent cheaper; used for backfill triage, contact extraction, merge judging, weekly fit explanations.
5. **Accounting**: write `ai_calls` with tokens, cache reads/writes, cost (from the price table in `packages/ai/src/pricing.ts`: $4/$20 per MTok, cache read $0.20, cache write 1.25×, batch 0.5×), latency, trace id (Langfuse). A per-user daily LLM budget (`$1.50` realtime, configurable) stops non-essential tasks (T7, T10, T14) when exceeded and logs a warning; essential tasks (T4, T8 on user request) continue. [DEFAULT]
6. **Prompt registry**: each task's prompt is a markdown file with frontmatter `{name, version}`; the registry hashes the file and upserts `prompt_versions`; `ai_calls.prompt_version` and `outbound_messages.prompt_version` record it.

---

## 4. Entity resolution

Goal: one `people` row per real human per user, built from Gmail (addresses, display names, signatures), Calendar (attendees), LinkedIn export (name, URL, company, position, sometimes email), Unipile, enrichment, notes (names), and tracker imports. Deterministic first, probabilistic second, model third, human last.

### 4.1 Normalisation (`packages/core/src/text`)

- Emails: lowercase; for `gmail.com`/`googlemail.com` strip dots and `+tag`; keep others as-is; map `googlemail.com` → `gmail.com`.
- Names: drop honorifics (`dr`, `mr`, `ms`), credentials (`phd`, `mba`, `cfa`, `p.e.`; two-letter ones such as `Ma` are kept when written as a surname), generational suffixes (`jr`, `sr`, `ii`, `iii`, `iv`), emoji, parentheticals, pronouns `(he/him)`, and company tails (`Priya Patel - Figma`, `Priya Patel, Figma`, `Priya Patel | Figma`); flip `Last, First` only when the part before the comma is a single surname (particles such as `de la` allowed); fix the case of all-lowercase or all-uppercase names (`tom wu` → `Tom Wu`, `O'BRIEN` → `O'Brien`, particles stay lowercase), keep mixed case (`DeShawn`). Diacritics are kept in the stored display name (`José Núñez-García`); `name_normalized = "<first> <last>"` is lowercase with diacritics and apostrophes removed and is used for matching only. LinkedIn CSV rows pass first and last name separately, so `Sam` / `Lee, Jr.` is `Sam Lee`, not `Jr Sam Lee`. A person seen only as an address gets a placeholder name (`tom.wu@` → `Tom Wu`, `erodriguez@` → `erodriguez`, flagged `namePlaceholder`) that the first real name replaces.
- Nicknames: a one-way table of nicknames that almost always mean one formal name (`bill→william`, `ken→kenneth`, `josh→joshua`), and a separate list of ambiguous short forms (`alex` = Alexander or Alexandra, `sam`, `chris`, `pat`, `jamie`, `nat`, `john`/`jonathan`, `liam`/`william`, `sasha`, `gail`, `eliza`) that count as a weaker name match. Distinct given names (Stephen/Steven, Catherine/Katherine) are never mapped.
- LinkedIn URLs: lowercase host, path `/in/<slug>`, strip query/fragment/trailing slash, decode percent-encoding.
- Companies: lowercase, unaccent, drop parentheticals, `and` → `&`, strip legal suffixes (`inc`, `llc`, `ltd`, `corp`, `co`, `plc`, `gmbh`), strip `the`, then strip non-distinguishing tails (`& company`, `& co`, `group`, `consulting`, `partners`, `holdings`, a dangling `&`), so `McKinsey`, `McKinsey & Company` and `Goldman Sachs & Co. LLC` / `Goldman Sachs` normalise alike; a small alias table maps `jp morgan`/`j.p. morgan`/`jpmorgan`, `pwc`/`pricewaterhousecoopers`, `ey`/`ernst & young`, `aws`/`amazon web services`, `bcg`/`boston consulting group`, `gs`/`goldman`, `facebook`/`meta`, `citigroup`/`citi`, `bofa` to one key (static build: `packages/core/src/text/normalize.ts`). Organization rows keyed under an older normalisation are re-keyed on first lookup.

### 4.2 Deterministic matching (always first)

An incoming identity matches an existing person if any of: same normalised email; same LinkedIn slug; same Unipile provider id; same `(name_normalized, current organization id)` with both non-null. Match → attach identity (if new) and update fields by source precedence (section 4.5).

### 4.3 Probabilistic matching

For an incoming record without a deterministic match, build candidate blocks: same last name; same first name + same organization; same email domain + same first name; top 10 by trigram similarity of `display_name` (≥ 0.6). For each candidate compute features:

| Feature | Definition |
|---|---|
| `name_sim` | Jaro-Winkler on normalised full names (safe nicknames expanded); 1.0 exact; capped at 0.8 for an ambiguous short form (Alex/Alexandra); 0 when the stored name is an address placeholder |
| `first_sim`, `last_sim` | per-token Jaro-Winkler |
| `org_match` | 1 if the normalised names are equal; 0.8 if one is a word prefix of the other (`Google` / `Google DeepMind`); 0.5 if Jaro-Winkler ≥ 0.9; 0 when either is unknown; −0.5 if both known and different, softened to −0.25 for an identical full name (a job change is the usual reason, so it lands in the suggestion band) |
| `title_sim` | token Jaccard on titles |
| `email_name_sim` | similarity between email local-part tokens and name tokens (`dkim`, `daniel.kim`, `kimd` vs `Daniel Kim` → 1; surname inside → 0.7), computed in both directions (incoming address vs stored name, stored addresses vs incoming name) and halved for free mailboxes (gmail, outlook, yahoo, icloud …) |
| `domain_org_match` | 1 if the email domain is in the candidate org's `domains`; 0.8 if the domain's root is in the org name; both directions (a stored corporate address stands in for a missing stored employer); never for free mailboxes |
| `cooccurrence` | 1 if both appear in the same thread or event as distinct participants (strong negative: they are two people) |
| `school_match` | 1 if same school |
| `time_plausible` | 0 if the incoming record's employment dates contradict the candidate's (overlapping different current jobs) |

Score = logistic function of a weighted sum (initial weights in `packages/core/src/entity-resolution/weights.ts`: name_sim 3.0, last_sim 1.5, org_match 2.0, email_name_sim 1.5, domain_org_match 1.5, title_sim 0.5, school_match 0.5, cooccurrence −6.0, time_plausible −3.0, bias −3.5). Auto-merge needs evidence beyond the name: an incoming address that fits the name at a corporate domain (the stored person's own address fitting the incoming name only repeats the name match and does not count), an employer-domain match, a school match, or (only when the first names are written identically) the very same employer. When the incoming record names another or only look-alike employer (a word-prefix or near-spelling match such as `Bain & Company` / `Bain Capital`), or writes from a work address that is not at the stored employer's domain, nothing short of an address at that domain lets it auto-merge, so the same name at a look-alike firm is only suggested. A bare initial with the same surname (`P. Patel` for `Priya Patel`) counts as a partial name match (`name_sim` 0.6): at the same employer it reaches the suggestion band but never auto-merges. Otherwise the score is held just under the threshold. The names have to agree (`name_sim >= 0.5`) for any pair to reach the suggestion band, and an address at the employer the stored person already lists is not counted again in the score (colleagues share it); this applies to the incremental resolver and to `findDuplicatePairs` alike. When one side has no name (a typed address), only the address pattern plus the employer domain can link them: exact pattern + employer → 0.93, surname-in-address + employer → 0.75. Decision: `≥ 0.92` auto-merge (log `person_merges` with `decided_by = system`); `0.6–0.92` → `merge_suggestions` row; T11 `merge_judge` runs nightly on the suggestions and raises to auto-merge when it returns `same_person` with confidence ≥ 0.9 **and** the heuristic score ≥ 0.75; otherwise the suggestion stays for the user (card in Needs you). `< 0.6` → new person.

Weights are re-fit in Phase 7 from `feedback_events (merge_accept|merge_reject)` plus auto-merges that were undone, with logistic regression (`packages/core/src/entity-resolution/fit.ts`, plain gradient descent, no ML library). [DEFAULT initial weights]

### 4.4 Humans vs automation

A person is `is_human = false` if created only from senders failing the prefilter in `04` section 2.5, or if T3 classifies every thread they appear in as `automated|newsletter|transactional`. Non-humans are hidden from every list and the map and never receive suggestions.

### 4.5 Field precedence when sources disagree

`manual (user edit) > enrichment (fresh ≤ 90 d) > linkedin_csv/unipile > note extraction > email signature > calendar display name > email display name`. Each field on `people` stores its winning source in `people.fieldSources` (`displayName`, `currentTitle`, `currentOrganizationId`, `headline`, `location`, `school`) so a later lower-precedence source does not overwrite; people stored before the map existed are treated as written by their most trusted source. A placeholder name derived from an address is always replaced by the first real name.

### 4.5b Duplicate detection after imports

After every Gmail ingest and LinkedIn CSV import, `findDuplicatePairs` runs over the visible people and each pair at or above `SUGGEST_THRESHOLD` that the student has not already decided on becomes a pending `merge_suggestions` row (a `confirm_merge` card). Pairs are blocked by folded surname, shared address, or (for an address-only person) the employer domain. A shared address or LinkedIn profile scores 1. Otherwise the names have to agree (`name_sim >= 0.5`) before anything else counts, and an address at the employer both people already list is not evidence that they are one person, so colleagues who share a surname and an employer are never paired.

### 4.6 Merge mechanics

`merge_people()` (03 section 4) repoints every child row; edges with both endpoints collapsing are deleted; duplicate touchpoints collapse on the unique key; strength is recomputed. Undo is available for 30 days from the profile's history panel.

---

## 5. Email understanding

### 5.1 Pipeline per thread (incremental) / per batch (backfill)

```
messages.get (full) → strip quotes/signatures (code) → prefilter (code; 04 §2.5)
  → T3 email_triage (thread) → is_networking? ──no──▶ store metadata only; people get touchpoints with low weight (email_cc) if human
                                         └──yes─▶ link/create coffee_chat (5.3) → per message T4 message_signal
                                                 → T5 contact_extraction if signature detected → stage inference (section 6)
                                                 → touchpoints (email_in/out) with full weight → person_facts from extraction
```

Quote stripping: `talon`-style heuristics in TS (`packages/core/src/text/email.ts`): cut at `On … wrote:` (also when Gmail hard-wraps it over two or three lines, and the German, Spanish, Dutch, Portuguese and French forms), `From: … Sent:`, `-----Original Message-----`, lines starting with `>`, and trailing `Sent from my iPhone`/`Get Outlook for iOS` footers. HTML-only mail is converted with `htmlToText`, which drops the Gmail/Outlook/Yahoo quote containers and keeps link targets (`here (https://calendly.com/x)`). HTML entities are decoded in full (named accented letters such as `&eacute;`, numeric references such as `&#8217;`). Signature detection: a `--` line, else the last closer line (`Best,`, `Best regards,`, `Thanks so much,`, `Talk soon,` ...) when every line after it looks like a signature (short, not a sentence or question), else a name line followed by a title or contact line. A line with a Calendly, Zoom, Meet or Teams link, or a sentence that mentions a phone number or meeting ID, is body text and is never cut. Title and employer (`parseTitleCompany`): the sender's display name is removed first (a name line, or a leading `Name |` / `Name,` segment); lines split on `|`, `•`, `·`; the first segment with a title word is the title (`Title at Company` splits there); a comma after the title keeps a team (`Senior Product Manager, Growth`, `Vice President, Investment Banking`) and splits off an employer (`Analyst, Goldman Sachs`); otherwise the employer is the next segment on the title line or the next line that reads as an organisation (`Figma`, `Cornell University`, `Goldman Sachs & Co. LLC | 200 West Street`).

### 5.2 `ThreadTriage` (T3)

```ts
z.object({
  category: z.enum(['networking','recruiting_process','personal','transactional','newsletter','automated','other']),
  is_networking: z.boolean(),           // true only for human 1:1 or small-group professional conversation initiated for advice/intro/coffee chat/referral
  counterpart_emails: z.array(z.string()),  // the non-user humans in the conversation
  initiated_by: z.enum(['user','other','unknown']),
  topic: z.string().max(120),
  confidence: z.number().min(0).max(1),
})
```
Prompt facts: the user's own addresses; the definition of networking (advice, coffee chat, informational interview, referral, intro, alumni outreach, mentor check-in) versus recruiting process (recruiter scheduling, OA links, offer logistics) versus personal. Few-shot: 12 examples in the system block.

### 5.3 Linking threads to chats

A networking thread with counterpart person P (the person the student first wrote to, else the first sender): if P has an active chat → link; else create `coffee_chats (source detected, stage by inference)`. Threads with up to three people are read: a thread that began 1:1 keeps moving P's chat when P later copies someone in, and a thread that began as a group only moves a chat already bound to it. When P's message is an `intro_offer` and puts someone on To/Cc (sent in the last 30 days), that person gets an `identified` chat on the same thread with `referrerPersonId = P`; their replies then move their own chat, and the student's reply moves the chats of the people it is addressed to. Larger group threads only produce touchpoints and co-thread edges.

### 5.4 `MessageSignal` (T4)

```ts
z.object({
  signal: z.enum(['reply_positive','reply_neutral','reply_decline','scheduling_proposal','scheduling_confirmation','reschedule','thank_you','referral_offer','intro_offer','question','out_of_office','other']),
  confidence: z.number(),
  proposed_times: z.array(z.object({ start_iso: z.string(), end_iso: z.string().nullable(), raw: z.string() })),  // resolved with the message date and the user's timezone, given in the prompt
  asks_of_user: z.array(z.string().max(160)),     // "send your resume", "which teams interest you"
  offers: z.array(z.string().max(160)),           // "happy to refer you", "can intro you to X"
  mentioned_people: z.array(z.object({ name: z.string(), context: z.string().max(120) })),
  facts_about_sender: z.array(z.object({ type: z.enum(['role_detail','background','advice','personal','preference','contact_info']), text: z.string().max(200) })),
  sentiment: z.enum(['warm','neutral','cool']),
})
```
Outbound messages (the student's own) are classified too (`signal` ∈ `thank_you | scheduling_proposal | other`) so that thank-yous sent outside Orbit still advance the stage. Any note with thanks sent within 7 days after a chat reached `completed` counts as the thank-you.

Heuristic fallback (no API key, or the call fails): `heuristicSignal` in `packages/core/src/email/triage.ts`, run on the quote- and signature-stripped body with the student's timezone (curly apostrophes typed on a phone are read as straight ones). It is built as clauses, lexicons and weights rather than one pattern per case: the body is cut into sentences (a sentence ending in "?" is a question) and each sentence into clauses at a contrast ("but", "though", "however"); each cue family (yes to a chat, scheduling ask, hard no, no to calls, yes to email, not now, redirect away, recommendation, someone introduced or added, referral and intro offers, confirmation, reschedule, out of office, thanks, parting) is a small lexicon; and the yes / no / not-now stance is weighed (a yes to a chat 3, an ask for times 2, a weak "sure" 1; a hard no 3, a no to calls 2; a not-now 2, or 1 when it only covers days such as "slammed this week"), with a clause that a later contrast clause answers the other way counting half ("I'd love to, but I'm swamped this quarter" is a not-now, "I'm swamped this week, but happy to chat next week" a yes). Inbound order: out of office (a vacation responder always; a hand-typed note only when it offers no time; the return date is kept as `extraction.returnDate`, and "traveling this week" means back the Monday after) → a redirect or recommendation that points to someone (named, by role such as "my colleague" or "our recruiting team", by address, or added to the thread): `intro_offer`, never a decline; it sets `extraction.handoff` unless the sender also says yes to a chat of their own (or asks for times, as in "Send me a few times, and I'd also recommend reaching out to my colleague Ben") and nothing sends the student away from them, so "Happy to chat next week! You should talk to Ana on my team too" and "My colleague Ana would be great too" are a yes with an extra intro (0.8, as sure as any other yes, so the chat moves to replied and times are proposed to the sender), while "not the right person", "better contact", "better off", "talk to Ana instead" and "not my area" always hand off; "not the best person to ask" with nobody named is a soft decline → reschedule or counter-proposal ("something came up", "Can we postpone?", "I won't be able to make Thursday, can we find another time?", "sorry I missed our call, can we try again?"; with a new time, or a question offering a new day ("Can't do this week, sorry. How's Monday morning next week?"), it is a `scheduling_proposal`, so the confirm card appears; without one a `reschedule`; a vague "after the holidays", or "postpone until after the new year", from someone who is busy is a soft decline instead) → a no to calls with a yes to email ("I don't do coffee chats, but happy to answer a couple of questions over email", "I'll pass on a call but send over questions", "Calls are tough for me, happy to answer anything over email", "email is easier for me than a call", "I can't do a call but feel free to email me questions", "Phone isn't great for me, happy to answer a few questions here", "Can't commit to a phone call right now, but feel free to send your questions via email", "Phone's tough with my schedule. Happy to help over email though": `question` with `extraction.prefersEmail`, and the rules never propose times for it) → the sender's assistant added to find a time with no time named yet (`reply_positive`, see below; it comes before confirmation, so "Adding my assistant Karen (cc'd) to help us find a time. Looking forward to it!" is not a confirmation) → confirmation (invite sent or accepted, "see you then", "talk Thursday", "that works", "you're all set", a meeting link; when the same message asks about a new time it is a proposal instead; a bare "booked", or "feel free to send a calendar invite for whenever works", is not a confirmation, and a closing "looking forward to it" confirms only when nothing in the message still looks for a time, such as an ask for times or "to find a time") → proposal (concrete times, a booking link, "does X work", a day offered back after turning down the times on offer, as in "I can't do any of those times. Do you have anything Friday morning?" or "Not Monday, sorry, but anything Friday morning?"; a question is read clause by clause, so the day turned down offers nothing, and a question about the past or a booking, "Did you get my note on Monday?", offers no day) unless it is a no with no time → hard decline (`extraction.decline = 'hard'`) when the no outweighs any yes and nothing turns to a time that works: "not interested", "I'll pass", "I'll pass this time", "I'm going to pass this round", "have to decline", "not permitted to speak with candidates", "no thank you", a bare "thx but no", "I'd rather not", "I don't have time for a call", "I get a lot of these requests and can't take them on", "Unfortunately I won't be able to take this on", "please don't email me", or a no to calls with no email offered; a no limited to now ("I'm not taking on new mentees this year", "can't right now") is a not-now, and any no followed by an invitation to try later ("Pass for now, but try me again in Q1") is a soft decline; "pass" counts only when nothing is passed along ("pass this along", "pass that on to the team", "pass on your resume" are referrals) → referral and intro offers ("I'll pass your resume along", "I'll forward it to the hiring manager", "I'll submit you as a referral", "I can put in a referral for you", "I'd be glad to put your name in"; passing on a greeting, "Pass along my best to Professor Chen", is not a referral, "I can also introduce you to a couple of people", "looping in Sam (cc'd)", "Carlos (cc)", "+ Hannah", "Sam, please meet Alex", "connecting you as promised"; an offer word in a question about the past such as "which Sarah referred you?" is not an offer; an intro that names, copies or introduces the new person, or that points away from the sender ("Let me connect you with Marcus; he'd be a much better fit"), sets `extraction.handoff` unless the sender also says yes to a chat or asks for times, and the rules then propose no times to the introducer and raise a `new_outreach` card for the person introduced) → the sender's scheduler added to the thread ("I'm cc'ing my EA Jordan to set up time", "looping in my assistant to find a time", "copying my coordinator who handles my calendar", "+Kelly (my EA) who'll coordinate a time for us", or someone from the sender's own office or team brought in only to schedule, "Looping in Beth from my office to help schedule": `reply_positive`, no offer and no hand-off, so times are proposed on the thread and nobody gets a cold note; a named person added "to find a time" with no assistant role, as in "Looping in Sam (cc'd) to find a time to chat with you", is an intro to Sam) → thank-you after a conversation ("great chatting", "a pleasure meeting you", "really enjoyed our chat", "Appreciated the conversation earlier, thanks for making the time", "thank you for the follow-up note"; never "thanks for reaching out") → soft decline (`extraction.decline = 'soft'`: "slammed this quarter, maybe in the new year", "don't really have bandwidth", "now isn't a great time", "timing is rough right now", "things are pretty crazy for me right now", "not this quarter", "no longer at Google"; when they say when to try again it is kept as `extraction.followUpAfter`, e.g. "ping me in January" → 1 January, "try me again in Q1" → 1 January, and the when of an invitation to come back wins over other dates, so "swamped until after our launch in November. Ping me in December?" → 1 December; a "best of luck" close counts only when nothing in the message is warm, so "Congrats, best of luck this summer" or "thanks for the update, best of luck" is not a decline, and then only next to a refusal or an apology ("We aren't hiring interns this cycle. Best of luck!") or on a chat still waiting on the person's answer (`outreach_sent`, `replied`, `no_response`; ingest passes this as `awaitingAnswer`); "Nice work on the offer. Best of luck!" on a nurturing chat is a friendly close) → a question for the student (a question that is not about when to meet; it beats a plain "sure", so "Sure, what's the role you're looking at?" is a question, unless the message also asks for times) → positive → a request of the student → neutral. A scheduling prompt ("let me know what works", "what does your schedule look like next week?", "how does your week look?", "What times work for you?") is a yes, not an ask of the student. The rules are pinned by a labelled corpus of about 500 replies (`packages/core/src/__tests__/fixtures/reply-signals-*.ts` plus the older email corpus): the tuning part must pass in full and the held-out fifth, never used for tuning, must stay at or above 95% with every hard decline and every intro right; the test prints a confusion summary. `heuristicTriage` counts cues instead of testing for one word: networking vocabulary on both sides plus the student's outreach phrasing ("junior at", "would you be open to", "your perspective"), recruiting-process vocabulary, and phrase-level transactional cues ("your order", "verification code", not "order" or "payment"). Recruiting wins only with at least two recruiting cues (or one and a recruiter sender) that outnumber the networking ones, and never on a thread the student opened with a networking ask; networking confidence is `0.55 + 0.1 × min(cues, 3)` plus 0.1 for a two-way thread.

Proposed times (heuristic): a small tokenizer (`packages/core/src/email/when.ts`) reads weekday, date (`10/8`, `Oct 8`, `the 8th`), `today`/`tomorrow`, clock time (`2pm`, `2:30`, `noon`), ranges (`2-3pm`, `from 2 to 4`, `between 10 and noon`), modifiers (`at`, `around`, `after`, `before`), part of day and zone (`ET`, `PST`, `Pacific`, IANA names, a city with "time" such as "Boston time" or "London time") in either order (`2pm Thursday`). Week scopes place a bare weekday: "next week is wide open. Tues 10am?" and "Tuesday next week" are next week's Tuesday, "the week after" is one week past the week named before it, and a week named as busy ("I'm traveling next week. Would Thursday work?") does not move the day. "next Thursday" is Thursday of the following Monday-to-Sunday week; "this Thursday" or a bare "Thursday" is the next one to come. A bare hour needs a cue (`at 3`, a range, `in the afternoon`, or an "or" after a cued time, as in "Thursday at 10 or 11"); words that only start like a weekday (`Monaco`, `month`) and past references (`last Friday at 5`) are ignored, as are counts ("from 5 to 20 people on Monday") and a bare number naming a place or firm ("at 5 Capital", "10 Hudson Yards"); right after a day only a name of two or more capitalised words makes it a place ("Monday at 5 Capital Street"), so "Thursday at 3 Alex?" and "Would Monday at 4 Sound good?" are times, and a sign-off name on the next line never counts. A full day or month name ending a sentence does not join the next sentence's time when that sentence names a day of its own ("I'm booked Wednesday. Tuesday at 2pm works" offers only Tuesday), but still pairs with a bare time there ("Let's do Wednesday. 2pm work?" is Wednesday at 2pm), and a sentence that gives only a time takes the one day the sentence before it named ("Monday works. 10am?"). "Later that day", "that afternoon" and "the same day" reuse the day named last ("Mon 10/19 at 8am PT, or later that day around 5:30pm" offers both), and a zone stated once in a sentence holds for every time in it. A time in a clause that says it is taken ("I'm in class Monday at 10 but free Tuesday at 2", "Tuesday at 2pm doesn't work, could we do Wednesday at 3pm?") is not offered; clauses split at sentence ends, commas, contrasts ("but", "how about") and "so"; when a day and its time sit in different clauses each is judged in its own, so "I'm out Monday, Tuesday at 2 works" offers only Tuesday; "I'm out" or "I'm off" before a day takes it away (only an adverb may stand between, as in "I'm also out Monday", so "I'm based out of SF" and "I'm working out of our Boston office Tuesday" say where they are and keep the time), as does "I teach a class Monday at 6"; conditional or idiomatic negations ("if not", "no problem", "not sure") and negative questions that suggest a time ("Why don't we do Tuesday at 2pm?", "Can't we just do Tuesday at 2pm?", and a bare "Isn't Tuesday at 2 better?" only when its clause ends in a question mark) do not count, while a terse "Can't Monday at 2, sorry" still takes Monday away. Times resolve with Intl in the zone stated next to them, else a zone stated for the whole message ("all times Eastern", "I'm on Pacific time"), else the student's `user.timezone`; a stated zone is returned on the result as `timeZone`. Times already past at the message date are dropped.

---

## 6. Stage inference (deterministic state machine)

Implemented in `packages/core/src/pipeline/transitions.ts` and mirrored in `apply_stage_transition()`.

| From | Event | To | Confidence |
|---|---|---|---|
| `identified` | outbound `outreach` sent | `outreach_sent` | 1.0 |
| `identified|warming` | inbound message from P (thread detected after the fact, or P answering an email introduction first), including one that proposes or confirms a time; the confirm card then reads the time | `replied` | T4 confidence |
| `outreach_sent` | inbound `reply_positive|reply_neutral|question|referral_offer|intro_offer` | `replied` | T4 |
| `outreach_sent|replied|scheduling|scheduled|nurturing` | inbound `reply_decline` | `declined` | T4 but always `proposed` (needs confirmation) |
| `outreach_sent|replied|scheduling` | inbound `scheduling_proposal` or outbound `schedule` | `scheduling` | T4 / 1.0 |
| any active except `completed..nurturing` | calendar event created with P, future | `scheduled` | event confidence |
| `scheduled` | event end + 15 min, not cancelled | `completed` | 0.95 (0.7 if the event's coffee-chat confidence was < 0.9 → proposed) |
| `scheduling|replied|outreach_sent` | note ingested matched to P | `completed` | note match confidence |
| `scheduled` | event cancelled | `scheduling` | 1.0 |
| `completed` | any outbound sent after the meeting (any source, any wording; it is the thank-you) | `followed_up` | 1.0 |
| `followed_up` | 14 days elapsed | `nurturing` | 1.0 |
| `completed` | 14 days since the meeting with no thank-you on record | `nurturing` | 1.0 |
| `outreach_sent` | no human inbound since the last outbound (or since an out-of-office person's return) and either `bump_count ≥ max_bumps` with 10 business days since it, or 15 business days since it (holidays and the winter freeze excluded) with any bump count | `no_response` | 1.0 |
| `nurturing|no_response|declined` | user starts new outreach | `outreach_sent` (new chat row) | 1.0 |
| any | user drag/select | target | 1.0 (actor user) |

`out_of_office` never transitions and never counts as a reply (it does not set `lastInboundAt`, so the bump and the reply rate are unaffected). The return date it names ("back on Monday, October 12", "out until 10/12", "back in the office on the 12th", the end of a range such as "out from Oct 5 to Oct 12" or "Oct 5-Oct 12", which means back the day after, or a month edge such as "until the end of the month" or "back at the start of next month", which means back on the first of the next month; month and weekday names count only as whole words, so "month" is never Monday) is stored on the chat (`outOfOfficeUntil`), and the return date plus two business days becomes `bumpNotBefore` (five business days after the reply when it names no date); the bump waits until both have passed. `reschedule` from `scheduled` → `scheduling`. Illegal transitions are rejected and logged.

A chat enters a stage when its evidence happened, not when Orbit read it: `stageEnteredAt` (and `completedAt`, `followedUpAt`) take the message's `sentAt`, the event's end, the note's time, or the invite's creation time (`created` from Google Calendar, else the last message in the thread), capped at now. `stageEnteredAt` is also never before the previous stage change, so days in stage never run backwards when a later sync reads older evidence (an invite created before the reply was read, or an older message after a manual move); `completedAt` and `followedUpAt` keep the evidence time, because they say when the chat and the thank-you really happened and the thank-you card's wording depends on it. A first sync of months of history therefore shows real days in stage, and a chat that ended yesterday says so on its thank-you card. An outbound the student sends from their own mail into a silent `outreach_sent` thread counts as a bump. When a chat changes stage, its older `proposed` events are rejected as superseded and cards that no longer fit the new stage are retired.

---

## 7. Drafting system (T8)

What a good message says is specified in 15 (outreach playbook): word limits and required moves per kind, connection first, sector register, subject lines, cadence, and the banned phrases the validator rejects. 15 amends this section; where the table below and 15 disagree, 15 wins, and the static build's templates and validator (`packages/core/src/drafts`) follow 15.

### 7.1 Message kinds and constraints

| Kind | Max words | Must include | Channel notes |
|---|---|---|---|
| `outreach` | 120 | connection line, context line, one ask with 2 windows or link, sign-off | LinkedIn invites ≤ 300 chars (`body_short` field) |
| `bump` | 60 | reference to the first note, one new hook or lowered ask, no apology | |
| `schedule` | 80 | 2 concrete windows or the link, timezone | reply in thread |
| `thank_you` | 100 | 2 specifics from the chat, one follow-through, gratitude without flattery | reply in thread, within 24 h |
| `nurture` | 90 | a genuine update about the student or a reaction to the person's news, no ask | |
| `congratulate` | 50 | the change (new role/company), no ask | |
| `referral_ask` | 110 | the specific role/link, why fit (1 fact), easy out | only after a completed chat or strength ≥ 0.5 |
| `intro_request` | 110 | who, why them, what the student will do with the intro, forwardable blurb | sent to the connector, not the target |
| `reply` | 120 | answers every `asks_of_user` | reply in thread |

### 7.2 Context pack (assembled in code, `packages/ai/src/tasks/draft_message/context.ts`)

```ts
{
  user: { firstName, school, gradYear, degree, majors, cycleLabel, targetFunctions, oneLiner? /* only when school or graduation year is missing: the kept summary facet of the current resume as a short 'a/an ...' clause, cut at its first comma, with no contact details */, credibility? /* one resume line that opens with a past-tense verb */, schedulingLink?, timezone },
  // the "who I am" clause is composed from year, short school name and major; the raw resume summary is never spliced in
  styleCard, exemplars: [3 outbound emails of the same kind if available, else closest],
  person: { name, firstName, title, org, location, school, relationshipType, isAlumni, strength, affiliations: [...last 3] },
  facts: PersonFact[] /* type, text, occurred_at, source */ (max 15, newest first, ranked by relevance to kind),
  thread: last 4 messages (stripped) when replying,
  chat: { stage, lastOutboundAt, lastInboundAt, bumpCount, scheduledEvent? },
  kind, channel, proposedWindows?: [...] /* real free slots, see 15 §9 */, busy?: [...] /* to check a time they proposed */,
  target?: { name, title, org, why } /* intro_request */, newAffiliation? /* a current role started in the last 120 days */,
  update?, news?, answer? /* what the student typed into the needs-input prompt */,
  suggestionReason,
  constraints: { maxWords, mustInclude[], mustNotInclude[] }
}
```
Only these fields are in the prompt. The prompt instructs: use only facts listed; if a needed fact is missing, leave it out rather than inventing; output the `claims` list.

### 7.3 Output and validation

```ts
DraftMessage = z.object({
  subject: z.string().max(90).nullable(),
  body: z.string(),
  body_short: z.string().max(300).nullable(),    // LinkedIn invite note when channel = linkedin and kind = outreach
  claims: z.array(z.object({ text: z.string(), fact_id: z.string().nullable(), kind: z.enum(['about_person','about_user','shared','logistics']) })),
  tone_check: z.object({ formality: z.number().min(0).max(1), matches_style_card: z.boolean() }),
})
```
Validator (`packages/ai/src/tasks/draft_message/validate.ts`), all must pass or the draft is regenerated once with the failures appended, then marked `needs_review` and excluded from the brief:

- every `about_person` or `shared` claim has a `fact_id` that exists in the pack (hallucination gate);
- the body names no person, company, school, post, event, mutual connection or figure (GPA, percentage, large number) that is not in the context pack or the template draft, even when the model returns no claims (`unsupported_detail`; the template itself is held to the same check in tests);
- word count ≤ max; no banned phrases (`I hope this email finds you well`, `reach out`, `pick your brain`, `leverage`, `synergy`, `as an AI`); no URLs other than the scheduling link, the user's LinkedIn or a URL present in facts; no email addresses other than the recipient's;
- for `bump`: contains a reference to the prior message date or topic; for `schedule`: contains the windows or the link; for `reply`: every ask in `asks_of_user` is addressed (checked by a second cheap call `reply_coverage` only when `asks_of_user` is non-empty);
- the recipient's first name appears exactly as stored (no nickname inventing);
- the student's sign-off matches the style card's sign-off set.

### 7.4 Style card (T12)

```ts
StyleCard = z.object({
  greeting_patterns: z.array(z.string()),      // "Hi {first}," "Hey {first}!"
  signoffs: z.array(z.string()),               // "Best,\nAnish"
  formality: z.number(),                       // 0 casual .. 1 formal
  avg_sentence_words: z.number(), avg_message_words: z.number(),
  contractions: z.boolean(), exclamations_per_message: z.number(), emoji: z.boolean(),
  characteristic_phrases: z.array(z.string()).max(8),
  avoid: z.array(z.string()).max(8),           // learned from edits: phrases the user deletes
  notes: z.string().max(400),
})
```
Built from the 40 most recent human-addressed sent emails under 300 words (excluding replies that are only "Thanks!"), plus edit pairs. Refreshed weekly and after every 10 edits; the user can view and pin phrases in Settings.

---

## 8. Recommendation and ranking (Discover and `new_outreach` suggestions)

### 8.1 Candidate generation (weekly, plus on demand)

1. **Own network**: people with `is_human`, no active chat, not hidden, not `declined` in the last 180 days, and (current org ∈ target companies ∪ orgs in target industries, or title matches target functions, or `is_alumni` and function-adjacent).
2. **Adjacent**: for each strong tie (strength ≥ 0.5), their former colleagues in the network (edges `co_tenure`) at target companies.
3. **Enrichment search** (PDL Person Search; budgeted at 25 profiles/user/week [DEFAULT]): `school = user's school AND (current company ∈ top 5 target companies OR title ∈ target functions)`, preferring graduation years within 2–8 years of the user (recent alumni respond most). Results become `recommendations.candidate` rows (not people) until the student acts.

### 8.2 Features and score

```
fit        = 0.35·company_match + 0.25·function_match + 0.15·industry_match + 0.25·cos(resume_embedding, candidate_profile_embedding)
reach      = best path strength (06 §5) for network/adjacent; for enrichment candidates: 0.6 if alumni, +0.2 if a strong tie co-tenured with them, else 0.25
response_prior = logistic(0.8·is_alumni + 0.5·same_major + 0.4·(years_since_grad ≤ 6) + 0.3·(title is IC or manager, not exec) − 0.6·(title ∈ {CEO, Partner, MD}) + 0.3·recent_interaction)
novelty    = 1 − max_similarity_to_recent_recommendations (embedding) ; penalises near-duplicates
score      = fit^0.5 · reach^0.3 · response_prior^0.2 · (0.5 + 0.5·novelty)
```
Diversity: no more than 3 candidates per company and 5 per function in a weekly batch of 10; at least 3 alumni if available. Reasons are generated as codes by code (`alumni_same_major`, `target_company`, `worked_with:<personId>`) and rendered to text by T14 (two sentences, cites only provided facts).

### 8.3 Learning loop (Phase 7)

Log for every shown recommendation: features, position, outcome (`saved`, `converted`, `dismissed:<reason>`, reply within 10 days, chat completed). Fit a logistic ranker on `converted ∧ replied` vs `dismissed` once ≥ 2,000 labelled rows exist across users; serve it as new weights for the formula above (same feature names) so the explanation path does not change.

---

## 9. Note extraction and memory (T6)

```ts
NoteExtraction = z.object({
  participants: z.array(z.object({ name: z.string(), email: z.string().nullable(), role: z.enum(['user','counterpart','other']) })),
  summary: z.string().max(900),
  facts: z.array(z.object({ about: z.string() /* participant name */, type: fact_type_enum, text: z.string().max(220), quote: z.string().max(200).nullable(), confidence: z.number() })),
  action_items: z.array(z.object({ owner: z.enum(['user','counterpart']), text: z.string().max(160), due_hint: z.string().nullable() })),
  offers: z.array(z.string().max(160)),        // what the counterpart offered (referral, intro, review resume)
  hooks: z.array(z.string().max(160)),         // things to reference later ("their team is hiring in Jan", "marathon in April")
  warmth: z.enum(['warm','neutral','cool']),
  suggested_next_step: z.string().max(160),
})
```
Rules: facts about the counterpart become `person_facts` (source `meeting_notes`) on the person named in `about` (in a note with several attendees each fact goes to the person it is about); fact `text` is a short third-person sentence about that person with an explicit subject, the way the student would write it ("Priya leads a small team on payments onboarding", "She recommended I apply by the early deadline in October", "They offered to put in a good word"): a transcript speaker's own first person becomes "They", a subjectless dictated fragment gets the note's pronoun for that person (or "They"), a third party stays a third party, every offer reads "<subject> offered to …", and there are no speaker labels or header lines. The drafting engine turns this form into a clause addressed to the person ("you offered to put in a good word") and the Person page, summary and talking points show it as written. The source sentence is stored as `evidence`; `offers` become facts of type `offer`; `action_items` with owner `user` become `action_items` (due parsed from `due_hint` relative to the note date in the student's time zone: weekdays, tomorrow/tonight, `in N days/weeks`, `Oct 20`, `in October` = end of that month, end of week/month; 5 pm; undated promises 7 days); counterpart action items become facts of type `offer`.

Heuristic path (no API key, `packages/core/src/notes/extract.ts`): title, attendee/date lines and section headings are dropped; a Summary section wins over a Transcript; speaker labels (`Priya Patel:`, `[00:01:12] Maya Wu:`, `Me:`/`Them:`) are stripped and remembered, the student's own lines only yield action items, and the counterpart's first person is turned into the student's frame ("I can refer you" → "you can refer me"). The student's promises ("I'll send my resume by Friday") are action items, never offers; advice reported as "she recommended I apply …" is advice, and becomes an action item only with an explicit deadline. Unpunctuated dictation is segmented at discourse markers (um, also, so, but, "and she …", a new name or pronoun) and fillers are removed. Dictated text written in lower case is recased: the attendees' names, months and weekdays ("may" only after a month cue like "in", "by", "end of" or before a date; after "this", "next" or "last" only when no verb follows, so "this may take a few weeks" keeps the modal), a list of well-known places, countries and languages ("houston" → "Houston"; words that are also everyday words, like Mobile or Nice, are left alone), and the attendees' employers where they read as one: after "at", "from", "joined" or "left", after "to", "for" or "with" only following a job word ("works for ramp", "moved to stripe", "interning with bain"), after "of" only following a title ("head of ramp"), and never when a particle or object follows ("ramp up", "target the fall", "square one"), so a firm named after an everyday word does not recase "my target role", "to ramp up" or "back to square one". The attribution for a sentence is its speaker, else the first attendee named in it, else (for he/she) the attendee that pronoun last referred to, else the previous subject. The note summary is the first three cleaned sentences, cut at a word boundary. Dedupe: a new fact whose embedding cosine ≥ 0.92 with an existing non-deleted fact of the same type for the same person supersedes it (`superseded_by`) if newer, else is dropped. Personal facts (type `personal`) are limited to what the person volunteered in a professional context; the prompt forbids inferring protected characteristics, health, politics or religion.

Matching the note to people (code, `apps/web/src/engine/notes.ts`): attendee emails → identities; else names in `participants` → entity resolution against the user's people; calendar event within ±3 h with matching attendees; `calendar_event_id` when present; else names in the text: a full name ("Maya Wu") one person has, or a capitalised first name alone ("call with Maya") that exactly one tracked person has (first names that are everyday words or months, like Will or May, only count in full). Confidence rules: email match 0.98; event match 0.9; a single full-name match 0.8 (matched, titled "Chat with <name>"). A first-name-only match or a note naming several people is attached with confidence 0.7 and stays `unmatched`; a first name, or a full name, several people share attaches nobody (the card tells same-named people apart by company: "It could be Tom Wu at Bain & Company or Tom Wu at Google"). An `unmatched` note is extracted but writes nothing else until the student confirms it: no facts, action items or touchpoints, no chat stage change or completion date, no notification, no suggestions. Every note that is not matched for sure raises its `confirm_note_match` card as soon as it is saved ("Was your note from Fri, Oct 2 with Maya Wu?", or "Who was your note from Fri, Oct 2 with? It could be Maya Wu or Maya Chen."), is titled "Note from <weekday, date>", and the capture page opens on it so the student can pick the person right away, with the people it mentions listed first. Confirming the guess processes the note for that person. Picking someone else for a note that was matched automatically removes what it wrote for the first person (facts, action items, touchpoints, the "Notes are in" notification), puts their chat back in the stage it was in before the note (clearing the completion date the note set and expiring the thank-you, referral and report-back suggestions that depended on it), and redrafts any untouched draft for them that quoted a fact from the note (a draft the student already edited is cancelled and its card retired instead), then processes the note for the chosen person.

---

## 10. Person summary (T7) and prep brief (T10)

`PersonSummary = { summary: string(≤ 600), talking_points: string[](3..5), cites: fact_id[] }`. Regenerated at most hourly per person; cached in `people.summary`.

`PrepBrief = { who: string, why_this_chat_matters: string, what_you_discussed_before: string[], their_recent_changes: string[], questions: string[](5..7), things_to_avoid: string[], follow_through_from_last_time: string[] }`, stored in `suggestions.payload` for the `prep_brief` card and rendered at `/people/[id]/prep`.

Static build (`apps/web/src/engine/prep.ts`). Without an API key the summary is a template written the way a student would write their own notes: "{first} works at {org} as a {title}", the shared school if any, the last real interaction with its kind and a human date in the user's timezone ("You last met on Aug 13", "You last wrote to Jose in Feb 2023"), the number of touches only when it is 2 or more in the last 90 days, and advice/offer facts quoted as whole sentences. Talking points come only from stored facts; there is no generic filler. The Prep tab (`/people/:id?tab=prep`) is built by `buildPrep`: the student's goal for the chat and one ask (a pointer to one more person for a first chat; an application flag after a prior chat, whose goal mentions their advice only when an advice fact is on record; logistics only for recruiters; a first-chat goal names the student's target function at the company only when the person's own field or the company shows it is there, so banking is named at a bank but not at a venture, buyout or trading firm, and research only for someone whose title is research), the calendar slot in the user's timezone with the join link, a research checklist with deep links (their LinkedIn activity, company news, the team page), the student's 30-second intro built only from profile, goals and resume facets (it asks for the resume, or for the roles they are recruiting for, instead of inventing a line or saying placeholder text), five questions from a bank chosen by the person's function (software, product, design, data, banking, consulting, venture, general; a banking or consulting title only counts at a firm in that sector, so an Engagement Manager at a fintech gets the general bank, and anyone at a venture firm gets the venture bank), seniority and recruiter status, and the fixed closing question "Is there anyone else you'd suggest I talk to?". The student ticks the questions they want to lead with; the picks are stored on the chat (`CoffeeChat.prepQuestions`).

---

## 11. Embeddings (Voyage `voyage-4`, 1024-d, cosine)

| Kind | Text template | When | Used by |
|---|---|---|---|
| `resume_facet` | `"{kind}: {title} at {org} ({dates}). {text}"` | on parse/confirm | fit score, note dedupe seed |
| `person_profile` | `"{headline}. {title} at {org}. Past: {last 3 affiliations}. School: {school}."` | on create/enrich | fit, novelty, merge blocking (ANN top-10) |
| `candidate_profile` | same as person_profile | on search result | fit, novelty |
| `org_profile` | `"{name}: {industry}. {description}"` | on classify | industry match fallback |
| `fact` | the fact text | on insert | dedupe/supersession |
| `goal` | structured goals as one paragraph | on save | candidate search expansion (nearest orgs/titles) |
| `note_chunk` | 800-token chunks of transcripts | on ingest (only if transcript > 4k tokens) | prep brief retrieval ("what did we discuss about X") |

Batch embedding via Voyage's batch endpoint in groups of 128 texts; `text_hash` prevents re-embedding unchanged text.

---

## 12. Cost model (per active user per month, Opus 5.5 prices, 70 percent cache hit on system blocks)

| Item | Volume | Cost |
|---|---|---|
| Backfill triage T3 (one-time) | 20k messages → ~7k threads after prefilter → ~3k threads needing LLM (first 2 messages, 1.2k tokens each), batch | ≈ 3.6M input tokens × $2 (batch) + 0.3M output × $10 = **$10 one-time**, $3 with cache |
| Incremental T3/T4 | 25 human messages/day × 1.5k tokens | 1.1M in, 0.1M out → **$3.3** ($1.5 with cache) |
| Drafts T8 | 6/day × 6k tokens in (mostly cached per-user block), 400 out | 1.1M in (≈ 0.3M uncached) + 72k out → **$2.5** |
| Notes T6 | 6 notes × 12k tokens | 72k in, 12k out → **$0.5** |
| Summaries, prep, brief T7/T9/T10 | ~60 calls × 4k | 240k in, 40k out → **$1.8** |
| Embeddings | 300k tokens | **$0.02** |
| Enrichment | 60 profiles × $0.25 | **$15** (capped; falls with Coresignal at volume) |
| **Total** | | **≈ $8 LLM + $15 enrichment** per active month; first month +$10 |

Levers, in order, once measured on real traffic (`11` section 6): raise cache TTLs and batch more; lower effort per task; route T3/T5/T13 to `claude-haiku-4-5` behind a per-task config (expected to cut LLM cost by 40 percent; only after the eval shows no drop below thresholds); reduce enrichment by enriching only on demand.

---

## 13. Guardrails

- **Prompt injection**: untrusted wrappers (section 3); extraction tasks cannot produce actions; drafts are built from facts, not raw emails (except the last 4 messages for replies, wrapped); the validator rejects drafts containing instructions-like text ("ignore previous", "as an AI") or unexpected URLs.
- **PII minimisation**: prompts receive only the fields in the context pack; the user's email bodies are never sent to enrichment providers; enrichment payloads are never sent to the LLM in full (only normalised affiliations).
- **Refusals**: a refusal on a classification marks the item `needs_review`; a refusal on a draft removes the suggestion for that day and logs it; repeated refusals for one person (≥ 3) flag the person for manual review.
- **No autonomous actions**: `runTask` cannot call tools; the only tools in the system are deterministic code paths behind the approval gate.
- **Fairness**: ranking features exclude name-derived or photo-derived signals; `response_prior` uses only role, school, major, recency.
- **Content limits**: the model never writes about the person's protected characteristics; `personal` facts are reviewable and deletable; deleted facts are blocked from regeneration (`person_facts.deleted_at` kept as a tombstone keyed by source).

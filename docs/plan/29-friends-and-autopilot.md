# 29. Friends and autopilot: pooled networks, and outreach that runs itself

Status: plan, 2026-10-31. Builds on 16 (§4 warm paths, §8 replies, §11 data), 21 (hop strength), 23 (§4.9 the trust ladder, §4.6 replies, the weekly review), 25 (one inbox), 27 (reply warmth), 28 (the bench). Amends 10 §1 and §3 (what may be shared between users) and 16 §8.3 (autonomy levels). Precedence per README: 16 wins on names and architecture; this plan adds, it does not rename.

Two things the student asked for, in one plan because they share a spine: **Friends** (two Orbit users pool their networks, so each can reach the other's contacts through a warm, consented introduction) and **Autopilot** (Orbit finds who to write to, writes in the student's voice, sends inside the rules, answers the replies, funnels a yes into a booked call, and learns from every edit). The Friends tab makes autopilot's routes warmer; autopilot makes a friend's introduction happen without either student typing. The bar for both is plan 28's: every scenario judged as a sharp friend would, iterated until the judge, the screen and a real account agree it is flawless.

---

## 0. What exists today (facts the plan builds on)

| Area | Where | What it gives us |
|---|---|---|
| Per-user graph | `packages/core/src/graph/{edges,ties,paths,route,introWeb}.ts`; `apps/web/src/engine/graph.ts` (`buildReachGraph` :172, `reachPerson` :367, `reachCompany` :836) | tie score 0 to 100 (`scoring/tieScore.ts`, `tie-v2`, 16 features), pair ties keyed `a|b` (`ties.ts:232 inferTies`, `:831 mergeTies` noisy-OR), Yen's k-shortest paths (`paths.ts:190`), `rankWarmPaths` (`route.ts:516`: P = p_ask · Π p_know · r_T · 0.85^(hops−2)), every route starts at the single node `'user'` (`route.ts:26`) |
| External first hops | `graph/route.ts:133 ExternalCandidate` (`linkedin_mutual`, `village_path`), `engine/externalRoutes.ts`, `engine/warmIntros.ts` (Village, opt in), `engine/linkedinLive.ts:737 mutualsFor` (Unipile `connections_of`, plan 21) | the pattern a friend's contact slots into: a candidate hop with its own p and kind, ranked with the rest |
| Server paths | `supabase/functions/orbit-api/routes/paths.ts` (`/paths/find`, `/intros/ask`, `/pairs/*`), `_shared/paths/find.ts` (`loadGraph` :60 filters `user_id`, `findPaths` :294), `_shared/paths/externalCandidates.ts` (mutuals and Village stored as `orbit.ties` of the asking user) | the one place to add a friend layer |
| Identity | `orbit.people` is per user (`user_id not null`; the same human is a separate row under each student); `orbit.person_identities` (email, linkedin_member, linkedin_slug, phone, unipile_attendee; unique per user); `entity/resolve.ts` (`AUTO_MERGE_THRESHOLD 0.92`, `SUGGEST_THRESHOLD 0.6`) resolves only within one user | the join key between two users' graphs is an identity value, never a person id |
| Accounts | `orbit.users` (google_sub, email unique lower, school, school_domain, grad_year, timezone, autonomy_level, settings jsonb); `orbit.sessions`; service role only, RLS on with no policies, tenancy enforced by `user_id = ctx.userId` in every query (16 §11.3) | a second user's rows are reachable only by a query that deliberately crosses tenants: there must be exactly one such path, guarded by a consent check |
| Sync | `engine/serverSync.ts` (`PULL_TARGETS` :47, 20 tables; `pushOutbox` :765), `orbit-api/sync.ts` | friend projections must not ride the sync: they are read on demand, never written to the student's `people` |
| Local mode | `isAccountMode()` (`integrations/orbitApi.ts:285`); plans 14 and 24 promise local data never leaves the browser | Friends is an account feature; local mode gets the tab with the reason and the sign-in |
| Privacy | plan 10 §1 (another user reads my data: tenant scoping), §2 Google Limited Use (Gmail and Calendar data only for that user's own features), §3 (enrichment about a contact shown only to the user who has them); 16 §14.3 (restricted scope, CASA) | what a friend may see is the existence and strength of a relationship from non-Google signals, never content, never contact details, never Google-derived closeness |
| Autonomy | `orbit.users.autonomy_level` 0 to 2 (16 §8.3 table); level-2 rules `core/safety/rules.ts:281-345` (Gmail only, two-way thread, class scheduling or thanks or after out-of-office, score ≥ 40, no new commitment, validator, ≤ 5 a day, not 21:00 to 7:00 recipient time); `set_autonomy`, `pause_outreach`, `list_due` chat tools | the hard floor every autopilot send must clear |
| Trust ladder | `apps/web/src/engine/trust.ts` (plan 23 §4.9: `LADDER_KINDS` bump, thank_you, schedule; `OFFER_AT 10`; `RECHECK_EDITS 2` in 30 days; `AUTO_UNDO_MS 60_000`; `approvalStreaks`, `raiseTrustCards`, `answerTrustOffer`, `setAutoKind`, `maybeAutoSend`); `settings.autoKinds` | the earned-permission mechanism autopilot extends, never bypasses |
| Scheduled sends | `apps/web/src/engine/autopilot.ts` (`planSchedule`, `scheduleSends`, `cancelScheduled`; `autopilotTime.ts` weekdays 9 to 17, spread, `AUTOPILOT_DEFAULT_PER_DAY`), `core/compose/window.ts` (`nextSendWindow`: Tue to Thu, 8:00 to 10:30 recipient time, no US holidays, jitter) | a batch approved once goes out over days; the outbox re-checks each message at its time |
| Sending and feedback | `engine/send.ts` (`approveAndSend`, `checkSendAllowed`, `googleSendActive`, 10 s `UNDO_WINDOW_MS`; `FeedbackEvent` rows with edit distance :1093-1105), LinkedIn handoff (never auto) | the audit and the learning signal |
| Replies | `core/email/replyClass.ts` (`ReplySignal`), `email/triage.ts`, 16 §8.3 classes (interested, scheduling, question, objection, referral, not_now, out_of_office, decline, unsubscribe, thanks, other), `list_replies`, `draft_reply`, `book_call`, plan 18 automatic stages, plan 27 warmth | the classifier and the next action per class exist in parts; the funnel to a call is specified, not run end to end |
| Voice | `core/style/card.ts` (`StyleCard`: greeting, sign-off, sentence length, contractions, exclamations, emoji, characteristic phrases, avoid list, notes), plan 24 own words (`story`, `aim`, `proudOf`, `neverDo`), `messages.embedding` exemplars (16 §7.3), `llmDraft` (`integrations/anthropic.ts:706`) with rules 1 to 14, `validateDraft`/`validateComposed`, `neverDoChecks` | what a draft sounds like today; the learning from edits is recorded (`FeedbackEvent`) but nothing reads it back into the voice |
| Bench | plan 28: sim harness, judge, shape check, `scripts/chat-baseline.sh`, `chat-live.spec.ts`, fake orbit-api (`src/test/fakeOrbitApi.ts`) | where every scenario here is scored |

Gaps the map found and this plan closes: no friends, invites, consent or revocation model anywhere; no global person and no link between two Orbit users; paths cannot cross users; `FeedbackEvent` edits are written and never read; autonomy is a hidden number set by a chat tool, not a mode the product offers; replies are classified but only scheduling and thanks can finish themselves; nothing runs while the app is closed except what the server worker already ingests.

---

## Part A. Friends: two networks, one warm path

### A1. What the student sees

**The tab.** A fifth item in the rail, Friends (`/friends`), between People and Drafts on the laptop, inside More on the phone. Four stacked sections:

1. **Your friends.** One row per friend: avatar, name, school and year, "shares 312 people · 14 at your targets · knows 3 at Stripe", a switch for what you share back, and "Ask for an intro". An empty state: "Friends pool their networks. You see who they know and how well, they see yours, and intros happen in one tap. Nothing else crosses: not your messages, notes or contact details."
2. **Invite a friend.** An email box and a link to copy. An invite to someone already on Orbit becomes a request they accept; to someone not on Orbit it is a sign-in link that lands them in onboarding with the request waiting. Pending requests sit here with Accept, Decline and a preview: "Accepting shares your people the same way. Change it any time."
3. **Asks.** Two short lists: intros friends have asked of you ("Noah wants to meet Dan Lee at Stripe. Forward his note?" with Forward, Not this one, and the note itself) and intros you have asked ("Ana · Dan Lee · forwarded Tuesday"). An ask a friend forwards becomes a `warm_first_touch` in the asker's Drafts with the friend as the introducer (`via`), the way an introduction observed in email does today (16 §4, `introduced_by`).
4. **What you share.** Three choices, per friend or for all: *Everyone I know* (default on accept), *Only at these companies* (a company picker), *Nothing yet*. Under it, "Hide a person from friends" (adds `private` to that person; hidden people already never show), and a preview button: "See exactly what Ana sees" renders the projection as Ana's Map would.

**Where friends show up elsewhere.** On the Map and in Reach, a friend's contact is a route "via Ana (friend): she knows Dan well", drawn like a Village path with a friend badge. On a company page, "Through friends: 3 people" with names and how well. In the chat, `find_routes` lists friend routes among the rest, ranked by the same P, and `ask_for_intro` with a friend route drafts the ask *to the friend* and files it in both students' Asks. Discover and Goal plans (23) count friend coverage: "4 of your 6 target companies have a path through a friend."

**What a friend never sees.** Your emails, notes, facts, drafts, stage names, scores, phone numbers, email addresses, home city, LinkedIn connection dates, Google-derived closeness, hidden or private people, people who asked not to be contacted, anyone you have not synced or imported yourself. They see name, title, company, LinkedIn slug (public), school, whether they are your alum, and a three-step closeness word (knows, knows well, close) built only from LinkedIn, manual labels and your own "we're close" answers.

### A2. Why it works this way (decisions)

1. **Account only.** Local mode keeps every promise plans 14 and 24 make: nothing leaves the browser. The tab in local mode is one paragraph plus the Google sign-in widget (`show_setup google`).
2. **Signal, not content**, the Connect The Dots rule: a friend learns that a relationship exists and roughly how strong, never why. Everything derived from Gmail or Calendar stays with its owner (plan 10 §2): the shared closeness is recomputed with the Google features zeroed (`tieScore` `email_*`, `meeting_coattendee`, `introduced_by` contributions dropped; `linkedin`, `student_says_close`, `manual`, `shared` kept). This keeps Limited Use and CASA untouched: no Google data leaves the user's own feature.
3. **Double consent, symmetric by default, independent in practice.** A friendship exists only when both accepted. Each side chooses what it shares; neither side's choice depends on the other's. Revoking is instant: the projection rows are deleted in the same transaction and the other side's cached routes expire within an hour (the `paths` cache, `engine/paths.ts:37`).
4. **Projections, not reads of the friend's tables.** A friend's visible people live in one table of their own, `orbit.friend_shares`, rebuilt by the owner's side whenever their people or ties change. Route finding reads only that table for friends. There is exactly one cross-tenant query in the codebase, and it goes through `orbit.friend_visible(viewer, owner)`.
5. **The friend is the connector, always.** An intro through a friend is never a direct message to the friend's contact: the student asks the friend, the friend forwards. So no contact detail ever needs to cross, and the etiquette the playbook teaches (double opt-in, a forwardable blurb, an out) is the only path. This is also why the feature is worth having: a warm intro converts at several times a cold note (16 §4, plan 15 §5).
6. **Join on identities, never on person ids.** The same human under two users is matched by `linkedin_member`, then `linkedin_slug`, then a hashed email, then name plus company at `NAME_ORG_ONLY_CAP` or above (`resolve.ts`). When the student already has the person, the friend route attaches to that person; when not, it is an external candidate (`friend_path`) that becomes a person only if the student saves them, the way `add_sourced` works.

### A3. Data (migration `20261101_orbit_friends.sql`)

```sql
create table orbit.friend_invites (
  id uuid primary key default gen_random_uuid(),
  from_user_id uuid not null references orbit.users(id) on delete cascade,
  to_email text,                      -- lower(email) of the invitee, or null for a link
  code text unique not null,          -- 22 chars base62, in the link
  status text not null check (status in ('pending','accepted','declined','expired','revoked')) default 'pending',
  created_at timestamptz not null default now(), expires_at timestamptz not null, answered_at timestamptz
);
create table orbit.friendships (
  id uuid primary key default gen_random_uuid(),
  a uuid not null references orbit.users(id) on delete cascade,
  b uuid not null references orbit.users(id) on delete cascade,
  status text not null check (status in ('pending','active','ended','blocked')),
  requested_by uuid not null,
  created_at timestamptz not null default now(), accepted_at timestamptz, ended_at timestamptz, ended_by uuid,
  check (a < b), unique (a, b)
);
-- what each side shares with the other; one row per direction
create table orbit.friend_share_settings (
  friendship_id uuid not null references orbit.friendships(id) on delete cascade,
  owner_user_id uuid not null references orbit.users(id) on delete cascade,
  mode text not null check (mode in ('all','companies','none')) default 'none',
  company_domains text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (friendship_id, owner_user_id)
);
-- the projection: what a friend may see of the owner's people, rebuilt by the owner side
create table orbit.friend_shares (
  owner_user_id uuid not null references orbit.users(id) on delete cascade,
  person_id uuid not null references orbit.people(id) on delete cascade,
  display_name text not null, title text, company text, company_domain text,
  linkedin_member_id text, linkedin_slug text, email_hash text,   -- join keys only; never the address
  school text, is_alumni boolean not null default false,
  closeness smallint not null check (closeness between 1 and 3),  -- 1 knows, 2 knows well, 3 close
  updated_at timestamptz not null default now(),
  primary key (owner_user_id, person_id)
);
alter table orbit.people add column if not exists private boolean not null default false;
-- an intro asked of a friend; the friend's answer makes the forward draft on their side
create table orbit.friend_intro_asks (
  id uuid primary key default gen_random_uuid(),
  friendship_id uuid not null references orbit.friendships(id) on delete cascade,
  asker_user_id uuid not null, friend_user_id uuid not null,
  target_person_id uuid not null,            -- the friend's people.id (the projection row)
  asker_person_id uuid,                      -- the asker's own row for the same human, when they have one
  note text not null,                        -- the forwardable blurb, the asker's words
  status text not null check (status in ('asked','forwarded','declined','expired')) default 'asked',
  created_at timestamptz not null default now(), answered_at timestamptz,
  forwarded_message_id uuid               -- the friend's outbound message, when sent
);
create or replace function orbit.friend_visible(viewer uuid, owner uuid) returns boolean language sql stable as $$
  select exists (
    select 1 from orbit.friendships f
    join orbit.friend_share_settings s on s.friendship_id = f.id and s.owner_user_id = owner
    where f.status = 'active' and ((f.a = viewer and f.b = owner) or (f.a = owner and f.b = viewer))
      and s.mode <> 'none'
  );
$$;
```

Rules the migration enforces: `friend_shares` rows for a person with `private`, `hidden_at`, `do_not_contact`, or no `linkedin_member`/`linkedin_slug`/`email_hash` are never written; the projection carries `closeness` from `orbit.tie_scores` recomputed without Google features (a `share_score` column added to `tie_scores` by the same migration, filled by the existing scorer with a feature mask); `orbit.delete_user` gains the four tables; `friend_intro_asks` expire after 14 days.

Browser (Dexie v9): `friends` (the list the tab shows, pulled, read only), `friendAsks` (both directions), `settings.friendShareMode`. Friend projections are **not** a Dexie table: route results that pass through a friend carry the few fields the Map needs and live in the paths cache only.

### A4. Server (orbit-api)

Routes (`routes/friends.ts`): `POST /friends/invite {email?}` → `{code, link}`; `POST /friends/accept {code | friendshipId, mode}`; `POST /friends/decline`; `POST /friends/end`; `GET /friends` → friends with counts (`shares`, `atTargets` against the viewer's target companies, `knowsAt` for a given company); `POST /friends/settings {friendshipId?, mode, companyDomains}`; `GET /friends/preview` → the viewer's own projection as a friend sees it; `GET /friends/shares/:friendUserId?company=` → the projection, paged; `POST /friends/asks {friendUserId, targetPersonId, note}`; `GET /friends/asks`; `POST /friends/asks/:id/respond {forward | decline, body?}`. Every handler checks `friend_visible` for reads and the friendship for writes. Rate limits: 20 invites a day, 10 asks a day per friendship.

Path finding (`_shared/paths/find.ts`): `loadGraph(userId)` gains `loadFriendLayer(userId)`: for each active friendship where the friend shares, the friend becomes a node `friend:<userId>` tied to `'user'` with p = 0.9 (a friend is asked, not a stranger), and each `friend_shares` row becomes an edge `friend → X` with p from `closeness` (1: 0.35, 2: 0.6, 3: 0.85, the `HOP_WEIGHTS` scale from `ties.ts:36`). X is joined to the student's own person by identity (A2.6) so an existing route and a friend route to the same human rank together; otherwise X is an `ExternalCandidate` of a new kind `friend_path` (`route.ts:133`). `PathsFindResponse.sources` gains `'friends'`; each path hop carries `via: { kind: 'friend', userId, name }`. `rankWarmPaths` needs no change: a friend hop is a hop.

Projection maintenance (`orbit-worker`): a job `friend_shares_refresh` runs for an owner when their people, identities or tie scores changed (the existing change queues) and nightly; it rewrites that owner's rows in one transaction. Ending a friendship or setting mode `none` deletes nothing from `friend_shares` (the rows are the owner's) but `friend_visible` turns false at once, and the viewer's path cache is invalidated by a `friends_changed` pull cursor bump.

The intro: `POST /friends/asks` stores the note; the friend's next pull lists it; `respond: forward` creates on the friend's side a `warm_first_touch`-style draft of kind `forward_intro` (new `MessageKind`, template from plan 15 §2.12's blurb) addressed to the target with the asker's note quoted, which the friend approves like any draft (never auto, never LinkedIn); on send, the ask becomes `forwarded` and the asker's side gets a `friend_forwarded` suggestion card ("Ana forwarded your note to Dan. When Dan replies, I'll draft the thank-you to Ana."). The asker never receives Dan's address; a reply from Dan reaches the asker because Ana's forward puts the asker in cc (the template says so: "cc'ing Noah so you two can take it from here").

### A5. Browser

- `pages/Friends.tsx` (new) with the four sections; `components/friends/{FriendRow,InviteBox,AskRow,ShareSettings,SharePreview}.tsx`; rail entry; phone More.
- `engine/friends.ts`: `listFriends`, `inviteFriend`, `acceptFriend`, `setShareMode`, `markPrivate`, `askFriendForIntro`, `respondToAsk`, all account-mode calls through `orbitApi`; local mode returns `needs_account`.
- Map and Reach: `reachPerson` and `reachCompany` merge `friend_path` candidates from the server response (`findPathsOnServer` already returns paths; the Map starts calling it for account users, which plan 17 §C wanted and never did). `RouteBadge` gains the friend variant; `ReachMutuals` lists friends' contacts under "Through friends".
- Chat: tools `list_friends`, `invite_friend` (risky: sends an email through Resend), `set_friend_sharing` (write), `ask_friend_for_intro` (risky: creates the ask the friend sees), `respond_to_friend_ask` (risky: creates the forward draft); capabilities `friend_list`, `friend_invite`, `friend_share`, `friend_ask`, `friend_respond`; `find_routes` and `ask_for_intro` learn the friend hop. The playbook gains a short `friends.md` section (how to ask a friend, the forwardable blurb, reporting back) and `etiquette.md` cites it.
- Fake orbit-api: `/friends/*` routes with two seeded fake users (Maya and Noah) so the e2e can run both sides in one browser (sign in as A, then B).

### A6. Privacy amendments (plan 10)

- §1 gains a row: "A friend sees more than I shared" → one cross-tenant read path (`friend_visible`), projections rebuilt only from allowed people, the preview shows exactly the projection, revocation is immediate.
- §2 gains: "Nothing derived from Gmail or Calendar is included in what a friend sees; the shared closeness is computed from LinkedIn, manual labels and the student's own answers only."
- §3 gains: "A contact's enrichment is never part of a projection; a friend sees the contact's name, title, company and public LinkedIn slug as the owner imported them."
- The privacy page (`/privacy`) and the in-app Privacy answer (PRIVACY_RULE in `system.ts`) gain two sentences.

### A7. Acceptance

Unit (core): `share_score` drops Google features (a person whose only ties are email threads shares as closeness 1 or not at all); identity join picks member id over slug over email hash over name+company; `rankWarmPaths` with a `friend_path` hop ranks a close friend's close contact above a weak direct tie. Server tests (`supabase/tests`): invite → accept → `friend_visible` true both ways; mode `none` → false; `private` person never projected; ending deletes visibility within the same transaction; `delete_user` cascades; a viewer cannot read a non-friend's shares (403). Browser: the tab in local mode shows the sign-in; the preview equals the projection row for row. e2e (fake api): A invites B by email, B accepts, A sees "shares N people", A finds a route to B's contact on the Map, asks, B sees the ask, forwards, A's Drafts shows the forwarded card; revoke and the route is gone. Sim (plan 28 group `friends`): "who do I know at Stripe" lists "through Ana"; "ask Ana to intro me to Dan" drafts the ask to Ana with a blurb, never a note to Dan; "what can Ana see of mine" is answered from the projection rules in plain words.

---

## Part B. Autopilot: outreach that runs itself, inside the rules

### B0. What the map found (the facts B is built on)

- **Two send systems that do not know each other.** The browser sends from Dexie `outbound` (`engine/send.ts:537 approveAndSend`, ticked by `components/OutboxScheduler.tsx` every second, Google token in memory) and the server sends from `orbit.drafts` (`_shared/sending/send.ts:211 sendDraft`, worker queue `orbit_send`, Gmail token in Vault, `gmail.send` scope already requested at `_shared/google.ts:25`). The browser never reads `autonomyLevel`; the server never sees `settings.autoKinds` or the trust ladder. With an account, `linkedInSendActive` returns false, so browser autopilot is in effect local-mode only, and only while a tab is open.
- **Levels are not what the table says.** Server `approveDraft` ignores level 0 vs 1 (any approval schedules a send); level 1's `preapproved_bumps` depends on `chat.preapprovedBumps`, which nothing sets; level 2 (`autonomyAllows`, `core/safety/rules.ts:317`) is reachable only by `scheduling` replies because `thanks` and `out_of_office` are not in `DRAFT_CLASSES` (`_shared/replies/replies.ts:86`).
- **Three rulebooks disagree.** Browser autopilot windows 9 to 17 local, weekdays (`autopilotTime.ts`); everything else Tue to Thu 8:00 to 10:30 recipient time (`core/compose/window.ts`). Caps: browser 15 Gmail and 10 LinkedIn a day (`send.ts:126`), server 30 and 25 (`sending/send.ts:33`), auto 5. Browser autopilot will schedule live LinkedIn sends after one approval, which 16 §8.3 forbids.
- **The voice never reaches the server.** Nothing writes `users.settings.style_card`; no ingest writes `messages.embedding`, so `exemplars()` (`_shared/compose/context.ts:219`) is always empty. Edits are kept only as local `feedback` rows with untyped before and after, consumed only by the ladder's streaks (`send.ts:1186`). Server drafts keep no original body and `variant` is always null.
- **Nothing learns from outcomes.** `drafts.replied_at` and `reply_class` are stored and unread; `introOutcomes` is an export with no fit; the weekly review describes and never adjusts.
- **The funnel stops at the slots.** `/calendar/slots` and `/calendar/book` exist (`_shared/slots/slots.ts:150, 201`; 30 minutes, 9:00 to 17:30, 15 minute buffer, 18 hour lead, 10 business days), but a confirmed slot never books itself, and a reply that needs a fact waits silently in Drafts (`[ASK USER]` → 409 `needs_input`).

### B1. What the student sees

**Settings → Autopilot.** One page, three modes, the guardrails printed under each in plain words, never hidden:

- **Off.** Orbit writes, you send. (Today's level 0.)
- **Assist.** You approve each message with one tap and it goes at the right time: the recipient's Tuesday to Thursday morning, spaced like a person. Bumps, thank-yous and scheduling replies go on their own once you have approved ten of a kind unchanged (the ladder, 23 §4.9), each shown after with a minute to undo. (Level 1, made real.)
- **Autopilot.** Everything in Assist, and: Orbit plans your week to your target, writes the first messages, shows them to you the evening before as *Tomorrow's batch*, and sends them in the morning unless you hold one. When someone replies, Orbit answers scheduling and thank-you replies itself, offers three times from your calendar when they say yes, books the call when they pick one, and asks you in chat only when a reply needs something only you know. (Level 2, finished.)

Under Autopilot, the rules as they stand, each a sentence: "Email only, never LinkedIn." "Only to alumni, people you know (closeness 40 or more) or a friend's contact." "At most 5 sends a day on its own, 12 first messages a week." "Only companies on your goals." "Stops and tells you at the first decline, unsubscribe or pushback." "Every message appears under Sent for you with a minute to undo, and in your morning brief." "Pause is one tap, here and in the chat." First messages are the last rung: until twenty first messages have gone out unchanged, the batch asks for a tap in the evening instead of sending in the morning (B2.2).

**Per goal.** A "Run on autopilot" switch on each goal (`goals.autonomy_level`), so a founder can run sales on autopilot and keep investor notes by hand.

**Drafts.** Three new sections: *Tomorrow's batch* (the first messages Orbit will send at 8:40 their time; Hold, Edit, Send now), *Needs you* (replies that asked a question, with "Dan asked whether you've applied yet. What should I say?" answered in one line in the chat), *Sent for you* (already exists for the ladder; now also replies and first messages, each with Undo for 60 s, then "Sent 8:41 am their time · replied?").

**Morning brief and weekly review.** "Autopilot: sent 3, answered 2 replies, booked 1 call, 2 need you." The weekly review (23) adds "On autopilot: 9 sent, 4 replies, 2 calls, 1 pushback (paused Stripe)".

**Settings → Voice.** The style card as prose ("You greet with Hi, sign off Thanks, write short, use contractions, no exclamation marks"), the own words from onboarding, and *What Orbit learned from your edits*: one line each ("You cut 'Thanks either way' every time", "You never open with the connection line twice"), each with Keep and Forget. A "Sounds like you" score on recent drafts, and "Relearn from my sent mail".

**Chat.** "put my recruiting on autopilot" → the mode explained in two sentences and a confirm; "what did you send today", "hold tomorrow's batch", "answer Dan: yes, applied Monday", "pause everything", "why didn't you send to Priya" (the hold reason), "what have you learned about how I write".

### B2. Decisions

1. **One send system, one rulebook.** The server is the sender for account users (the worker, the Vault token), the browser for local mode, and both run the same `core/safety/rules.ts`: `nextSendWindow` (recipient Tue to Thu morning; `autopilotTime.ts`'s 9 to 17 window is retired), one cap table (`SEND_CAPS` in core: Gmail 15 and LinkedIn 10 a day by hand, 5 auto a day, 12 auto first touches a week, 30 a day for sales goals as today), LinkedIn never auto anywhere (the browser's `schedule_sends` stops accepting LinkedIn drafts; they stay as taps). `settings.autoKinds` and the mode sync to `users.settings` and the server cadence reads them; `chat.preapprovedBumps` is deleted.
2. **Earned, then kept honest.** Modes can be chosen any time, but each kind of send is unlocked by the ladder: bumps, thank-yous and scheduling replies at ten unchanged approvals (today); first messages at twenty, and only ever with the evening review window (`review_until`, the next morning's send time minus eight hours; a hold is one tap, silence is consent only once earned). Two edits in thirty days to any auto kind re-asks (today's `RECHECK_EDITS`). A decline, an unsubscribe or an objection to an auto first message pauses first messages for that goal and raises a card: "Marcus pushed back. Paused Stripe first messages. Read it?"
3. **Replies finish themselves by class (16 §8.3 table, now complete).** `DRAFT_CLASSES` grows to every class with a next action; `AUTO_SEND_CLASSES` stays scheduling, thanks and out-of-office follow-ups. New: `interested` → draft the slots reply; at Autopilot, send it when the reply holds no question. `scheduling` with a time that matches an offered slot → book (`bookSlot`), send the confirmation, create the chat's event, raise the prep card (22); at Assist, the same with one tap. `question` → the *Needs you* card and a chat line; the student's one-line answer fills `answer` and the reply drafts itself (`[ASK USER]` becomes a structured `needs: ['answer']`). `objection`, `not_now`, `referral` → drafts for approval, never auto, with the playbook's register. `decline`, `unsubscribe` → close, `do_not_contact`, tell the student, no reply. `thanks` → auto at level 2 only when it carries no question. `other` → draft only on request.
4. **Voice in three loops.** (a) *Keep the card current and give it to the server*: `learnStyle` (`engine/style.ts:137`) runs after every ten sends and writes `users.settings.style_card` through `/settings/profile` (field added); the Gmail ingest writes `messages.embedding` for sent mail through the embedding adapter in `_shared/services.ts` (the one the memories use) so `exemplars()` returns the student's three closest sent messages of the same kind. (b) *Learn from edits*: every approval with an edit stores a typed `orbit.draft_edits` row (before, after, distance, kind, class) in both modes; a nightly job (`voice.distill`) sends the last thirty edits to Claude with the card and returns at most eight one-line rules in the student's words (`settings.voice_notes`, each with the edit ids as evidence), merged into `StyleCard.notes` and `avoid` for drafting; the student keeps or forgets each in Settings → Voice, and a forgotten note is never re-learned. (c) *Check before sending*: `voiceCheck(draft, exemplars, card, notes)` (core, no model: sentence length band, greeting and sign-off match, banned phrases, note violations, avoid list) plus, for auto first messages only, a Claude judge "written by the same person? 0 to 3" against the exemplars (16 §T12, calibrated once on 20 students' mail); below 2 the draft falls to approval with "didn't sound like you". The plan 28 sim-drafts rubric is the regression bench.
5. **Learn from outcomes, modestly.** `drafts.outcome` (replied, booked, declined, silent) is set by the classifier and the booking; the weekly review shows reply rate by kind and by opener style; `variant` is finally used: two subject or opener variants per template, chosen by a Thompson draw per student (the pattern already in cadence_b2c's campaign intelligence), reported, never silently switched more than once a month. Send windows learn the student's own replies-by-hour (the recipient's hour of reply shifts the window by at most an hour).
6. **Asking without a tab open.** *Needs you* items raise a notification (the browser's `notifications` table, which the demo and the brief already use) and, for account users, an email to the student's own address when the app has been closed for more than four hours ("Dan asked one thing. Reply in Orbit."), through the transactional mailer plan 10 §1 names (Resend); nothing in the code sends such mail yet, so the mailer adapter is part of phase 3. Nothing times out into a send: an unanswered question holds the thread, and the bump cadence pauses for it.
7. **Everything auditable, everything stoppable.** Every auto action writes `audit_log` (`draft.auto_approve`, `draft.auto_sent`, `reply.auto`, `call.booked`) and appears in the brief; "Pause autopilot" (chat and Settings) sets `settings.autopilot_paused_until` and the worker honours it inside a minute; `Stop everything` cancels queued sends and holds the batch. A circuit breaker: any unsubscribe, two declines in a day, a bounce, or a Gmail send error pauses that goal's auto sends and tells the student.

### B3. Data

Server (migration `20261101_orbit_autopilot.sql`): `users.settings` keys `autopilot_mode` ('off' | 'assist' | 'autopilot'), `auto_kinds text[]`, `style_card jsonb`, `voice_notes jsonb` ([{id, text, evidence: uuid[], keptAt, forgottenAt}]), `autopilot_paused_until`; `goals.autonomy_level` kept (2 = autopilot for that goal); `orbit.drafts` gains `review_until timestamptz`, `auto_rung text` (which rung sent it), `outcome text`, `variant` used; `orbit.draft_edits (id, user_id, draft_id, kind, reply_class, before, after, distance, created_at)`; `orbit.messages.embedding` filled for `direction = 'out'`; `orbit.audit_log` kinds above. Browser (Dexie v9): `outbound.reviewUntil`, `outbound.autoRung`, `settings.autopilotMode`, `settings.voiceNotes`, `draftEdits` (local mode's copy, pushed when an account exists). Core: `SEND_CAPS`, `AUTO_FIRST_TOUCH_RUNG = 20`, `REVIEW_WINDOW_HOURS = 8`, `VOICE_NOTES_MAX = 8`, the completed class table, `voiceCheck`.

### B4. Server pieces (orbit-api, orbit-worker)

- `cadence.user` (hourly) gains the plan step: at Autopilot, for each goal with `autonomy_level = 2`, it reads the week's remaining target (`weekPace`), the goal's plan steps that are due (`targetPlans` from 23), the people with a sourced hook and a route, composes first messages through `composeDraft` with the playbook rules 13 and 14, runs the validators and `voiceCheck`, and queues them with `review_until`; the evening before, the batch card.
- `send.draft` honours `review_until` (not before it), `autopilot_paused_until`, the goal's pause, the rung caps, and re-checks `cancelIfReplied` as today.
- `classify.message` → `maybeAutoReply` runs the full class table; `funnel.reply` (new handler) offers slots and books; `voice.distill` nightly; `voice.card` after ten sends; `outcomes.roll` nightly (sets `drafts.outcome`, reply-by-hour, the Thompson draw).
- Routes: `POST /autopilot/mode`, `GET /autopilot/status` (what is queued, held, sent today, paused, the rungs), `POST /autopilot/hold {draftId}`, `POST /autopilot/pause {until, goalId?}`, `POST /replies/answer {draftId, answer}`, `GET /voice`, `POST /voice/notes {id, keep|forget}`, `POST /voice/relearn`; `/settings/profile` accepts `style_card`.

### B5. Browser pieces

- `pages/settings/Autopilot.tsx` and `Voice.tsx`; `engine/autopilotMode.ts` (mode, status, hold, pause, one call each, local mode mapped onto the browser scheduler with the honest line "sends while Orbit is open; sign in for always-on"); Drafts sections `TomorrowBatch`, `NeedsYou`, extended `SentForYou`; the brief and review lines; `engine/voice.ts` (notes, relearn, the local `voiceCheck` before any browser auto-send); `autopilot.ts` rewritten on `nextSendWindow` and `SEND_CAPS`, LinkedIn drafts refused with the reason.
- Chat: tools `set_autopilot_mode` (risky; `set_autonomy` kept as an alias), `autopilot_status` (read), `hold_send` (write), `answer_reply` (write: fills the answer, drafts the reply), `pause_autopilot` (existing `pause_outreach` widened), `list_voice_notes` (read), `forget_voice_note` (write); capabilities for each; AUTONOMY_RULES in `system.ts` rewritten around the three modes and the rungs; the playbook's etiquette section cites the caps so the model quotes the student's real ones.

### B6. Safety (amends 16 §8.3)

An auto send of any kind needs all of: Gmail; validators and `voiceCheck` passed; the kind unlocked by the ladder; the cap not reached; the window; no reply since the draft; the person not hidden, private or `do_not_contact`; not between 21:00 and 7:00 recipient time; the goal and the account not paused; the student's own address verified (bounce-safe). An auto **first message** additionally: the first-message rung earned; the recipient alumni, closeness ≥ 40, or a friend's contact (A); a hook with a `sourceId`; a company on the goal's targets; not a recruiter, not anyone who looks under 18, not a faculty member outside a collaboration goal; the review window passed with no hold; at most 3 a day and 12 a week; never two people at one firm on the same day. An auto reply additionally: inside a two-way thread; no new commitment (no money, no dates beyond offered slots, no attachments, the scheduling link only); class scheduling, thanks, out-of-office follow-up or interested-without-a-question. Booking auto only when the confirmed time equals an offered slot and the calendar is still free. LinkedIn never, at any level, including invites.

### B7. Acceptance

Unit (core): the class table (every `ReplySignal` maps to a next action; the three auto classes and nothing else pass `autonomyAllows`), `SEND_CAPS` shared, `nextSendWindow` used by the browser planner, `voiceCheck` on the sim-drafts corpus (false positives under 5%), note merging into the card. Server tests: level 1 approve → queued at the window; level 2 scheduling reply with a matching slot → booked and confirmed, with an audit row; a question reply → `needs_input` card and no send; an unsubscribe → `do_not_contact`, drafts cancelled, breaker fired; `review_until` respected; a hold wins; `autopilot_paused_until` honoured within the tick; `draft_edits` written on an edited approval; `voice.distill` returns at most eight notes and never re-learns a forgotten one. Browser: the Autopilot page, the Voice page, Tomorrow's batch with Hold, Needs you answered from the chat, Sent for you with Undo. e2e (fake api): a week on autopilot in the demo: batch shown in the evening, sent next morning, a seeded reply of each class produces the right card or send, a confirmed slot books, the breaker pauses, Settings shows the rungs. Sim (plan 28 group `autopilot`): "put recruiting on autopilot" explains and confirms; "what did you send" lists from the status; "answer Dan: yes" drafts the reply with the answer and nothing invented; "pause everything" pauses and says so; "why didn't you send to Priya" names the rule. Real account (the founder's): one real reply answered by Orbit at Assist, one call booked from a confirmed slot, nothing sent that was not shown.

---

## Part C. Phases, the bench, and what flawless means

### C1. Order

0. **Bench first (one day).** Fake orbit-api gains `/friends/*`, `/autopilot/*`, `/replies/answer`, `/voice/*` and seeded replies of every class; two fake users; sim groups `friends` and `autopilot` (12 and 15 scenarios) in `scenarios.ts` with reference notes; e2e skeletons that fail. Baseline the sim groups on today's build.
1. **One send system (two days).** `SEND_CAPS`, `nextSendWindow` everywhere, LinkedIn never auto, ladder settings synced, level 1 real on the server, `review_until`, pause honoured, audit rows. Nothing new is sent yet; what is sent obeys one rulebook.
2. **Friends (four days).** Migration, routes, projection job, the friend layer in `findPaths`, the tab, the Map and chat hops, the ask and forward flow, privacy page, plan 10 amendments. e2e both sides.
3. **Replies finished (three days).** The class table, `funnel.reply`, booking from a confirmed slot, Needs you with the chat answer, the breaker, Sent for you for replies.
4. **Voice (three days).** Card to the server, sent-mail embeddings, `draft_edits`, `voice.distill`, Settings → Voice, `voiceCheck`, the judge for first messages, sim-drafts rerun.
5. **First messages on autopilot (three days).** The cadence plan step, Tomorrow's batch, the first-message rung, the Autopilot page and modes, the brief and review lines, the chat tools and prompt rules.
6. **Iterate (as long as it takes).** Run the plan 28 bench on groups `friends`, `autopilot`, `drafting`, `knowledge`; the live browser pass at 1280 and 390; the real-account pass with Assist on (one reply answered, one call booked, one friend intro forwarded); fix, rerun, until C3 holds for two consecutive runs.

### C2. The bench

The plan 28 harness, extended: the fake api seeds a friend (Ana, Cornell 2025, shares 120 people, 6 at the student's targets) and inbound replies of every class on a timer; a `clock` the sim can advance so the review window, the morning send and the worker tick run in a test; the judge's reference notes for each new scenario (what a correct answer knows: the rules in B6, the sharing rules in A1). Shape and safety checks gain: an auto send never appears without a Sent for you line; nothing is sent to a LinkedIn address; a friend's email never appears in any card or draft; a projection never carries a Google-derived field (asserted on the server response shape).

### C3. Exit criteria ("flawless")

- Judge: every `friends` and `autopilot` scenario at 2 or more on all eight dimensions, group averages at 2.7 or more, zero unsafe, zero invented, for two consecutive runs; `knowledge` and `drafting` do not regress against their last run.
- Safety: the B6 and A1 rules hold in unit, server and e2e tests; a mutation test that flips any one condition in `autonomyAllows` or `friend_visible` fails a test.
- Screen: the Friends tab, the Autopilot and Voice pages, Tomorrow's batch, Needs you and Sent for you at four viewports with nothing clipped and no dash or exclamation mark.
- Real account: a friend invite accepted by a second real account, a route through the friend on the Map, one intro forwarded; Assist on for a week with every send shown, one reply answered by Orbit, one call booked; no 4xx or 5xx in the function logs; the Google consent screen unchanged (no new scope beyond `calendar.events` already planned).
- Cost: an autopilot day under $0.10 per student (classification by Haiku, drafting by Opus only for sends); a friend path lookup adds no model call.

### C4. What this plan does not do

No direct messages to a friend's contact (the friend always forwards). No LinkedIn automation at any level. No auto first messages to strangers, recruiters, faculty or anyone under 18. No sharing of Google-derived data between users, ever. No "autopilot" in local mode beyond what a tab open can do, said plainly in the UI.

## Changelog

| Date | What | Commit |
|---|---|---|
| 2026-10-31 | Plan written from the code maps (network graph and sharing; autonomy, replies, voice and worker) and the market read (Connect The Dots and The Swarm share existence and strength of a relationship, never content; AI reply agents run human-in-the-loop before autopilot and only book once qualified) | |

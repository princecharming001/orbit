# 24. Onboarding in the student's own words

Status: built.

## Why

Setup asked for a profile, kinds of work, companies and a weekly pace, then connected LinkedIn and Gmail. Orbit knew
*what* the student was recruiting for but not *why*, what a good cycle looks like to them, how they want to come
across, who they hope to meet, or what they never want Orbit to do. Drafts described the student from structured
fields only ("a junior at Cornell studying computer science"), prep's 30-second intro was assembled from the resume,
and the chat had to guess the tone.

This plan adds short written questions to setup, each optional, and makes every system that writes or ranks for the
student read the answers.

## Rules

- Every written question is optional, with a placeholder that shows a good answer and a Skip.
- At most two questions on a screen, a progress bar, about three minutes end to end.
- Every answer is editable later in Settings, Goals, under **In your words**, with the same fields.
- An answer never leaves the browser in local mode. In account mode it goes to the server like the profile does.
- UI copy is sentence case, no dashes, plain words.

## Screens

Stored step numbers keep the old ones (a student part way through the older setup lands where they were). The new
screens sit between Goals (3) and LinkedIn (4) and have word addresses, so no address is a fraction.

| # | Stored | Address | Screen | Fields |
|---|---|---|---|---|
| 1 | 1 | `/onboarding/0` | Welcome | |
| 2 | 2 | `/onboarding/1` | You | name, email, school, graduation year, resume |
| 3 | 3 | `/onboarding/2` | Goals | kinds of goal, kinds of work, target companies, first messages a week |
| 4 | 3.2 | `/onboarding/aim` | Start with your why | `aim`, `success` |
| 5 | 3.4 | `/onboarding/story` | How would you introduce yourself? | `story`, `proudOf` |
| 6 | 3.6 | `/onboarding/people` | Who do you want to meet? | `wantToMeet` (with tap-to-add starters) |
| 7 | 3.8 | `/onboarding/style` | How should Orbit help? | `networkingHard`, `neverDo` |
| 8 | 3.9 | `/onboarding/job` | Going for something right now? | `currentJob` (a link, a company, or both) |
| 9 | 4 | `/onboarding/3` | LinkedIn | |
| 10 | 5 / 5.5 | `/onboarding/4`, `/onboarding/4.5` | Gmail, or Rate a few people (account mode) | |
| 11 | 6 | `/onboarding/5` | Ready | adds an **In your words** row: how many answered, Add jumps back |

The written screens are optional steps: passing one with nothing written marks it skipped in the progress list.
Continue saves what is on screen; Skip moves on and changes nothing; Back saves first.

## Fields

On `RecruitingGoals` (`packages/core/src/types.ts`), all optional strings, trimmed, empty means unset:

| Field | Question | Placeholder example |
|---|---|---|
| `aim` | What are you going for, and why? | Product roles at fintech startups. I grew up helping run my family's store and want to build tools for small businesses. |
| `success` | What would make this cycle a win, and by when? | Five real conversations with PMs by November, and an offer I'm excited about by February. |
| `story` | Your story in two lines | I'm a junior at Michigan studying economics. Last summer I built pricing models at a fintech startup, and I run our investing club's education program. |
| `proudOf` | What are you good at, or proud of? | Explaining hard ideas simply. I taught 40 first-years how to read a balance sheet. |
| `wantToMeet` | Who do you most want to meet? | Alumni one or two years into product roles, and anyone on the payments team at Stripe. |
| `networkingHard` | What's hard about networking for you right now? | I freeze on what to say after hello, and asking for someone's time feels like asking a favor. |
| `neverDo` | Anything Orbit should never do? | Never mention my GPA. No exclamation marks. |
| `currentJob` | Going for something right now? Paste the link or the company. | `{ url?: string; text?: string }`, exactly this shape (plan 23 reads it) |

`freeText` ("Anything else?") is retired: Dexie version 8 moves it into `aim` (appended when both exist) and drops it.

## Where each answer goes

| Answer | Read by |
|---|---|
| `aim` | chat snapshot; the recruiting goal's `description` (synced, so the server's drafts read it); Deep research's goal line |
| `success` | chat snapshot; the recruiting goal's `successMetric`; the morning deck's "Working toward" line |
| `story` | drafts (`DraftContext.user.story`: the model introduces the student with it); prep's 30-second intro opens with it |
| `proudOf` | drafts (`user.proudOf`, a credibility line the model may use); chat snapshot |
| `wantToMeet` | Discover and network recommendations (`parseWantToMeet`: roles, levels, alumni, topic words; a fit boost, a search of its own and the reason "who you said you want to meet"); chat snapshot |
| `networkingHard` | chat snapshot, as the tone to take with the student (it leads the snapshot's line, after the never rule) |
| `neverDo` | chat snapshot as a hard rule; drafts (`user.neverDo` in the prompt; `neverDoChecks` rejects a model draft that breaks a checkable rule and warns in review) |
| `currentJob` | chat snapshot; stored for plan 23 |

Account mode: the answers go to `/settings/profile` as `about`, kept in `users.settings.about` (jsonb, so no
migration), and come back from `/me` to a new device. The server's compose context prints them, and its prompt
treats the never line as a hard rule.

## Motion

- Steps slide in from the side they come from (forward from the right, back from the left) and fade, 420ms on the
  shared expo ease.
- A question's title reveals word by word, then its fields rise in, staggered.
- The progress bar is one thin track under the header whose fill eases to the next step.
- `prefers-reduced-motion` turns all of it off. Nothing bounces.

## Not in this plan

- Turning `currentJob` into a plan (plan 23).
- Parsing a job link's page.

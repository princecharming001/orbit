# 36. No dead ends: every people question ends with people

Status: built, 2026-11-09. Amends 32 (network search, §6.5 relaxing), 31 (web sourcing) and the chat prompt (19, 28). The founder's rule: Orbit never answers a people question with "I did not find anyone". It goes down a ladder, free rungs first, and shows the best tier it reached, saying in one honest clause which tier that is.

## 1. The failing cases

- Demo, "who do I know who works in climate": the search card said "No clear matches / Nobody to show." and the reply said nobody in climate was in the network. The demo has no climate company at all, so the network search was right and the answer was still a dead end.
- Demo, "find me 10 seed investors in climate software": `find_people` said "needs an Orbit account", the card was empty again, and the reply said it could not name any investors.

## 2. The ladder

Each rung runs only when the rungs above it found nobody who fits. Rungs 1 to 3 are free (this browser's data, or the demo's mock connectors). Rungs 4 and 5 can cost money and run only after them.

| # | Rung | Where it lives | What it shows | How the card labels it |
|---|---|---|---|---|
| 0 | Exact matches (plan 32), with its own relaxing (class year, time window, seniority, past jobs) | `engine/networkSearch/index.ts` | people who match, sure then likely | "N matches" |
| 1 | Related field | `engine/networkSearch/ladder.ts` `related` | people the student knows whose headline, title, company, company industry, summary, topics or notes name the field or a neighbour of it: climate gives clean energy, renewables, solar, wind, carbon, sustainability, battery, EV, grid, utilities, ESG; fintech gives payments, lending, banking. Inferred from company, title and headline, not the industry field alone | section "Related field", each row says which word it rests on ("Headline mentions solar") |
| 2 | Used to work there | `ladder.ts` `former` | for an ask with a company, kind of company or industry: the same ask with past jobs, from the engine's own checks | "Used to work there" |
| 3 | Second degree | `ladder.ts` `intro` and `connector` | for a company: warm intro paths (Village, or the demo graph), routes through a closer contact to someone there; for any ask: the people the student knows best who are likeliest to know someone (consultants, bankers, investors, recruiters, professors and founders meet people across fields; people who connect to many others in the network; alumni) | "Can introduce you" (a real path) or "Could know someone" (a guess, said as one) |
| 4 | New people who fit | `find_people` (`chat/tools/network.ts`), server sourcing (`_shared/sourcing`) | people found on LinkedIn, Apollo, the web and faculty pages, warmest tier first; the demo gets made-up candidates at made-up firms from `integrations/connectorsMock.ts` `mockSourcedPeople` (investors, faculty, or a field the demo's mock LinkedIn pool lacks) | "People for ..." with the tier chip ("You know them" only for someone already in People); the demo's summary says they are new people the student does not know yet |
| 5 | The web | the model's `web_search` | how others reached a named person (talks, office hours, published email, mutual programs), people and firms named on public pages, listed as rows with the source in words | the reply says "found on the web, not in your network" |

The network search tool runs rungs 1 to 3 itself and returns them in the same `people_table` result under `fallback`, so the card is never empty when the student has anyone in Orbit. It then tells the model, in `nextStep`, which paid rung comes next:

- rows in rung 1 or 2 (someone who nearly fits): present them; offer rung 4 in one short question unless the ask was for new people.
- only rung 3 (connectors) or nothing: call `find_people` now with the same ask, in the same turn, then answer with both: the new people, labelled as not yet known, and who could introduce the student.
- a named person who is not in the network: `find_routes` first, then `web_search` for how others reached them and for people around them (ex-colleagues, the company's team).

`find_people` itself never ends empty: the demo uses the mock sourcing pool, a copy without an account searches LinkedIn from this browser when connected, and otherwise returns `nextStep: web` so the model names people and firms from a web search as rows instead of refusing. An account search that returns nobody does the same.

## 3. Honesty

- A row in rungs 1 to 3 is someone the student knows; the label says why they are there and never that they match. "Could know someone" is said as a possibility, never as a fact about who they know.
- A row in rung 4 or 5 is someone the student does not know. The card says "not in your People" and the reply says "new people, you do not know them yet". Demo candidates are made up like the rest of the demo, at made-up firms.
- One clause names the tier ("Nobody you know works in climate itself; the closest are..."), then the people. Never a sentence that ends on nobody.

## 4. The broad cases

| Ask | Rung that usually answers |
|---|---|
| A famous person ("Elon Musk") | 3 (people at SpaceX or Tesla the student knows, intro paths), 2 (who used to work there), 5 (how others reached him, programs and events he speaks at) |
| A role at an org ("PMs at Stripe") | 0, then 2 (ex-Stripe), 3 (routes into Stripe), 4 (Stripe PMs found on LinkedIn) |
| A field ("climate", "fintech") | 1 (related words), 3 (connectors), 4 (people in the field) |
| A school or professor ("biology professor at Stanford") | 0 (alumni, professors on file), 3 (connectors, alumni), 4 (faculty pages, plan 31) |
| A company with nobody there | 2, 3 (Village and graph routes), 4, 5 |
| Only a tie filter ("people I have not talked to in a year") | rung 0 relaxing only; no ladder, the answer is about the student's own people |

## 5. Where the wording lives

The prompt holds one rule (never end on nobody; an empty search returns `nextTier` and `nextStep`, show the tier in one clause and do the step at once). How to word the answer travels in the results, as plan 35 A2 asks: `replyStyle` and `nextStep` on an empty `search_network`, `howToAnswer` on `find_people`, `nextStep` on the web rung. The card (`chat/ui/cards/PeopleTable.tsx`) titles an empty answer "Closest in your network" with one section per tier (eight people in all, best tiers first), and the bare empty line reads "No exact match in your network. The next step looks beyond it."

## 6. Cost

Rungs 1 to 3 read only this browser's tables (and Village, which `find_routes` already calls for company asks). Rung 4 is one `/source/search` call (plan 35 caps apply) and runs only when rungs 1 and 2 found nobody, or the student asked for new people. Rung 5 is at most the turn's web search budget (plan 34 C2).

## 7. Tests

`apps/web/src/chat/__tests__/no-dead-ends.test.ts`: on the demo, a climate ask returns fallback rows and a next step and never an empty final answer; a crypto ask finds related rows (the demo's fintech and trading firms); a company nobody is at (SpaceX) still shows people; `find_people` for seed investors in climate software returns ten made-up investors at made-up firms that can be added; a local copy without an account gets the web next step instead of a refusal.

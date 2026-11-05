# 31. Web sourcing: people from public pages, with contact and context

Status: built, 2026-11-05. Extends 16 §6 (sourcing) and 20 (deep research's web reading). The student asks, in the chat or on Discover, for people Orbit cannot find in their network: "source professors I can reach out to for biomed research at Berkeley", "people on the payments team at Stripe". Orbit reads the public pages where those people are listed, returns names with a title, an email when the page gives one, and the context a first message needs, and the usual Add turns them into people whose drafts carry that context.

## 1. Why

Before this plan `/source/search` routed a research ask to Semantic Scholar (the most published authors on a topic, anywhere in the world, no email, no school filter) and to Exa, which has no key. A student asking for Berkeley biomed professors got a thin, unfocused list and no way to write to anyone. The information they wanted is on department faculty pages and lab sites: name, title, research areas, email. Reading those pages is what deep research already does for one person (plan 20); this plan does it for a list.

## 2. Design

One new provider, `supabase/functions/_shared/sourcing/web.ts`, in the same `Call` shape as the others.

- **When it runs.** For any purpose when the ask names a place (a school or an organization) and a subject (a topic, a role or keywords). Research asks (`collaboration`) run it first; recruiting, advice and community asks run it beside LinkedIn.
- **What it asks the web.** Three or four searches built from the place and the subject: the faculty or team directory, the subject's lab or group pages, the department's people page. Pages are chosen by their address and title (`.edu` and the organization's own domain first, then pages with "faculty", "people", "directory", "lab", "team" in them), at most six.
- **Who searches.** The same `WebSource` chain as deep research: Exa when its key is set, otherwise Claude's own web search and fetch on the fast model. Results and page text go through the shared 7-day cache (`public.orbit_research_cache`), so a second student asking about the same department pays nothing for the pages.
- **Reading the pages.** Haiku reads each page's text and lists the people on it: name, title, department, email exactly as written on the page (never guessed), research areas or what they work on, the page itself and a lab page when linked. A person appears only if the page names them; emails come only from the page.
- **What comes back.** Each person is a `Candidate` with `email`, `url` and `evidence` (two or three short lines: what they work on, the lab, the page it came from). Merge, fit (Haiku sees the evidence), reach and ranking are unchanged. `SourcedCandidate` carries `email`, `url` and `evidence` to the app.
- **Add.** `/source/add` writes the evidence as `orbit.facts` rows (type `sourced`) on the new person, and the email as their primary email. `composeDraft` already numbers a person's facts into the prompt as research, so the first message can name the lab and the paper without a dossier.
- **Chat.** `find_people` takes `school`, `organization` and `topic` beside the free-text query; the card shows the title, where they are, whether an email was found, and the first line of context. Asked for professors or researchers at a place, the router sends it there.
- **Cost.** One run is three to four searches, up to six page reads and one extraction call on Haiku, plus fit: about $0.05 to $0.12 on Claude's web search, under $0.03 with Parallel or Exa set. Counted against the student's Claude cap as `anthropic / sourcing_web`.

## 3. Not built

- Email discovery beyond the page (pattern guessing, verification services). A person without an email on the page comes back without one; the student can still find them on LinkedIn.
- Semantic Scholar enrichment per professor (papers, h-index). The evidence is what the department page says.
- A bench with a judge, as the chat and drafts have. The live test (`ORBIT_SOURCE_LIVE=1`) prints what a real run returns for the Berkeley biomed ask.

# 41. Fewer LinkedIn calls, more use per student

LinkedIn tolerates roughly 100 profile reads, 100 searches, 100 post reads and 150 company pages per account per day
(Unipile's guidance). That is a safety limit, so money does not raise it. The only ways to give a student more room
are to stop spending reads on things Orbit already has, to stop spending them before the student wants the answer,
and to make each read fill as much as it can.

## Where today's reads go

One account, a normal day (measured Nov 10 and 11 from the logs, the job records and the caches):

| What spends | Profile reads | Searches | Post reads |
|---|---|---|---|
| A person's photo (`/photo`: a whole profile read for one picture) | 15 to 20 | | |
| "Who knows them" (`/mutuals`: 1 profile read, then up to 5 pages) | 14 to 16 | 30 to 50 | |
| Opening a person (`/profile`) | 12 to 36 | | |
| How well mutuals know a target (hop evidence, up to 17 reads a target) | about 5 | | about 35 |
| Background profile reading | 10 to 29 | | |
| The sweep of the student's connections (census) | | about 25 | |

Findings from the audit:

1. **The same person is kept in five places that do not read each other.** A profile read by the photo queue does not
   save the read when the student opens that person, or when the server reads them, or when another student does.
2. **A photo costs a profile read**, although the connections list, search results, chats and every other profile
   read already carry the picture. LinkedIn's picture links expire, so the same people are read again every few weeks.
3. **"Who knows them" keeps nothing on the server** and reads the target's profile only for one number that any
   earlier read of that person already returned.
4. **Hop evidence costs up to 17 reads a target**, so it uses its whole allowance (40 reads) every day on two or
   three people.
5. **The census repeats.** LinkedIn's search stops at 1,000 results, so 100 searches cover 1,000 of 6,561 connections,
   and the same 1,000 are walked again every 30 days.
6. **The count is not honest.** A company page is charged as a profile view. Dossier, sourcing and the lookup before a
   send are not counted at all. Nothing records which part of Orbit spent a read, or how often one was refused.

## Three rules

1. **Never ask LinkedIn for what Orbit already has**, whichever part of Orbit read it, for whichever student.
2. **Never ask before the student wants the answer.** Background work fills in from what is free.
3. **One read fills everything it can.** A profile read gives the photo, the shared-connection count, the companies'
   logos and the public profile in one go.

## What changes

### A. One person record, read before every LinkedIn read

Every read of a person, whoever made it, is kept once under each name LinkedIn has for them (member id and public
name), in the shared store that already exists (`orbit_private.linkedin_shared`):

- **What anyone would see** (name, headline, work, schools, photo): shared across students, 30 days.
- **What depends on the reader** (shared-connection count, distance, contact details): kept per account, 14 days.

`/profile`, `/photo` and `/mutuals` look there first. A stored read with more sections answers a request for fewer.
A read answered from the store costs nothing and is counted as saved.

### B. Photos are kept, like logos

- Any read that returns a picture copies it into Orbit's storage, so the link never expires.
- The browser hands over pictures it got for free (connections list, search rows, chats) to be copied. Copying is a
  download from LinkedIn's image host, not activity on the student's account.
- `/photo` reads LinkedIn only for someone no source ever had a picture for, and that read fills the person record.

Expected: 15 to 20 profile reads a day down to 0 to 3.

### C. "Who knows them" remembers

- A checked answer is kept 14 days, on the server per student and target, and in the browser (it was kept for the
  calendar day, so the same person cost a profile read and up to 5 searches again every morning).
- The shared-connection count comes from the person record when this account read that person in the last 14 days,
  so no profile read is spent for it. When the profile is read, that read also fills the person record and the photo.
- A timed-out request that is retried is answered from the kept answer instead of being read and charged twice.

Expected: about 10 fewer profile reads and 25 fewer searches a day.

Later, with a "Show all" control in the app: read the first page (10 people) on open and the rest when asked.

### D. Hop evidence costs less per target (server)

It already runs only when the student asks for routes to a person. The cost is per target: their profile, three pages
of their activity, two pages for each of the top five mutuals, and three comment threads, up to 17 reads, so two or
three targets use the day's 40.

- Weigh the top 2 mutuals, not 5, and 1 thread, not 3: about 7 reads a target. The rest are matched from pages
  already kept, as today.
- The target's profile comes from the person record.
- Pages of public activity are shared across students (ids, dates and counts only, as today).

Expected: about 35 post reads a day down to about 15, for the same number of targets. This trades a little depth in
"how well does this mutual know them" for more than twice as many targets a day, so it is a product choice.

### E. The census stops repeating (server)

- Title and company come first from what is free: the headline in the connections list, and the student's LinkedIn
  export (every connection with company and position, no calls at all).
- Search is spent only on slices tied to the student's goals (their target companies, their schools), each under
  1,000 results, and a slice is not walked again for 90 days.

Expected: about 25 searches a day down to about 5, with better coverage of the people who matter.

### F. An honest count

- A company page is charged to the company ledger, not the profile ledger.
- Dossier, sourcing and the lookup before a send are counted.
- A daily record per account, kind and part of Orbit: reads made, reads saved from the store, reads refused
  (`orbit.linkedin_calls_daily`). This is how the saving is checked.

### G. The student first

- What the student is waiting for keeps the highest ceilings (unchanged).
- A background read refused today is kept for tomorrow instead of dropped.

## What this adds up to

| Per account per day | Now | After A to C (live from this branch) | After D and E as well |
|---|---|---|---|
| Profile reads | about 57 | about 25 | about 20 |
| Searches | about 56 | about 30 | about 10 |
| Post reads | about 37 | about 37 | about 15 |

So the same student can open roughly three times as many people and routes inside the same allowance. Every further
student makes the shared store more useful, because one student's read answers the next student's.

## What is built

**Live from this branch (`orbit-connectors` and the browser):**

- A: `supabase/functions/orbit-connectors/people.ts` (the person record, the reader's record, kept photos) and
  `rememberRead` in `connectors.ts`. `/profile`, `/photo` and `/mutuals` read it first and fill it after every read.
- B: bucket `people-photos`; `/photo` answers from the kept copy, copies a link the browser hands over (`known`), and
  only then reads. `engine/photoQueue.ts` copies working links for people a screen showed, and a kept answer does not
  count against the day's photo reads.
- C: as above. `MUTUALS_KEEP_MS` in `engine/linkedinLive.ts`.
- F (part): `/company` charges the company ledger; `orbit.linkedin_calls_daily` counts made, saved and refused per
  account, ledger and caller for every read that goes through `orbit-connectors`.
- Migration `20261129_orbit_linkedin_call_diet.sql` (additive).

**Waiting on `orbit-api` and `orbit-worker` being deployable from main** (the sourcing-speed and deep-research
branches merged first): D, E, the server's own reads using the same person record, and counting the dossier,
sourcing and send-lookup reads.

## Checking the saving

```sql
select day, kind, caller, sum(made) made, sum(saved) saved, sum(refused) refused
  from orbit.linkedin_calls_daily
 group by 1, 2, 3 order by 1 desc, 2, 3;
```

## Not done, and why

- **Reading public profiles through a paid data provider** would take profile reads to near zero, but costs money per
  profile. That is a spending decision.
- **Raising the per-account totals** would go against Unipile's guidance.

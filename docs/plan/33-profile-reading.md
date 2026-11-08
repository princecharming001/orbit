# Plan 33: profile reading

Network search (plan 32) could only judge what a headline says. A company's stage, its team size and what a person
actually works on usually live in two other places: the person's LinkedIn About and job descriptions, and the
company's own LinkedIn page. Before this plan Orbit had an About for none of the founder's 7,540 people.

## What is read

| Source | Through | Daily share of the account ledger | Kept in |
| --- | --- | --- | --- |
| Company page (About, tagline, headcount, 6/12/24 month growth, founding year, industry, HQ) | `GET /api/v1/linkedin/company/{id}` | company ledger: background 60%, ask-time 80% (of 150) | `orbit_private.company_pages`, projected into `company_facts` as a `linkedin` row (shared, names no student) |
| Person profile (About, every job with dates, company id and description) | `GET /api/v1/users/{id}?linkedin_sections=about&linkedin_sections=experience&notify=false` | profile ledger: background 30%, ask-time 60% (of 100) | `orbit.profile_reads`; the About also fills `people.summary` where it was empty |

Company ids come from the census (`current_positions[].company_id`, kept in `facet_assertions.ref`) and from the jobs
of profiles already read, so no company is ever looked up by name. Company pages are not profile views and tell
nobody, so they cover the whole network within weeks; profiles go founders, investors and leaders first, then the
closest ties.

## The reading

Claude Haiku reads each profile once (batches of 8) and writes only what the text states: the stage of their current
company, its team size, up to four phrases for what they work on, and signals (hiring, raising, angel investing,
stealth, open to work, advising). Company Abouts give a stated stage, the kind of organisation and a one-line
description. Every fact must quote words that are really in the text (core `search/reading.ts`, `quoteIn`), and a
stage's quote must itself name a stage. Without Claude, plain patterns ("Series A", "team of 12") fill what they can.

## How search uses it

- Jobs from a read profile are roles with source `profile` (dates included), so "ex-Google" and "started in the last
  two years" rest on the profile, not the headline. A job's LinkedIn company id matches its company page exactly.
- A stage or team size the person states for their current company decides the check outright, with their words as
  the evidence. Otherwise the company page's stated stage, then an estimate from headcount (a Likely at most).
- Team size from a page is LinkedIn's member count: close to a bound it is a Likely, not a Yes.
- Industry checks read the company's About and the person's focus.
- An angel investor in their own words is an investing role.
- The judge reads the About (1,500 characters), what they wrote under their jobs, their focus and signals, and each
  current employer's page; its cache is keyed by that text, so a new About asks again.
- At ask time, when the ask needs what a headline rarely says (stage, size, industry, past jobs, time in role,
  criteria, keywords), up to six listed people with an open check are read before the judge runs
  (`POST /search/read`, 20 seconds at most), and the card says how many were read.

## Schedule

`orbit-search-reading`, minute 41 of every second hour, per student with an active LinkedIn: up to 15 company pages,
6 profiles, then the reading of whatever is unread.

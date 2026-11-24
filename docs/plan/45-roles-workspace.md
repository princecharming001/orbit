# Plan 45: Roles as a recruiting workspace, the way in first

Status: draft 2 (review changes in §9), building.

## 1. What the student said

- The table of postings reads as a list of random rows. It should feel like a small recruiting tool inside Orbit,
  like Jobright, LinkedIn Jobs and Handshake: postings as cards, a fit score you read at a glance, a search bar,
  filters, and one posting open beside the list.
- The point of Roles inside Orbit is the warm path in. Roles with a clear way in come first; the way in is a filter
  and a sort the student can change or switch off; how many people they know there shows on every posting.
- Opening a posting should show the way in right there, with the next step one click away, never on another screen.
- Tell them where to apply.
- Too much small grey text on every Roles screen.
- The profile screen (what Orbit read) looks basic: kinds of role should be searchable with suggestions and with no
  low cap, places should suggest cities as they type, "Where you are" and the work questions need real layout, and
  typing in Where must not throw them out of the field.

## 2. What we take from the references, and what we leave

| Taken | From | Here |
| --- | --- | --- |
| List of posting cards on the left, the open posting on the right, both scroll on their own | LinkedIn Jobs, Handshake | §4 |
| A match score in a ring on each card, with its band in a word | Jobright | §4.2 |
| Logo, company, title, then a short line of facts (place, remote, level, pay, posted) | all three | §4.2 |
| A search box over title, company and skills; a row of filter chips | LinkedIn Jobs, Handshake | §4.1 |
| "Insider connections" on the posting | Jobright | §4.3, made the first section |
| Save, Not for me, Applied tracking in tabs | Jobright (Liked, Applied) | §4.1 |
| Requirements met and missing, as a checklist | Jobright | §4.3 |

Left out: autofill of applications, a chatbot inside the posting (Orbit's own chat already finds roles), salary
estimates Orbit cannot back with the posting's words, applicant counts (no source gives them honestly).

## 3. The way in, as a number the page can sort and filter by

`wayInOf(path, intros)` gives each company one of four, best first:

| Way in | When | Card shows |
| --- | --- | --- |
| `close` | someone the student knows there with a tie of 3 bars or more | their faces, "You know Dana" |
| `known` | anyone the student knows there, or an alum of their school | faces, "2 you know" / "1 alum" |
| `intro` | no one there, but a person they know can introduce them (the company page's warm route) | "Intro via Kenji" |
| `none` | nothing yet | nothing (no "No one yet" text) |

`intro` needs the reach graph. It is read once for the companies on screen (graph built once, cached by
`buildReachGraph`), in the background after the list shows, capped at 40 companies, kept per visit.

### 3.1 Order

"Best match" (the default) ranks by fit plus a bonus for the way in: close +1.5, known +1, intro +0.75, none 0. A 7
with a close friend there sits above an 8 with no one. The other orders: Best fit, Easiest way in, Newest.

### 3.2 Filter

"Way in" chip: Any (default), Someone I know (close or known), Someone I know or an intro, No way in yet. Off is Any.

## 4. The page

### 4.1 Top

- Title "Roles". Beside it, one quiet button with the profile in a few words ("Student, Data Science, Berkeley")
  that opens the profile screen. Search again is an icon button.
- Tabs: For you, Saved, Applied, Companies. Applied holds applied and interviewing.
- A search box (title, company, team, skill named in the posting), then chips: Kind, Level, Place (with suggestions
  from the places in the list), Remote, Way in, Visa, Fit, and the order on the right.
- While reading: one thin progress line with "20 of 60 read", no sentence.
- The coverage sentence, "read when" and notes move into a small info popover beside the tabs. A note that changes
  what the student sees (LinkedIn read little, the model is off) stays as one line.

### 4.2 The card

```
[logo] Reddit · 2d                                    ( 8 )
       Product Manager, AI Foundations                 Strong
       San Francisco · Hybrid · Internship · $45/hr
       (o)(o) Dana and 1 more you know                [save] [...]
```

- The ring is the fit out of 10, colored by band; a row not read closely shows a dashed ring and no number.
- The way-in line is the only line in accent color: it is what Orbit is for.
- Hover or focus shows Save and the three-dot menu (Not for me with a reason, Hide the company, Open posting).
- The selected card has a left rule and a tinted background. Arrow keys and j/k move through cards.

### 4.3 The open posting (right pane)

1. Header: logo, company, title, facts line. Buttons: Apply (primary, opens the apply link and then asks "Did you
   apply?" in place, which moves it to Applied), Save, three-dot menu.
2. "Where to apply": the board the link goes to, in words ("Company site, on Greenhouse", "LinkedIn", "Workday").
   With a way in, a tip above Apply: "Ask Dana for a referral before you apply."
3. "Your way in" (first section): up to four people, best first, each with face, name, title, how they connect and
   one button that acts in place:
   - someone the student knows: "Ask for a referral" (writes a referral ask; the draft opens under the row)
   - alum: "Write to" (first message)
   - intro route: "Ask Kenji for an intro" (the intro request, as the Map does it)
   Under them: "More people at Reddit" (Find a way in: the company's target plan) as a quiet link.
   With no one: a short line and "Find people at Reddit".
4. "How you fit": the ring large, the band, four short bars (Skills, Experience, Education, Level) in one line each.
5. "Requirements": the posting's skills as a checklist, met (check), listed only (half), missing (empty), with the
   gaps ("What would raise it") as one short list.
6. Closed postings say so in the header.

The draft opened in place is the same draft box Drafts uses (`MessagePane`), so sending, copying and "I sent it"
work as everywhere else.

### 4.4 Narrow screens

Under 1024px: the cards fill the width and the open posting is a drawer, as today.

## 5. The profile screen

- Two columns on wide screens: the section name on the left (no hint lines), its fields on the right; one column
  on a phone.
- Where you are: the degree and school as one plain line; Stage, Graduation month and year as flat selects.
- Kinds of role: the list (tick, title, one line why, a remove x on hover), then an "Add a kind of role" field with
  suggestions from a list of common roles as they type. Up to 12 (the server keeps 12).
- Skills: chips with suggestions.
- Where: Places and Not these places as chip fields with city suggestions (a list of about 150 cities), Remote as a
  switch row.
- Work authorization: each question a row, the answer a two-part segmented control.
- Footer: Find roles, Read again.
- Grey hint lines removed except where a field cannot be understood without one.

## 6. Other fixes in this pass

- Chip fields lost the cursor on every key (an input component made anew on each render). Fixed in `ChipsField`,
  which fixes Settings goals too.
- Drafts: the "write to the people you added" card gets a three-dot menu (Not now per person, Hide this card).
- Drafts: the open draft lines up with the first row of the list, not with the group's heading.

## 7. Tests

- Unit: `wayInOf`, best-match order, way-in filter, search filter, where-to-apply words.
- Component: card shows ring, way-in line; detail pane shows the way in first with the right button per kind;
  clicking Ask for a referral drafts in place; Apply then "I applied" moves it to Applied; chip field keeps focus
  while typing; kinds add with suggestions past six; city suggestions.
- e2e (fake API): the Roles flows in `roles.spec.ts` updated to cards; typing a city in Where keeps focus; the
  drafts card menu hides a person.

## 8. Out of scope

Server changes: none. The way in is read in the browser from what it already holds.

## 9. Review changes (draft 1 to draft 2)

- Draft 1 counted intros for every company. On a big network the graph build is the slow part; it is built once and
  cached, so the cap is on companies (40), not on calls. Cards show known and alumni at once, intros as they arrive.
- Draft 1 put the way in after the fit. The student said the way in is the point: it is first in the pane and its
  line is the only accent text on the card.
- Draft 1 had a separate "Referral" tab. Dropped: Saved and Applied cover it, and the way in is on every posting.
- Draft 1 kept the "Fit on paper" disclaimer under the score. Moved to the ring's tooltip, part of the grey-text cut.
- Draft 1 opened the draft on the person's page. Now it opens in the pane under the person, so the student never
  leaves Roles.
- Best match bonus kept small enough (at most 1.5) that a 5 with a friend never outranks a strong 8 with no one by
  default; Easiest way in is there for the student who wants that.

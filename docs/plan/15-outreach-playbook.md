# 15. Outreach playbook

Status: editorial specification for the drafting engine (`packages/core/src/drafts`) and for any human reviewing a draft. Distilled from twelve research lenses (career-center guides, practitioner forums, student-written guides, prep vendors). Amends 05 §7 (drafting and validation) and sets the exemplar corpus at `packages/core/src/drafts/corpus.json`. Confidence tags follow the legend in `README.md`.

The bar: a message Orbit drafts should be indistinguishable from one written by a senior who has done this a hundred times, got replies, and knows which of their emails worked. Not "good for AI." Good.

---

## 1. Principles

1. **Connection first.** The specific reason this person (not this firm) is being written to goes in the subject line and the first sentence: shared school, named referrer, same club or hometown, an event they spoke at, a transition they made. If the engine cannot name one checkable link, it does not draft; it asks the student for one.
2. **One un-copy-pasteable line.** Every draft contains at least one sentence that could only be true for this recipient. Test: swap the name and the firm; if the message still works, it is a template and it will be read as one.
3. **Ask for insight, never a job.** First messages ask only for a short conversation about their path. No "openings," no referral, no resume review, no resume attached (sector exceptions in §3). The word "job" never appears in a subject line.
4. **One ask, bounded, as a question.** Fifteen or twenty minutes, by phone or video, "sometime in the next couple of weeks," ending in a question mark, with scheduling deferred to them. Never "pick your brain," never "grab coffee sometime," never an hour.
5. **Short enough for a phone screen.** Outreach body 50 to 100 words, four to six sentences. Over half the words are about them, not the student. One credibility line, phrased as the reason for the question, not as a brag.
6. **Give them an out.** One closing clause that makes "no" cheap: "completely understand if the next few weeks are busy." Lowering the cost of a no raises the rate of yes.
7. **Beginner worth helping, not expert.** A sophomore who writes like an MD is read as fake. State the real situation plainly and ask the one question only this person can answer.
8. **Plain voice, contractions, read-aloud test.** Sentences under twenty words. No stock openers. If it would sound strange said across a table, rewrite it.
9. **Follow up once, in thread, then move on.** Most unanswered email is buried, not rejected. One bump after five to seven business days, two or three sentences, no new pitch. A second bump is allowed only in finance (§3). Silence after that is a no.
10. **Close every loop.** Thank-you within 24 hours with one specific callback. Report outcomes to anyone who referred or introduced you, including rejections. Nobody does this, which is why it works.

---

## 2. Rules by message kind

Word limits are for the body, excluding greeting and sign-off. The engine's `MAX_WORDS` should be aligned to these (current values are looser; tighten in a follow-up).

### 2.1 Outreach, cold (no shared affiliation)

**Limit:** 60 to 100 words, four to six sentences. **Required:** how you found them (phrased as research, not "I found you on LinkedIn"); one fact only true of them; one line of your situation; a 15-minute question-form ask with a loose window; an out. **Structure:** greeting / who + how found + the fact (two sentences) / situation and the question you want answered (one or two) / ask (one) / out + thanks (one).

Exemplar (finance, practitioner, non-alum):

> **Subject:** {school} econ junior, quick question about your path to {org}
>
> Hi {first},
>
> I'm a junior at {school} studying economics, and I came across your profile while reading about {org}'s healthcare group. You moved over from equity research, which is the switch I'm trying to understand before recruiting starts this fall.
>
> Would you have 15 minutes sometime in the next two weeks to talk about how you made that move? Happy to work around your calendar.
>
> Thanks either way,
> {me}

Exemplar (tech, built on their product; the one valid cold-to-hiring-manager email):

> **Subject:** Backend intern application, built a rate limiter on your API
>
> Hi {first},
>
> I'm a third year CS student and I've been using {org} for a side project since March. Last month I built a rate limiter on top of your API, which cut my failed requests by about 80 percent. Link: [url]
>
> I saw you're hiring backend interns and I'd rather send this to you directly than into the portal. Resume attached.
>
> Thanks either way,
> {me}

### 2.2 Outreach, alumni

**Limit:** 55 to 90 words. **Required:** school in the subject line and first sentence; where you found them (alumni directory, alumni LinkedIn page); interest defined narrowly (their org or move) and broadly (the field); 15 to 20 minute ask; thanks for considering. Alumni reply at two to four times the cold rate [UNCERTAIN], so this is the default first target.

Exemplar (Dalton's canonical five-point email, 63 words, verbatim except placeholders):

> **Subject:** {school} student seeking your advice
>
> Dear Mr. {first},
>
> My name is {me}, and I'm a first-year {school} MBA student who found your information in the {school} alumni database. May I have 15 minutes of your time to ask you about your experience with {org}? I'm trying to learn more about marketing careers at technology companies and your insights would be very helpful.

Exemplar (consulting, specific office):

> **Subject:** {school} alum, interested in your path to {org}'s Chicago office
>
> Hi {first},
>
> I'm a junior at {school} recruiting for consulting this fall and found you on the {school} alumni page while looking at {org}'s Chicago office. You went there after two years in healthcare operations, and I'm trying to work out whether an industry stint first is the better route.
>
> Would you have 15 minutes in the next couple of weeks to tell me how you decided? Whatever time suits you.
>
> Thanks,
> {me}

### 2.3 Outreach, warm (referred, met at an event, or warmed up on LinkedIn)

**Limit:** 60 to 100 words. **Required:** the referrer or the event in sentence one, by name ("...and asked me to pass along her hello"); one thing they actually said at the event if there was one; the same bounded ask. With a referral the subject line carries it. With a completed LinkedIn warm-up, one clause may mention their post, only if the student actually engaged (13 §5).

Exemplar (referral from a mutual contact):

> **Subject:** Priya Shah suggested I write to you
>
> Hi {first},
>
> Priya Shah mentioned you'd be the right person to ask about how {org}'s rotational program actually works day to day, and said to pass along her hello. I'm a sophomore at {school} and still deciding whether operations or finance is the right first job.
>
> Would you have 15 minutes in the next couple of weeks? Whatever time works for you works for me.
>
> Thanks,
> {me}

Exemplar (partner who spoke on campus; the only acceptable cold-to-partner message):

> Hi {first},
>
> Thank you for coming to {school} on Tuesday. Your point that the best first-years ask "what would make this slide unnecessary" has stuck with me, and I've been applying it to my case practice. I'd like to ask one follow-up about how you choose which engagements to staff juniors on. Would you have 15 minutes in the next few weeks?
>
> Best,
> {me}

### 2.4 LinkedIn connection note (300 characters, hard cap)

**Limit:** 150 to 260 characters [SECONDARY]; never fill all 300. Free LinkedIn accounts cut notes at 200 characters, so the engine aims for 200 and only goes longer (never past 300) when the connection and the ask do not fit. **Required:** who + connection, one specific about them, the ask or the reason to connect. Never a bare request, never "can I ask you something?" The note must carry the ask so no second message is needed. No resume, no referral.

> Hi {first}, {school} junior here. Saw you went from the debate team to {org}'s TMT group, which is the path I'm trying to understand. Would you be open to 15 minutes on how you made that jump? Happy to work around your schedule. {me}

> Hi {first}, I'm a CS junior at {school}. Read your post on migrating off the monolith; I'm doing a smaller version for a class project. Two quick questions by email, or 15 minutes if easier? Thanks either way, {me}

### 2.5 LinkedIn message (after connecting, or InMail)

**Limit:** 50 to 80 words. Same four moves as outreach, no subject line, slightly more casual. Lead with the thing that got the connection accepted. Offer email as a lower-friction channel.

> Hi {first}, thanks for connecting. I'm a junior at {school} exploring product roles, and the way you moved from support into PM at {org} is the route I'm weighing. Would you have 15 minutes in the next couple of weeks? Email is fine too if that's easier than a call. Thanks, {me}

### 2.6 Bump 1 and bump 2

**Bump 1.** Reply in the same thread after five to seven business days [SECONDARY]. **Limit:** 25 to 50 words, two or three sentences. **Required:** "in case it got buried"; the ask restated in one clause; an alternative (a pointer to someone else) or an out. **Forbidden:** new pitch, attachment, guilt, availability grid.

> Hi {first},
>
> Floating this back up in case it got buried. I'd still love 15 minutes whenever it's convenient, and if someone else on your team would be a better person to ask, I'd be grateful for a pointer.
>
> Thanks,
> {me}

**Bump 2.** Finance only, about a week after bump 1; consulting and tech stop after one. **Limit:** 20 to 40 words. It is the graceful last word, nothing more.

> Hi {first},
>
> Last note from me, I promise. If the next few weeks are too busy, no problem at all. If a 15-minute call ever does fit, I'll make the time work.
>
> Thanks,
> {me}

### 2.7 Scheduling: propose, confirm, reschedule

**Limit:** 30 to 60 words. Reply within one business day [DEFAULT]. Propose two concrete windows with the time zone, plus "or send me a time." Confirm with the slot, the time zone, the format and who calls whom, then send the invite. Reschedule once, apologise once, offer two replacements. Never ask them to pick from five options and never say when you can't talk.

> That's great, thank you. Would either of these work? Tuesday at 10am or Thursday at 2pm (ET). If neither does, send me a time and I'll make it fit.

> Thursday at 2pm ET works. I'll send a calendar invite with a Zoom link now; if you'd rather do phone, say so and I'll call your cell. Looking forward to it.

> Something came up on my end on Thursday and I'm sorry to move this. Would Friday at 2pm or Monday at 10am work instead? If not, I'll take whatever is easiest for you.

### 2.8 Thank-you

**Send within 24 hours** [SECONDARY]. **Limit:** 50 to 90 words. **Required:** locate the memory (when, where); one specific thing they said, in their words; one thing you did or will do because of it; a permission line for future questions. No referral ask unless they offered. Never the same text to two people at one firm.

> Hi {first},
>
> Thank you for making time this morning. Your point that first-years who ask for feedback after every deck get staffed on better deals is something I hadn't heard before, and I've already started doing it on my club project. I also read the restructuring piece you mentioned last night.
>
> I'll let you know how recruiting goes. Would it be alright to send a question your way if one comes up?
>
> Best,
> {me}

> Hi {first}, good to meet you at the Fintech Club panel yesterday. I kept thinking about what you said about reading the 10-K before the pitch deck. I did that for the company I'm presenting on Friday and it changed my whole second section. Thanks again for the time. {me}

### 2.9 Nurture check-in

Every four to six weeks after a conversation [SECONDARY]. **Limit:** 40 to 80 words. **Required:** one real update tied to something they said; one line about them (a public deal, a post, a move); "no reply needed." No ask. Only public facts about their firm.

> Hi {first},
>
> Quick update since we talked in March: I took your advice and switched my summer to the ops role, and your line about learning to read a P&L before anything else has been the single most useful part of it. Hope the move to the new team is going well.
>
> No reply needed, just wanted to say thanks.
> {me}

> Saw {org} closed the Veritas deal this week, congratulations. Would love to hear what the last two weeks of that were like whenever you have a moment. {me}

### 2.10 Congratulate

**Limit:** 25 to 50 words. One line on what happened, one line tying it to something they told you, one wish. No ask, no update about yourself.

> Hi {first}, just saw you moved to {org}. Congratulations, that fits everything you said about wanting to sit closer to the product. Hope the first weeks are going well. {me}

### 2.11 Referral ask

Only after at least one real conversation and, ideally, one light touch since [SECONDARY]. Ask **before** applying through the portal in tech (many ATSs cannot attach a referral afterward) and at submission time in finance and consulting. **Limit:** 60 to 100 words. **Required:** reference the conversation in one clause; exact role, office or team, requisition ID and link; resume attached; one sentence of fit; the conditional ask ("if you'd be comfortable"); an explicit out. Make it a two-minute task. Never ask them to find roles or review the resume.

> **Subject:** Quick update + applied to {org} {role}, {me}
>
> Hi {first},
>
> I submitted my application for the {role} at {org} this morning (job ID 4412, link below). Our conversation about how the LA office staffs first-years is a big part of why I applied here first. If you'd be comfortable flagging my name to the recruiting team, I'd be grateful; resume attached. Completely fine if not.
>
> Thanks again,
> {me}

> Hi {first}, I'm applying for the {role} internship at {org}, req 7731. Most relevant thing I've done: built the backend for a campus app with about a thousand users in Go and Postgres. Would you be willing to refer me for that req? Resume is at the link. Totally understand if you'd rather not, I know a referral has your name on it. {me}

Ladder for a thin relationship: (1) "Are referrals common at your firm? I'm applying in October and want to follow the right process." (2) "I'm applying in October. Would you be willing to refer me when I submit?" (3) "Is there anything you could help with that would strengthen my application?"

### 2.12 Intro request with forwardable blurb

**Limit:** 70 to 110 words including the blurb. **Required:** the target by name and why them; the ask ("if you'd be comfortable making a short intro"); a two-sentence third-person blurb in quotes the connector can forward unedited; an out. The blurb names the student, school, one credibility fact and the 15-minute ask.

> Hi {first},
>
> Small ask. I'm trying to learn how {target} thinks about PM hiring at {org}, and I noticed you two worked together at Stripe. If you'd be comfortable making a short intro, here's something you could forward:
>
> "{me} is a junior at {school} studying CS and recruiting for product internships. She built a scheduling tool that 300 students at {school} use, and would love 15 minutes to hear how {target} approaches new-grad PM hiring."
>
> And if it's not a good fit to ask, no worries at all.
>
> Thanks,
> {me}

### 2.13 Warm-up comment on a post

**Limit:** 15 to 40 words. A question or an added point, never praise. **Forbidden:** "Great post!", "Thanks for sharing", "So insightful", emoji strings, anything that could be posted under any post. It must reference a specific claim in the post.

> The point about writing the memo before the model is new to me. Did you find the memo changed the model's structure, or mostly the inputs?

> We hit the same thing migrating a class project off a monolith: the hard part wasn't the services, it was the shared test fixtures. Curious whether you split those first or last.

---

## 3. Sector notes

**Investment banking and finance.** Five sentences, no scrolling. Subject carries school plus year plus their group ("{school} '27, quick question on {org} healthcare"). "Hi {first}" for analysts and associates (they are two to four years older and read "Mr." as a culture-fit red flag); "Mr./Ms. {last}" for VPs and above you have not met. Resume: attach only if the student has a relevant internship, mention it in half a clause, never in the subject. Two bumps allowed, a week apart, then move on. Email beats LinkedIn for juniors; LinkedIn for VP+. Send from the .edu address Tue to Thu, 9:30 to 11:00am recipient-local [UNCERTAIN, forum consensus]. Thank-you within 24 hours, each note at a firm with a different callback; analysts compare. Nurture every four to six weeks; the referral ask goes out the day the application is submitted, with the role and date. Boutiques with no formal program are the one case where the first email asks about an internship directly, in the subject.

**Consulting.** Same five-sentence budget. Target analysts and associates one to three years in who share school, club or hometown; a partner only after an event, opening with what they said. Name the office and practice, not the firm. Never a referral in message one; sequence is chat, thank-you within 24 hours, one or two light touches over two to eight weeks, then "I'm applying to the {office} this fall, would you be comfortable flagging my application internally when I submit?" One 1:1 per contact before an interview invite; ask for a pointer to one more person instead of a second chat. Recruiters get a different, formal, logistics-only email: "Dear {first}", role and cycle, one answerable question about deadlines or campus events, names of consultants already spoken with, full contact block. One bump, then stop.

**Tech (SWE, PM, design).** "Hi {first}", contractions, five to seven sentences, subject that says what the email is. Proof beats adjectives: one clickable artifact (deployed app, then repo, then PDF), zero sentences about passion. Strangers get a question; affiliates (alum, mutual contact, someone who posted that their team is hiring) can get the referral ask directly with the two-minute package: req ID, link, resume, one-line fit, out. Ask for the referral before applying. Message a recently joined engineer or a peer IC, not the VP or a recruiter who doesn't own the req. Messaging several people at one company individually is fine; never say so. Timing beats polish: send within three days of a posting. One bump at five to six days, then stop permanently.

**Recruiter vs practitioner.** Practitioners get the conversation ask and the human register. Recruiters get logistics: role, cycle, one question, evidence of practitioner conversations, formal sign-off. Never ask a recruiter for a coffee chat, a referral or "any openings."

---

## 4. Subject-line rules

- Under 45 characters where possible; mobile truncates around 40 [SECONDARY].
- Shape: [connection] + [specific topic or their group]. "{school} '27, quick question on {org} TMT." "Fellow {school} alum, your move from ER to banking." "Priya Shah suggested I write." "From the {org} panel on Tuesday, one follow-up."
- About them, not you: "Your PM path at Red Hat and Blue Tie" beats "Student seeking guidance."
- Tech: plain and descriptive, states what the email is. "Backend intern application, built X on your API." "Quick question about life at {org}."
- Bumps keep "Re:" on the original subject. Referral asks state the fact: "Quick update + applied to {org} {role}."
- Banned: "Informational Interview Request", "Networking Request", "Aspiring X Seeking Guidance", "Coffee Chat Request", "Hello", "Following Up", "Resume Attached", anything with "job" or "opportunity", anything clever or salesy.

---

## 5. Cadence and timing

| Number | Value | Confidence |
|---|---|---|
| Outreach body length | 50 to 100 words; Dalton's published examples run 55 to 65 | [SECONDARY] |
| Finance / consulting sentence cap | 5 sentences, hard ceiling 7 | [SECONDARY] |
| Call length asked for | 15 minutes cold; 20 for alumni; 20 to 30 is the ceiling; never 45+ | [SECONDARY] |
| LinkedIn note | 300-char cap; 150 to 260 target | [VERIFIED] cap, [UNCERTAIN] target |
| Bump 1 | 5 to 7 business days after send, in thread | [SECONDARY] |
| Bump 2 | finance only, about 7 days after bump 1; max two bumps anywhere | [SECONDARY] |
| Reply to any inbound | same day, within two business days at the outside | [SECONDARY] |
| Thank-you | within 24 hours | [SECONDARY] |
| Nurture cadence | every 4 to 6 weeks after a conversation | [SECONDARY] |
| Referral ask | after at least one real conversation and one light touch; arc is 8 to 12 weeks | [UNCERTAIN] |
| Send window (finance / consulting) | Tue to Thu, 9:30 to 11:00am local; avoid Mon 9am and Fri pm; MDs 6 to 7am | [UNCERTAIN] |
| Send window (tech) | within ~3 days of a posting; otherwise Tue to Thu daytime | [UNCERTAIN] |
| Planning response rates | alumni 25 to 40%; same-firm hometown or high-school tie higher; pure cold 5 to 10%; referred intro 70%+ | [UNCERTAIN] |
| Finance volume | 10 to 20 emails a day; a few hundred from a target school, 1,000+ from a non-target | [UNCERTAIN] |
| Contacts per firm (consulting) | 8 to 12, expecting about 3 replies per 10 | [SECONDARY] |
| Tech funnel (one student's tracking) | portal 1 to 2 calls per 100; referred ~1 in 4; cold email to an engineer ~1 in 10 replied | [SECONDARY] |

Caps are enforced in code at send time (rule 4), not by the prompt.

---

## 6. Sounds human, not AI

**Delete on sight.** "I hope this email finds you well." "I hope this message finds you well." "I am writing to introduce myself." "I came across your profile and was impressed by your background." "I would be honored." "Esteemed." "Passionate about finance / technology." "Cut my teeth." "Lifelong passion." "Lean deal teams," "unique culture," "prestigious platform," "top-tier deal flow." "Pick your brain." "Reach out." "Touch base." "Circle back." "Leverage." "Synergy." "At your earliest convenience." "I look forward to hearing from you." "Quick learner." "Add value." Em-dashes. More than one exclamation point. Every sentence starting with "I." A paragraph about yourself. Three adjectives in a row. A closing that restates the opening.

**Do instead.** Open with the connection or the fact about them. Use contractions. Keep sentences under twenty words and vary their length. Name one concrete thing (a deal, a post, a product, a class year overlap). Write the ask as a question with a number in it. Give an out. Sign with first name only in tech, full name plus school and year in finance and consulting. Read it aloud; if it sounds like a cover letter, cut the sentence that made it one. One light aside ("I know you were a few years ahead of me") is human; two is trying.

**Engine checks.** Reject a draft if: the recipient's name is missing or misspelled; it contains a banned phrase or an em-dash; the body exceeds the limit by more than 25 words; no sentence references a stored fact about the person; the ask has no number in it; it shares an opening sentence with any other draft to the same organization in the last 30 days; a resume is attached to a first message outside the finance exception; a referral is requested with no prior conversation on record.

---

## 7. Anti-patterns

1. Asking for a job, referral, resume review or "any openings" in a first message; "job" in a subject line.
2. A resume attached to a cold email (outside the finance-with-internship exception) or "Resume Attached" as a subject.
3. "Pick your brain," "grab coffee sometime," "any advice you have," or any ask without a number and a question mark.
4. Proposing a grid of specific slots to a stranger, or stating when you cannot talk ("I have class until 5").
5. Over 120 words, multiple paragraphs about yourself, GPA, coursework, a list of internships.
6. Stock openers and firm flattery; the "cut my teeth" email that one recruiter received fifteen times in a week.
7. "Mr./Ms." to an analyst or associate; "Dear Sir/Madam" to anyone.
8. "I found you on LinkedIn" said baldly; say "came across your profile while researching {org}'s {group}."
9. Identical wording to several people at one firm, or telling anyone you are messaging others.
10. A LinkedIn request with no note, a "hi, can I ask you something?" pre-message, or a note that uses all 300 characters.
11. More than one bump (two in finance); bumps that add guilt, attachments or new pitches; starting a new thread for the bump.
12. A generic thank-you, or the same thank-you to two people met at one event.
13. Asking the same person for a second coffee chat before an interview; ask for a pointer to someone else.
14. Contacting a partner or VP cold with no event hook; messaging the CEO; messaging a recruiter who doesn't own the role.
15. Applying through the portal and then asking for a referral (tech); starting the relationship the week you need it.
16. Making the referrer find the role, review the resume or judge fit for you.
17. Wrong name, wrong firm, pasted formatting, mixed fonts, a leftover placeholder.
18. Sending from a non-.edu address as a student; Monday 9am or Friday afternoon sends to finance.
19. Never reporting back to a referrer, or skipping the same-day thank-you after a call.
20. Comments on posts that say "great post" or anything that could sit under any post.

---

## 9. How the engine applies this

- **Never fabricate, ask instead.** When a draft is missing the one thing only the student knows, `generateDraft` returns `needsInput` and a bracketed line, and the editor asks for it: `connection` (cold outreach with no checkable link), `update` (nurture with neither an update nor a hook), `news` (congratulate with no job change on record), `target` (intro request with nobody named), `answer` (a question in their reply; Orbit never answers for the student), `role` (referral ask with no company), `takeaway` (a thank-you with no note facts: one thing they said, since a thank-you without it is the generic note §2.8 forbids). The student's line is used verbatim, only turned to address the person: a takeaway typed in the first person reads "your advice that I should learn SQL", and a sentence about the student that is not advice ("I loved the story about Stripe") stays the student's own sentence; a connection line is also stored as a `connection` fact for later drafts.
- **Facts are spliced only as grammatical clauses.** Stored facts are third person ("They recommended ...", "Alina offered ..."); `clause()` turns them into second person with verb agreement ("you recommended ...", "you offered ..."), and a fact that cannot be made grammatical (a third party as subject, a question, a fact about the student) is not used. Facts are chosen by type priority, newest first within a type, and `claims` lists exactly the facts the body uses.
- **Register.** Finance, consulting, recruiters and a formal style card get the formal register (full name, short school name and class year in the sign-off; no contractions when the style card says so). LinkedIn messages sign with the first name. Schools are named the way students say them ("Cornell", "Michigan", "MIT").
- **Time.** Windows are real free slots from the student's calendar, on different days, one morning and one afternoon, at least 12 hours out, with a buffer around events, shown with weekday, date, time and the zone for that date. A time the other person proposed is accepted only if it is in the future and free; otherwise Orbit counter-proposes. A thank-you locates the meeting by its real date ("yesterday", "on Tuesday", "last week" only for the previous calendar week, otherwise the date, "on September 24"). A time they proposed that has passed is named with its date ("Thursday, Oct 1 at 11:30am has already passed"), and a meeting with them already on the calendar is confirmed, never moved.
- **New threads.** Outreach, intro requests and referral asks open a new thread with their own subject; every other kind replies in the existing thread, and without one it carries a subject written for its kind.
- **Referral ladder.** With no conversation on record, a referral ask is the first rung of the ladder in §2.11 (a process question), not a request.
- **Known contacts.** Outreach to someone who has written back to the student before picks that exchange up ("Thanks again for your note a few weeks ago", "We traded emails in May") and, when the last message is under six months old, replies in that thread. The student's target function is named only when it is the recipient's field too.
- **Answer the ask first.** When their reply asks for something (a resume, which teams, times), the scheduling reply answers it before proposing windows; a question goes to the student (`answer`). A booking link in their reply is used instead of the student's windows. The validator rejects a rewrite that drops a resume request.
- **Only what is in the data.** A thank-you states what they said ("Thank you for making time yesterday, and especially for your advice to ..."), never what the student felt or did about it ("I'm putting it to use this week"), which Orbit does not know. Openers never say how the student found the person ("found you on our alumni page", "came across your profile while researching ..."): an alum is written to as one ("I saw that you went from Cornell to Figma").
- **Job changes.** A LinkedIn re-import records a job change only when the company or the title really changed (case, spacing, legal suffixes and a level like "II" do not count). A new title at the same company is "your new role as ... at {org}", not "your move to {org}", and a change Orbit only noticed on import is not assumed to be recent ("Hope the first few weeks are going well" is left out).
- **Not now is not no.** A decline with a time limit ("not able to take calls this quarter") brings back one short second try after the window, quoting only what they said.
- **Promises.** An open action item the student took on in the conversation ("I will send my resume by Friday") is kept in the thank-you ("As promised, I'll ...").

---

## 8. Sources

Career centers and official guides:
https://upenn.imodules.com/s/1587/images/gid12/editor_documents/170423_alumni_outreach_tips.pdf ·
https://careered.stanford.edu/sites/g/files/sbiybj22801/files/media/file/how-to-connect-with-stanford-alumni.pdf ·
https://alumni.stanford.edu/career-connections/cold-contacting-an-alum-here-s-what-you-should-do ·
https://alumni.stanford.edu/career-connections/networking-tips-sheet/ ·
https://www.gsb.stanford.edu/alumni/career-resources/job-search/networking/email-best-practices ·
https://career.berkeley.edu/prepare-for-success/networking/5-point-message/ ·
https://career.berkeley.edu/start-exploring/informational-interviews/ ·
https://careercenter.umich.edu/content/networking-resources ·
https://alumni.umich.edu/career/guides/approach-emails-and-messages-templates/ ·
https://www.careereducation.columbia.edu/resources/tools-building-alumni-connections ·
https://careereducation.columbia.edu/resources/key-strategies-networking-and-informational-interviewing ·
https://ocs.yale.edu/resources/sample-emails-requesting-an-informational-interview/ ·
https://cdn-careerservices.fas.harvard.edu/wp-content/uploads/sites/161/2024/07/2024-HES-building-a-professional-network-edited.pdf ·
https://careerservices.fas.harvard.edu/resources/harvard-college-guide-to-making-connections/ ·
https://hls.harvard.edu/bernard-koteen-office-of-public-interest-advising/opia-job-search-toolkit/sample-networking-emails-and-thank-you-notes ·
https://www.cnbc.com/2024/06/24/harvard-career-advisor-how-to-ask-for-an-informational-interview-.html ·
https://careerdesign.dartmouth.edu/resources/networking-outreach-templates-sample-questions/ ·
https://career.cornell.edu/resources/informational-interviews/ ·
https://scl.cornell.edu/get-involved/career-services/networking/networking-step-step ·
https://gbpcareerservices.nd.edu/assets/205398/five_point_networking_email.pdf ·
https://www.training.nih.gov/oite-careers-blog/6-point-networking-email/ ·
https://careerhub.students.duke.edu/blog/2021/12/23/make-an-outreach-request-examples/ ·
https://mixedconclusions.com/blog/twohourjobsearch/ ·
https://www.kellogg.northwestern.edu/alumni/career-development/articles-videos-and-career-guides/article-using-email-to-network.aspx ·
https://careers.amherst.edu/blog/2022/09/30/how-to-write-networking-emails-that-get-opened/ ·
https://careerservices.upenn.edu/blog/2022/06/07/networking-101-what-to-say/ ·
https://careerservices.upenn.edu/blog/2021/02/07/investment-banking-insights-networking-to-enhance-your-chances-of-securing-an-interview-and-offer/ ·
https://economics.virginia.edu/coffee-chat-advice-networking-investment-banking-focused ·
https://www.lehigh.edu/~inluac/news/EYTips.html ·
https://huwib.com/recruiting-101 ·
https://80000hours.org/articles/email-scripts/

Finance practitioners and student clubs:
https://mergersandinquisitions.com/investment-banking-informational-interview/ ·
https://mergersandinquisitions.com/investment-banking-networking/ ·
https://mergersandinquisitions.com/how-to-cold-email-for-an-internship/ ·
https://www.wallstreetoasis.com/resources/templates/word-templates/cold-email-template ·
https://www.wallstreetoasis.com/forum/investment-banking/cold-email-advice-from-analyst ·
https://www.wallstreetoasis.com/forum/off-topic/thoughts-on-how-to-format-a-cold-email ·
https://www.wallstreetoasis.com/forum/investment-banking/what-kind-of-networking-cold-emails-do-you-respond-to ·
https://www.wallstreetoasis.com/forum/investment-banking/cold-email-tips ·
https://www.wallstreetoasis.com/forum/investment-banking/networking-emails-low-response-rates ·
https://www.wallstreetoasis.com/forum/investment-banking/want-to-get-me-on-the-phone-heres-how-a-networking-overview ·
https://www.wallstreetoasis.com/forum/investment-banking/some-thoughts-on-networking ·
https://www.wallstreetoasis.com/forum/investment-banking/do-better-with-your-cold-emails ·
https://www.wallstreetoasis.com/forum/investment-banking/networking-mail-templates-i-created-with-chatgpt ·
https://www.wallstreetoasis.com/forum/job-search/cringe-worthy-networking-mistakes-ive-seen-in-ib ·
https://www.wallstreetoasis.com/forum/investment-banking/guide-cold-contacting-investment-bankers-for-non-targets ·
https://www.wallstreetoasis.com/forum/investment-banking/alumni-cold-e-mail ·
https://www.wallstreetoasis.com/forum/job-search/cold-email-alumni-subject-line ·
https://www.wallstreetoasis.com/forum/investment-banking/response-rate-networking-with-alumni-email ·
https://www.wallstreetoasis.com/forum/investment-banking/to-those-working-in-ib-what-makes-you-feel-inclined-to-respond-to-a-cold ·
https://www.wallstreetoasis.com/forum/job-search/best-times-to-cold-email ·
https://www.wallstreetoasis.com/forum/investment-banking/when-is-the-best-time-to-email-a-banker ·
https://banking-at-michigan.squarespace.com/s/Email-Guide-for-IB-Recruitment-2.pdf ·
https://static1.squarespace.com/static/5b00e278a2772cd1d9f5d164/t/61e9b6194e435f13d9079eab/1642706458170/BAM+Email+Guide.pdf ·
https://www.peakframeworks.com/post/linkedin-etiquette ·
https://www.10xebitda.com/investment-banking-email-format/ ·
https://www.fe.training/free-resources/investment-banking/the-ultimate-investment-banking-cold-email-guide/ ·
https://wallstmastermind.com/cold-email-investment-banking/ ·
https://wallstmastermind.com/coffee-chat-follow-up-investment-banking/ ·
https://www.wallstreetplaybook.org/cold-email-templates-investment-banking ·
https://www.wallstreetplaybook.org/blog/cold-email-templates-that-get-bankers-to-respond ·
https://investmentbankacademy.com/investment-banking-networking-emails/ ·
https://ibinterviewquestions.com/blog/networking-email-templates-investment-banking ·
https://ibinterviewquestions.com/blog/networking-guide-investment-banking ·
https://ibinterviewquestions.com/blog/thank-you-email-after-investment-banking-interview ·
https://www.preplounge.com/en/blog/finance/investment-banking/interview/cold-email-ib ·
https://www.alma.careers/ ·
https://prospectrockpartners.com/15-students-just-sent-me-the-exact-same-cutting-your-teeth-in-finance-cold-email-lets-talk-about-ai-and-networking/ ·
https://leadhaste.com/blog/investment-banking-cold-email-template ·
https://iboffer.com/blog/investment-banking-networking-guide ·
https://www.inframail.io/blog-detail/investment-banking-cold-email-template ·
https://www.careerprinciples.com/resources/networking-cold-email-templates-to-land-a-finance-internship

Consulting:
https://www.preplounge.com/consulting-forum/should-i-ask-directly-for-a-referral-23264 ·
https://www.preplounge.com/consulting-forum/follow-up-on-networking-coffee-chat-request-11611 ·
https://www.preplounge.com/consulting-forum/not-getting-responses-from-linkedin-outreach-or-post-event-follow-ups-what-am-i-doing-wrong-24709 ·
https://www.preplounge.com/consulting-forum/cold-email-to-partner-you-admire-3241 ·
https://www.preplounge.com/consulting-forum/networking-and-getting-referral-on-linkedin-1217 ·
https://www.preplounge.com/consulting-forum/linkedin-vs-email-to-cold-reach-out-for-networking-20251 ·
https://www.preplounge.com/consulting-forum/how-to-request-for-the-second-coffee-chat-1286 ·
https://www.preplounge.com/consulting-forum/how-to-maintain-a-connection-16366 ·
https://www.preplounge.com/en/consulting-forum/referral-template-strategy-consulting-17054 ·
https://www.preplounge.com/consulting-forum/referral-process-at-mckinsey-20469 ·
https://www.glassdoor.com/Community/all-things-mbb/honest-question-how-do-you-like-to-be-asked-for-a-referral-after-a-coffee-chat-or-should-they-not-ask-at-alli-am-so-uncomfortable-asking ·
https://forum.thethinksters.com/t/when-is-it-okay-to-ask-for-a-referral-after-a-coffee-chat-and-how-do-you-phrase-it/3596 ·
https://www.teamblind.com/post/do-you-answer-requests-for-cold-callscoffee-chats-from-students-wcddgc3p ·
https://www.teamblind.com/post/responding-to-students-asking-for-referral-ztasetgf ·
https://www.hackingthecaseinterview.com/pages/consulting-cold-email-template ·
https://www.hackingthecaseinterview.com/pages/consulting-networking-email-template ·
https://www.hackingthecaseinterview.com/pages/linkedin-message-to-consultant ·
https://www.hackingthecaseinterview.com/pages/email-to-consulting-recruiter ·
https://www.hackingthecaseinterview.com/pages/consulting-coffee-chats ·
https://www.roadtooffer.com/blog/best-consulting-networking-email-templates ·
https://www.roadtooffer.com/blog/free-consulting-networking-follow-up-templates ·
https://www.roadtooffer.com/blog/consulting-referral-strategy-guide ·
https://www.roadtooffer.com/blog/consulting-coffee-chat-guide ·
https://www.roadtooffer.com/blog/consulting-networking-guide ·
https://strategycase.com/how-to-get-a-referral-for-mckinsey-bcg-bain/ ·
https://managementconsulted.com/consulting-networking/ ·
https://managementconsulted.com/coffee-chat-what-is-it-and-questions-to-ask/ ·
https://www.rocketblocks.me/guide/end-to-end.php ·
https://www.casebasix.com/pages/ask-referral-after-coffee-chat ·
https://www.offerloop.ai/coffee-chat/deloitte-digital ·
https://nextepmbb.com/en/networking-for-consulting-en/ ·
https://www.joinleland.com/library/a/consulting-coffee-chat-questions-how-to-make-the-most-of-your-coffee-chat ·
https://www.big4bound.com/big-4-from-non-target/ ·
https://igotanoffer.com/blogs/mckinsey-case-interview-blog/network-to-land-a-job-in-consulting

Tech:
https://github.com/spsokhi/off-campus-job-hunting ·
https://github.com/turingschool/career-development-curriculum/blob/master/session_archives/cold_outreach_i.md ·
https://github.com/turingschool/career-development-curriculum/blob/master/module_four/cold_outreach_guidelines.md ·
https://github.com/turingschool/career-development-curriculum/blob/master/session_archives/m4_old_outreach_networking_session.md ·
https://github.com/turingschool/career-development-curriculum/blob/master/module_three/outreach_networking_ii.md ·
https://github.com/turingschool/career-development-curriculum/blob/master/module_three/job_search_strategies.md ·
https://gist.github.com/katiestutts/f955c2e68698dabf5fd8a20e8bf67e65 ·
https://gist.github.com/aniarya82/994104f2104ac4728762 ·
https://gist.github.com/morriswong/9dce87a2973ca62ddd6eee5e3e52e22a ·
https://gist.github.com/TravnikovDev/996d1e684e33c85417eda683021de76a ·
https://www.teamblind.com/post/how-to-ask-for-a-referral-advice-from-an-engineering-manager-imeq6key ·
https://romantaylor.com/how-to-ask-for-a-referral-on-linkedin/ ·
https://www.tryexponent.com/blog/how-to-get-a-linkedin-referral ·
https://satakshigarg.medium.com/cold-email-message-template-i-use-ac7effa4556e ·
https://news.ycombinator.com/item?id=35797172

General, vendor and press:
https://www.forbes.com/sites/kimberlywhitler/2020/04/18/5-mistakes-students-make-when-using-email-to-network-and-how-to-avoiding-making-them/ ·
https://www.theladders.com/career-advice/networking-email-mistakes ·
https://carly.substack.com/p/how-to-write-a-cold-email ·
https://www.offerloop.ai/blog/alumni-networking-guide ·
https://whali.com/blog/networking-email-coffee-chat ·
https://joinhandshake.com/blog/career-centers/how-to-write-great-emails/ ·
https://pursuenetworking.com/blog/linkedin-coffee-chat-templates/ ·
https://www.reactin.io/blog/linkedin-connection-request-character-limit-2026 ·
https://www.saava.io/blog/linkedin-connection-request-message-examples

Method note: nearly every primary page was blocked by the research proxy; quotes were taken from search-engine snippets of the source text. Exemplars marked verbatim in the corpus are verbatim to the snippet; where a snippet was partial, the gap is noted in the corpus `notes` field. Re-fetch before citing a number as [VERIFIED].

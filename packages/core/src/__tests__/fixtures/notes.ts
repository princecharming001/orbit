import type { NotePerson } from '../../notes/extract';
import type { FactType } from '../../types';

/**
 * Twenty-five notes the way students actually capture them: Granola summaries (with and without a
 * transcript), voice dictation with no punctuation, pasted transcripts with speaker labels, and quick typed
 * notes. Each lists the facts and action items that must come out (third-person sentences with an explicit subject, the form the drafting engine turns into "you ...") and
 * things that must not.
 */
export interface NoteFixture {
  name: string;
  text: string;
  people: NotePerson[];
  userNames?: string[];
  facts?: { type: FactType; text: string | RegExp; about?: string }[];
  actions?: { text: string | RegExp; due?: RegExp }[];
  /** no offer may be recorded (the only promises are the student's) */
  noOffers?: boolean;
  /** substrings that must not appear in any fact or the summary */
  absent?: string[];
}

const PRIYA: NotePerson = { key: 'priya', first: 'Priya', last: 'Patel' };
const MAYA: NotePerson = { key: 'maya', first: 'Maya', last: 'Wu' };
const ELENA: NotePerson = { key: 'elena', first: 'Elena', last: 'Rodriguez' };
const TOM: NotePerson = { key: 'tom', first: 'Tom', last: 'Wu' };
const DANIEL: NotePerson = { key: 'dan', first: 'Daniel', last: 'Kim' };
const JOSE: NotePerson = { key: 'jose', first: 'José', last: 'Núñez' };
const RAVI = ['Ravi Jain'];

export const NOTES: NoteFixture[] = [
  // ---------- Granola-style ----------
  {
    name: 'granola summary with transcript',
    people: [PRIYA],
    userNames: RAVI,
    text: `Coffee chat with Priya Patel
Attendees: Priya Patel, Ravi Jain

Summary
Priya leads a small team on payments onboarding at Stripe. She recommended focusing on one concrete project story for interviews and said the key is showing how you handled ambiguity. They are hiring interns in January for the platform team. Priya offered to refer me when the posting goes up. I will send my resume by Friday and share the marketplace project link. She ran a marathon in April and grew up in Chicago.

Transcript
Priya Patel: So tell me about yourself.
Ravi Jain: I'm a junior at Michigan.`,
    facts: [
      { type: 'role_detail', text: 'Priya leads a small team on payments onboarding at Stripe' },
      { type: 'advice', text: 'She recommended focusing on one concrete project story for interviews' },
      { type: 'hook', text: 'They are hiring interns in January for the platform team' },
      { type: 'offer', text: 'Priya offered to refer me when the posting goes up' },
      { type: 'personal', text: 'She ran a marathon in April and grew up in Chicago' },
    ],
    actions: [{ text: 'Send my resume by Friday and share the marketplace project link', due: /friday/i }],
    absent: ['Attendees', 'Coffee chat with', 'tell me about yourself', 'junior at Michigan'],
  },
  {
    name: 'granola with key takeaways and action items sections',
    people: [ELENA],
    userNames: RAVI,
    text: `# Chat with Elena Rodriguez (Bain)
Date: Oct 2, 2026

## Key takeaways
- Elena works on healthcare cases out of the Boston office
- She said the case interview is mostly about structure, not math
- Recruiting for the summer associate role opens in July

## Action items
- Send Elena my resume by Monday
- Elena: intro to the recruiting coordinator`,
    facts: [
      { type: 'role_detail', text: 'Elena works on healthcare cases out of the Boston office' },
      { type: 'hook', text: /^Recruiting for the summer associate role opens in July$/ },
      { type: 'offer', text: 'They offered an intro to the recruiting coordinator' },
    ],
    actions: [{ text: 'Send Elena my resume by Monday', due: /monday/i }],
    absent: ['Date:', 'Key takeaways', 'Chat with Elena'],
  },
  {
    name: 'granola summary without a transcript, advice with a deadline',
    people: [ELENA],
    text: `Summary
Elena works on healthcare cases and recommended I apply by the early deadline in October. She grew up in Miami.`,
    facts: [
      { type: 'role_detail', text: 'Elena works on healthcare cases' },
      { type: 'advice', text: 'Elena recommended I apply by the early deadline in October' },
      { type: 'personal', text: 'She grew up in Miami' },
    ],
    actions: [{ text: 'Apply by the early deadline in October', due: /october/i }],
    noOffers: true,
  },
  {
    name: 'granola with "Notes" heading and the student\'s contractions',
    people: [DANIEL],
    userNames: RAVI,
    text: `Daniel Kim / Ravi
Notes
Daniel moved from Google to Stripe last year and works on the fraud team. I'll send him my portfolio tomorrow. I'll share the deck by Thursday. He suggested I talk to someone in risk ops too.`,
    facts: [
      { type: 'role_detail', text: /^Daniel moved from Google to Stripe last year/ },
      { type: 'advice', text: 'He suggested I talk to someone in risk ops too' },
    ],
    actions: [
      { text: 'Send him my portfolio tomorrow', due: /tomorrow/i },
      { text: 'Share the deck by Thursday', due: /thursday/i },
    ],
    noOffers: true,
  },
  {
    name: 'granola with two attendees, facts go to the right person',
    people: [ELENA, TOM],
    text: `Summary
Met with Elena Rodriguez and Tom Wu from Bain.
Elena works on healthcare cases. Tom said he'd intro me to the recruiting coordinator.
Tom moved to Boston last year. Elena grew up in Miami. He also plays in a jazz band.

Attendees: Elena Rodriguez, Tom Wu`,
    facts: [
      { type: 'role_detail', text: 'Elena works on healthcare cases', about: 'elena' },
      { type: 'offer', text: 'Tom offered to intro me to the recruiting coordinator', about: 'tom' },
      { type: 'personal', text: 'Tom moved to Boston last year', about: 'tom' },
      { type: 'personal', text: 'Elena grew up in Miami', about: 'elena' },
      { type: 'personal', text: 'He also plays in a jazz band', about: 'tom' },
    ],
    absent: ['Attendees'],
  },
  {
    name: 'granola bullets with a hook and personal detail',
    people: [MAYA],
    text: `Summary
• Maya is a product designer on the growth team at Figma
• Her team is launching a new onboarding flow next quarter
• She has a corgi named Mochi
• Recommended reading "Refactoring UI" before the design exercise`,
    facts: [
      { type: 'hook', text: 'Her team is launching a new onboarding flow next quarter' },
      { type: 'personal', text: /^She has a corgi named Mochi$/ },
      // the note calls Maya "she", so the subjectless line takes her pronoun
      { type: 'advice', text: 'She recommended reading "Refactoring UI" before the design exercise' },
    ],
  },
  {
    name: 'granola with next steps line',
    people: [PRIYA],
    text: `Coffee chat recap
Priya said the team values people who can write clearly. She's been at Stripe for four years.
Next steps: send Priya a thank-you note tonight`,
    facts: [
      { type: 'role_detail', text: 'She has been at Stripe for four years' },
      { type: 'advice', text: /^The team values people who can write clearly$/ },
    ],
    actions: [{ text: /thank-you note tonight/i, due: /tonight/i }],
    noOffers: true,
  },
  {
    name: 'granola, cool tone and no offer',
    people: [DANIEL],
    text: `Summary
Daniel is pretty busy this quarter and couldn't promise anything. He said the best way in is through the campus recruiting event in November. I need to register for the event by Oct 20.`,
    facts: [{ type: 'hook', text: /campus recruiting event in November/ }],
    actions: [{ text: 'Register for the event by Oct 20', due: /oct 20/i }],
    noOffers: true,
  },
  // ---------- dictated, no punctuation ----------
  {
    name: 'dictated voice note',
    people: [MAYA],
    text: `ok so just talked to maya from figma um she was pretty nice honestly said the new grad process opens in like august and she said she'd forward my resume to her recruiter if i send it over which i need to do by like tomorrow also she's from houston originally and the key thing for the interviews is to practice product sense cases`,
    facts: [
      { type: 'hook', text: 'The new grad process opens in August' },
      { type: 'offer', text: 'She offered to forward my resume to her recruiter if I send it over' },
      { type: 'personal', text: "She's from Houston originally" },
      { type: 'advice', text: 'The key thing for the interviews is to practice product sense cases' },
    ],
    actions: [{ text: 'Send my resume to Maya by tomorrow', due: /tomorrow/i }],
    absent: [' um ', ' like ', 'honestly'],
  },
  {
    name: 'dictated, student promises only',
    people: [TOM],
    text: `talked to tom wu for like twenty minutes he works on the data platform team at datadog um i need to send him my github link tonight and i should read the postmortem he mentioned`,
    facts: [{ type: 'role_detail', text: /^He works on the data platform team at datadog$/ }],
    actions: [{ text: /^Send him my github link tonight$/i, due: /tonight/i }],
    noOffers: true,
  },
  {
    name: 'dictated with an offer and hiring hook',
    people: [PRIYA],
    text: `quick note priya said they're hiring two interns for the payments team next summer and she offered to look over my resume before i apply also she grew up in austin and loves bouldering`,
    facts: [
      { type: 'hook', text: /^They're hiring two interns for the payments team next summer$/ },
      { type: 'offer', text: /^She offered to look over my resume before I apply$/ },
      { type: 'personal', text: /^She grew up in Austin and loves bouldering$/ },
    ],
  },
  {
    name: 'dictated with fillers and advice',
    people: [ELENA],
    text: `um so elena um basically told me to focus on networking with people in the healthcare practice and uh she also mentioned that the deadline for the early round is in september`,
    facts: [
      { type: 'advice', text: 'Elena told me to focus on networking with people in the healthcare practice' },
      { type: 'hook', text: 'The deadline for the early round is in September' },
    ],
    absent: ['um', 'uh', 'basically'],
  },
  {
    name: 'dictated in two sentences',
    people: [DANIEL],
    text: `Daniel was super helpful. he said he can refer me once the posting is live and that i should prep system design. i'm going to send him a thank you note tonight`,
    facts: [{ type: 'offer', text: 'He offered to refer me once the posting is live' }],
    actions: [{ text: /^Send him a thank you note tonight$/i, due: /tonight/i }],
  },
  {
    name: 'dictated, multiple people by first name',
    people: [ELENA, TOM],
    text: `met elena and tom at the bain info session elena said she'd introduce me to a consultant in the dc office and tom moved from chicago last month he's training for a marathon`,
    facts: [
      {
        type: 'offer',
        text: 'Elena offered to introduce me to a consultant in the DC office',
        about: 'elena',
      },
      { type: 'personal', text: /^Tom moved from Chicago last month$/, about: 'tom' },
      { type: 'personal', text: /^He's training for a marathon$/, about: 'tom' },
    ],
  },
  {
    name: 'dictated with "I owe"',
    people: [JOSE],
    text: `José runs the analytics team at Bain and I owe him my updated resume by Friday`,
    facts: [{ type: 'role_detail', text: 'José runs the analytics team at Bain' }],
    actions: [{ text: /resume by Friday/i, due: /friday/i }],
    noOffers: true,
  },
  // ---------- pasted transcripts with speaker labels ----------
  {
    name: 'transcript with speaker labels and no summary',
    people: [PRIYA],
    userNames: RAVI,
    text: `Coffee chat with Priya Patel
Attendees: Priya Patel, Ravi Jain
Priya Patel: That's great, we're actually hiring in January.
Ravi Jain: I'll send over my resume tonight and I'll follow up with Priya like you suggested.
Priya Patel: No guarantee of course, the process is pretty competitive, but I'll put in a good word.
Priya Patel: I lead a 6-person team on payments onboarding.`,
    facts: [
      { type: 'hook', text: "They're hiring in January" },
      { type: 'offer', text: 'They offered to put in a good word' },
      { type: 'role_detail', text: 'They lead a 6-person team on payments onboarding' },
    ],
    actions: [{ text: 'Send over my resume tonight', due: /tonight/i }, { text: 'Follow up with Priya' }],
    absent: ['Priya Patel:', 'Ravi Jain', 'Attendees', 'Coffee chat with'],
  },
  {
    name: 'transcript with timestamps',
    people: [MAYA],
    userNames: RAVI,
    text: `[00:01:12] Maya Wu: I've been at Figma for three years, mostly on the editor team.
[00:02:40] Ravi: That sounds amazing. I'll send you my case study this week.
[00:03:05] Maya Wu: Happy to review it and send you feedback.
[00:04:30] Maya Wu: You should apply early, the design internship closes in October.`,
    facts: [
      { type: 'role_detail', text: /^They have been at Figma for three years/ },
      { type: 'offer', text: /^They offered to review it and send me feedback$/ },
      { type: 'hook', text: /^The design internship closes in October$/ },
    ],
    actions: [{ text: /^Send you my case study this week$/, due: /this week/i }],
  },
  {
    name: 'transcript with Me/Them labels',
    people: [TOM],
    text: `Me: Thanks for making the time.
Them: Of course. I can connect you with our new grad recruiter if that helps.
Me: That would be great, I'll email you my resume tomorrow.
Them: I moved to Datadog from Square last spring.`,
    facts: [
      { type: 'offer', text: /^They offered to connect me with their new grad recruiter/ },
      { type: 'role_detail', text: 'They moved to Datadog from Square last spring' },
    ],
    actions: [{ text: /^Email you my resume tomorrow$/, due: /tomorrow/i }],
  },
  {
    name: 'transcript where only the student promises',
    people: [DANIEL],
    userNames: RAVI,
    text: `Daniel Kim: The fraud team works closely with risk ops.
Ravi Jain: I'll send you the write-up by Friday.
Ravi Jain: I can also share my notebook.`,
    facts: [{ type: 'role_detail', text: /^The fraud team works closely with risk ops$/ }],
    actions: [{ text: /^Send you the write-up by Friday$/, due: /friday/i }],
    noOffers: true,
  },
  {
    name: 'transcript with two counterparts',
    people: [ELENA, TOM],
    userNames: RAVI,
    text: `Elena Rodriguez: I work on healthcare cases.
Tom Wu: I can intro you to our recruiting coordinator.
Elena Rodriguez: I grew up in Miami.`,
    facts: [
      { type: 'role_detail', text: 'They work on healthcare cases', about: 'elena' },
      { type: 'offer', text: 'They offered to intro me to their recruiting coordinator', about: 'tom' },
      { type: 'personal', text: 'They grew up in Miami', about: 'elena' },
    ],
  },
  {
    name: 'transcript with a reschedule-free closing',
    people: [JOSE],
    userNames: RAVI,
    text: `José Núñez: My advice is to know the firm's last three deals cold.
Ravi Jain: Will do. I'll circle back after the superday.
José Núñez: We're launching a new healthcare fund next month.`,
    facts: [
      { type: 'advice', text: "They said I should know the firm's last three deals cold" },
      { type: 'hook', text: /^They're launching a new healthcare fund next month$/ },
    ],
    noOffers: true,
  },
  // ---------- quick typed notes ----------
  {
    name: 'typed note, the student promise with a contraction',
    people: [PRIYA],
    text: `I'll send my resume by Friday.`,
    actions: [{ text: 'Send my resume by Friday', due: /friday/i }],
    noOffers: true,
  },
  {
    name: 'typed note, advice is not an action item',
    people: [MAYA],
    text: `She recommended I apply to the APM program.`,
    facts: [{ type: 'advice', text: 'She recommended I apply to the APM program' }],
    actions: [],
  },
  {
    name: 'typed note with the demo phrasing',
    people: [DANIEL],
    text: `Daniel said the team is launching a new product in November and would love to hear what I think after it ships. Recommended reading "Working Backwards". Happy to intro me to their PM lead.`,
    facts: [
      { type: 'hook', text: /^The team is launching a new product in November/ },
      { type: 'advice', text: 'They recommended reading "Working Backwards"' },
      { type: 'offer', text: 'They offered to intro me to their PM lead' },
    ],
  },
  {
    name: 'typed note in the third person with a name',
    people: [JOSE],
    text: `José leads the healthcare coverage group. He studied economics at Michigan, so we have that in common. He thinks I should learn to read a 10-K before the interview.`,
    facts: [
      { type: 'role_detail', text: 'José leads the healthcare coverage group' },
      { type: 'personal', text: /^He studied economics at Michigan/ },
      { type: 'advice', text: 'He thinks I should learn to read a 10-K before the interview' },
    ],
  },
];

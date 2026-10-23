/**
 * The accounts the offline simulation runs against. `demo` is the sample student (Alex). `student` is a fresh,
 * real-looking account built the way a student's own data arrives: a profile from onboarding, Gmail threads replayed
 * through the real ingest on their own clocks (a booked chat tomorrow, a chat that happened last week, a cold email
 * that went quiet, a recruiter's note, a classmate, a newsletter), calendar invites, LinkedIn connections from a
 * Connections.csv export, a resume, a meeting note, goals and target companies. The `student-*` variants leave out
 * Gmail or LinkedIn, and `empty` has a profile and nothing else.
 */
import type { User } from '@orbit/core';
import { recomputeAllStrengths, setCurrentUserId } from '../../../../db/repo';
import { db, wipeDatabase } from '../../../../db/schema';
import { createLocalUser } from '../../../../engine/account';
import { generateBrief, recommendationsRefresh } from '../../../../engine/brief';
import { loadDemo } from '../../../../engine/demo';
import { saveGoal } from '../../../../engine/goals';
import { recomputeEdges } from '../../../../engine/graph';
import { ingestEmails, ingestEvents, type RawEmail, type RawEvent } from '../../../../engine/ingest';
import { recordLinkedInImport } from '../../../../engine/integrations';
import { importConnectionsCsv } from '../../../../engine/linkedin';
import { ingestNote } from '../../../../engine/notes';
import { saveResume } from '../../../../engine/resume';
import { addTargetCompanies } from '../../../../engine/targets';
import { NOW } from '../../helpers';

export type AccountId = 'demo' | 'student' | 'student-nogmail' | 'student-nolinkedin' | 'empty';

const ME = 'riley.chen@umich.edu';
const SIG = '\n\nBest,\nRiley Chen\nUniversity of Michigan, B.S. Computer Science 2027';

/** A day relative to NOW at a local time, as an ISO string. */
function at(daysAgo: number, hour = 10, minute = 0): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

let seq = 0;
function mail(
  thread: string,
  from: string,
  to: string,
  sentAt: string,
  subject: string,
  body: string,
  opts: { cc?: string[]; labels?: string[]; headers?: Record<string, string> } = {},
): RawEmail {
  const id = `sim-${thread}-${++seq}`;
  return {
    externalMessageId: id,
    externalThreadId: `thr-${thread}`,
    from,
    to: [to],
    cc: opts.cc ?? [],
    subject,
    sentAt,
    bodyText: body,
    headers: { 'message-id': `<${id}@mail.sim>`, ...(opts.headers ?? {}) },
    labels: opts.labels ?? (from.includes(ME) ? ['SENT'] : ['INBOX']),
  };
}

const RILEY = `Riley Chen <${ME}>`;
const PRIYA = 'Priya Raman <priya.raman@stripe.com>';
const TOMAS = 'Tomás Herrera <tomas.herrera@makenotion.com>';
const KELLY = 'Kelly Morgan <kelly.morgan@stripe.com>';
const AVA = 'Ava Thompson <ava.thompson@makenotion.com>';
const TOM = 'Tom Becker <tbecker@umich.edu>';

/** Gmail as it would arrive: each message on its own clock, in order. */
export function studentMail(): RawEmail[] {
  return [
    // a mentor from last summer: a warm thread over months
    mail(
      'ava',
      AVA,
      ME,
      at(160, 9),
      'Great working with you this summer',
      'Hi Riley,\n\nIt was great having you shadow our team. Keep me posted on recruiting, and reach out any time.\n\nAva',
    ),
    mail(
      'ava',
      RILEY,
      'ava.thompson@makenotion.com',
      at(159, 18),
      'Re: Great working with you this summer',
      `Thanks so much Ava, I learned a ton watching how you run planning. I will keep you posted.${SIG}`,
    ),
    mail(
      'ava2',
      RILEY,
      'ava.thompson@makenotion.com',
      at(70, 11),
      'Quick update from Michigan',
      `Hi Ava,\n\nQuick update: I finished my PM internship at Domino's and I'm starting PM recruiting this fall. Your advice about writing specs helped a lot.${SIG}`,
    ),
    mail(
      'ava2',
      AVA,
      ME,
      at(69, 8),
      'Re: Quick update from Michigan',
      'So glad to hear it Riley. Happy to look at your resume before applications open.\n\nAva',
    ),
    // a PM at Stripe: cold email, a reply with a time, and an invite for tomorrow
    mail(
      'priya',
      RILEY,
      'priya.raman@stripe.com',
      at(14, 10),
      'Michigan student curious about PM at Stripe',
      `Hi Priya,\n\nI'm a CS junior at Michigan and saw your talk on Stripe's billing roadmap. I'm recruiting for PM internships and would love 20 minutes to hear how you moved from engineering into product.\n\nWould you have time in the next couple of weeks?${SIG}`,
    ),
    mail(
      'priya',
      PRIYA,
      ME,
      at(12, 15),
      'Re: Michigan student curious about PM at Stripe',
      'Hi Riley,\n\nHappy to chat, Go Blue. Does Wednesday Oct 7 at 2pm ET work? I will send an invite.\n\nPriya',
    ),
    mail(
      'priya',
      RILEY,
      'priya.raman@stripe.com',
      at(12, 17),
      'Re: Michigan student curious about PM at Stripe',
      `Wednesday at 2pm works great, thank you Priya. Talk then.${SIG}`,
    ),
    // a designer at Figma: a cold email that went quiet
    mail(
      'marcus',
      RILEY,
      'marcus.lee@figma.com',
      at(11, 9),
      'Question about design and PM at Figma',
      `Hi Marcus,\n\nI'm a CS junior at Michigan exploring product roles. I loved your post on how Figma runs design critiques. Would you have 15 minutes to talk about how designers and PMs split the work at Figma?${SIG}`,
    ),
    // an APM at Notion: a chat last Friday, no thank-you yet
    mail(
      'tomas',
      RILEY,
      'tomas.herrera@makenotion.com',
      at(20, 10),
      'Notion APM program question',
      `Hi Tomás,\n\nI'm a CS junior at Michigan and I'm weighing Notion's APM program. Could I ask you a few questions about it over a 20 minute call?${SIG}`,
    ),
    mail(
      'tomas',
      TOMAS,
      ME,
      at(19, 13),
      'Re: Notion APM program question',
      'Hey Riley,\n\nSure thing. How about Friday Oct 2 at 3pm ET?\n\nTomás',
    ),
    mail(
      'tomas',
      RILEY,
      'tomas.herrera@makenotion.com',
      at(19, 15),
      'Re: Notion APM program question',
      `Friday at 3pm works, thank you.${SIG}`,
    ),
    // a recruiter wrote first
    mail(
      'kelly',
      KELLY,
      ME,
      at(5, 11),
      'Stripe PM intern info session on Oct 9',
      'Hi Riley,\n\nI saw you are interested in product at Stripe. We are hosting a virtual info session for PM interns on Oct 9. Let me know if you would like an invite.\n\nKelly Morgan\nUniversity Recruiting, Stripe',
    ),
    // a classmate and a newsletter: not networking
    mail(
      'tom',
      TOM,
      ME,
      at(3, 22),
      'EECS 281 notes',
      'yo do you have the notes from tuesday lecture? midterm is next week\n\ntom',
    ),
    mail(
      'handshake',
      'Handshake <no-reply@joinhandshake.com>',
      ME,
      at(2, 7),
      '12 new jobs match your profile',
      'New jobs for you this week. Unsubscribe at any time.',
      { headers: { 'list-unsubscribe': '<mailto:unsub@joinhandshake.com>' } },
    ),
  ];
}

/** The calendar: the chat with Tomás last Friday and the chat with Priya tomorrow. */
export function studentEvents(): { at: string; event: RawEvent }[] {
  const tomasStart = at(4, 15);
  const tomasEnd = at(4, 15, 30);
  const priyaStart = at(-1, 14);
  const priyaEnd = at(-1, 14, 30);
  return [
    {
      at: at(19, 16),
      event: {
        externalEventId: 'evt-tomas',
        title: 'Riley / Tomás coffee chat',
        startAt: tomasStart,
        endAt: tomasEnd,
        status: 'confirmed',
        createdAt: at(19, 16),
        attendees: [
          { email: ME, self: true, responseStatus: 'accepted' },
          { email: 'tomas.herrera@makenotion.com', displayName: 'Tomás Herrera', responseStatus: 'accepted' },
        ],
        conferenceUrl: 'https://meet.google.com/abc-defg-hij',
      },
    },
    {
      at: new Date(Date.parse(tomasEnd) + 16 * 60_000).toISOString(),
      event: {
        externalEventId: 'evt-tomas',
        title: 'Riley / Tomás coffee chat',
        startAt: tomasStart,
        endAt: tomasEnd,
        status: 'confirmed',
        createdAt: at(19, 16),
        attendees: [
          { email: ME, self: true, responseStatus: 'accepted' },
          { email: 'tomas.herrera@makenotion.com', displayName: 'Tomás Herrera', responseStatus: 'accepted' },
        ],
      },
    },
    {
      at: at(12, 18),
      event: {
        externalEventId: 'evt-priya',
        title: 'Coffee chat: Priya / Riley',
        startAt: priyaStart,
        endAt: priyaEnd,
        status: 'confirmed',
        createdAt: at(12, 18),
        attendees: [
          { email: ME, self: true, responseStatus: 'accepted' },
          { email: 'priya.raman@stripe.com', displayName: 'Priya Raman', responseStatus: 'accepted' },
        ],
        conferenceUrl: 'https://zoom.us/j/123456789',
      },
    },
  ];
}

/** Connections.csv from LinkedIn's data export, preamble and all. */
export const STUDENT_CONNECTIONS_CSV = [
  'Notes:',
  '"When exporting your connection data, you may notice that some of the email addresses are missing."',
  '',
  'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
  'Priya,Raman,https://www.linkedin.com/in/priyaraman,,Stripe,Product Manager,25 Sep 2026',
  'Aisha,Khan,https://www.linkedin.com/in/aishakhan-umich,,Stripe,Software Engineer,03 Nov 2025',
  'Jake,Morrison,https://www.linkedin.com/in/jakemorrison,,Stripe,Senior Product Manager,12 Jun 2024',
  'Lauren,Park,https://www.linkedin.com/in/laurenpark,,Figma,Product Manager,14 Feb 2025',
  'Ben,Carter,https://www.linkedin.com/in/bencarter,,Evercore,Investment Banking Analyst,20 Aug 2025',
  'Sofia,Rossi,https://www.linkedin.com/in/sofiarossi,,Airbnb,Data Scientist,02 Oct 2024',
  'Nate,Wilson,https://www.linkedin.com/in/natewilson,,Loop Labs,Founder,15 Jan 2026',
  'Ava,Thompson,https://www.linkedin.com/in/avathompson,ava.thompson@makenotion.com,Notion,Senior Product Manager,30 May 2026',
  'Chris,Nguyen,https://www.linkedin.com/in/chrisnguyen,,Google,Associate Product Manager,30 May 2025',
  'Rachel,Kim,https://www.linkedin.com/in/rachelkim,,Notion,Product Designer,09 Sep 2025',
  'Omar,Farouk,https://www.linkedin.com/in/omarfarouk,,Ramp,Software Engineer,03 Mar 2026',
  'Grace,Liu,https://www.linkedin.com/in/graceliu,,Figma,Engineering Manager,01 Dec 2024',
  'Priya,Shah,https://www.linkedin.com/in/priyashah,,Google,Software Engineer,18 Mar 2025',
  "Kevin,O'Brien,https://www.linkedin.com/in/kevinobrien,,Datadog,Site Reliability Engineer,09 Sep 2024",
  'Zoë,Martin,https://www.linkedin.com/in/zoemartin,,Figma,Product Designer,07 Jul 2025',
].join('\n');

export const STUDENT_RESUME = `Riley Chen
riley.chen@umich.edu | (734) 555-0142 | linkedin.com/in/rileychen

EDUCATION
University of Michigan, Ann Arbor, MI
B.S. in Computer Science, Minor in Economics. Expected May 2027. GPA 3.8

EXPERIENCE
Product Management Intern, Domino's, Ann Arbor, MI. June 2026 to August 2026
- Led discovery for the order-tracking redesign; interviewed 30 customers and wrote the spec
- Shipped an A/B test on delivery-time estimates that cut support tickets by 12%

Software Engineering Intern, Duo Security, Ann Arbor, MI. May 2025 to August 2025
- Built an internal dashboard for device-health alerts in React and Go

PROJECTS
StudySync: a study-group scheduler used by 400 Michigan students

LEADERSHIP
V1 Michigan, Product Lead

SKILLS
SQL, Python, Figma, A/B testing, user interviews
`;

const NOTE_TOMAS = `Coffee chat with Tomás Herrera (Notion APM), Oct 2.
- The Notion APM team cares a lot about writing: bring a writing sample.
- He suggested I talk to Jake Morrison at Stripe about platform PM.
- He offered to refer me when APM applications open in November.
- Follow up: send him my StudySync spec.`;

export interface Seeded {
  user: User;
  /** the account's people, by display name, for expectations */
  person: (name: string) => string;
}

async function finish(user: User): Promise<void> {
  await recomputeAllStrengths(user.id, NOW);
  await recomputeEdges(user.id);
  await recommendationsRefresh(user, NOW);
  await generateBrief(user, 'welcome', NOW);
}

/** The real-looking student, with or without Gmail and LinkedIn. */
async function seedStudent(opts: { gmail: boolean; linkedin: boolean }): Promise<User> {
  await wipeDatabase();
  const user = await createLocalUser({
    fullName: 'Riley Chen',
    firstName: 'Riley',
    lastName: 'Chen',
    email: ME,
    school: 'University of Michigan',
    schoolDomain: 'umich.edu',
    graduationYear: 2027,
    degree: 'B.S.',
    majors: ['Computer Science'],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
    onboardingStep: 11,
    onboardingCompletedAt: new Date(Date.parse(at(200))).toISOString(),
    createdAt: at(200),
  });
  await setCurrentUserId(user.id);
  await db.goals.put({
    userId: user.id,
    cycleLabel: 'Summer 2027 internships',
    targetRoles: ['Product Manager intern', 'Associate Product Manager'],
    targetFunctions: ['Product'],
    targetIndustries: ['Software', 'Fintech'],
    targetLocations: ['San Francisco', 'New York'],
    ambition: 2,
  });
  await saveGoal(
    user,
    {
      kind: 'recruiting',
      title: 'PM internship for summer 2027',
      targets: {
        organizations: ['Stripe', 'Figma', 'Notion'],
        roles: ['Product Manager'],
        geographies: [],
        people: [],
      },
      source: 'onboarding',
    },
    new Date(at(200)),
  );
  await addTargetCompanies(user.id, 'Stripe, Figma, Notion');
  if (opts.gmail) {
    await db.integrations.put({
      id: 'int_sim_google',
      userId: user.id,
      provider: 'google',
      externalAccountId: ME,
      status: 'active',
      scopes: ['gmail.readonly', 'gmail.send', 'calendar.readonly'],
      syncState: {},
      connectedAt: at(200),
      lastSyncedAt: NOW.toISOString(),
    });
    // the first sync after connecting Google reads the whole history at once, the way a new student's does
    await ingestEmails(user, studentMail(), { useLlm: false, now: NOW });
    const events = new Map(studentEvents().map((e) => [e.event.externalEventId, e.event]));
    await ingestEvents(user, [...events.values()], NOW);
  }
  if (opts.linkedin) {
    const r = await importConnectionsCsv(user, STUDENT_CONNECTIONS_CSV);
    await recordLinkedInImport(user.id, r.imported + r.updated, new Date(at(30)));
  }
  const file = new File([STUDENT_RESUME], 'Riley_Chen_Resume.txt', { type: 'text/plain' });
  await saveResume(user, file);
  if (opts.gmail) {
    const tomas = (await db.people.where('userId').equals(user.id).toArray()).find((p) =>
      p.displayName.startsWith('Tomás'),
    );
    await ingestNote(
      user,
      {
        text: NOTE_TOMAS,
        source: 'manual',
        personIds: tomas ? [tomas.id] : [],
        occurredAt: at(4, 16),
        title: 'Chat with Tomás',
      },
      NOW,
    );
  }
  await finish(user);
  return (await db.users.get(user.id)) ?? user;
}

async function seedEmpty(): Promise<User> {
  await wipeDatabase();
  const user = await createLocalUser({
    fullName: 'Jordan Lee',
    firstName: 'Jordan',
    lastName: 'Lee',
    school: 'Cornell University',
    graduationYear: 2027,
    onboardingStep: 11,
    onboardingCompletedAt: NOW.toISOString(),
  });
  await setCurrentUserId(user.id);
  return user;
}

export async function seedAccount(id: AccountId): Promise<User> {
  switch (id) {
    case 'demo':
      return loadDemo({ reset: true, now: NOW });
    case 'student':
      return seedStudent({ gmail: true, linkedin: true });
    case 'student-nogmail':
      return seedStudent({ gmail: false, linkedin: true });
    case 'student-nolinkedin':
      return seedStudent({ gmail: true, linkedin: false });
    case 'empty':
      return seedEmpty();
  }
}

/** Every row of every table, to put the account back exactly between threads. */
export type DbSnapshot = Record<string, unknown[]>;

export async function snapshotDb(): Promise<DbSnapshot> {
  const out: DbSnapshot = {};
  for (const t of db.tables) out[t.name] = await t.toArray();
  return out;
}

/** Tables written since the last restore: only those are put back, so a read-only run costs nothing to undo. */
const touched = new Set<string>();
let watching = false;
export function watchWrites(): void {
  if (watching) return;
  watching = true;
  for (const t of db.tables) {
    const mark = () => {
      touched.add(t.name);
    };
    t.hook('creating', mark);
    t.hook('updating', mark);
    t.hook('deleting', mark);
  }
}

export async function restoreDb(s: DbSnapshot, all = false): Promise<void> {
  const tables = db.tables.filter((t) => all || !watching || touched.has(t.name));
  if (tables.length)
    await db.transaction('rw', tables, async () => {
      for (const t of tables) {
        await t.clear();
        const rows = s[t.name];
        if (rows?.length) await t.bulkPut(rows as never[]);
      }
    });
  touched.clear();
}

/** Forget the writes so far (after seeding, before the first snapshot). */
export function clearTouched(): void {
  touched.clear();
}

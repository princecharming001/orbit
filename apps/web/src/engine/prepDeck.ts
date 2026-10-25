// The Prep deck (docs/plan/22-prep-deck.md): everything for a call, one card at a time, in the order the call runs.
// Pure: the person page gathers the rows, this decides which cards exist, what each says and where the deck opens.
// It never invents a line: every line comes from a stored row, the research brief (with its source numbers) or
// buildPrep, and a card with nothing to say is left out, except the few every call needs.
import type { Affiliation, Person } from '@orbit/core';
import type { JobChange } from './enrichment/store';
import type { PrepPlan } from './prep';
import type { DossierView } from './research';
import { byRecency, monthYear, roleDates } from './roleDates';

export type PrepCardKind =
  | 'call'
  | 'who'
  | 'lately'
  | 'shared'
  | 'left_off'
  | 'intro'
  | 'openers'
  | 'questions'
  | 'careful'
  | 'after';

export interface PrepLine {
  text: string;
  /** a small grey label before the text ("Now", "Oct 12") */
  label?: string;
  /** the research brief's source numbers it came from */
  sources?: number[];
  /** a link the line opens (a post, their LinkedIn, the join link) */
  href?: string;
  /** a person in Orbit the line names, whose page it opens */
  personId?: string;
  /** a company or school logo beside the line */
  org?: { name: string; id?: string };
  /** grey and smaller: context rather than content */
  muted?: boolean;
  /** grey text after the line (a role's dates) */
  detail?: string;
}

export interface PrepCard {
  kind: PrepCardKind;
  title: string;
  /** one line under the title that frames the card */
  lead?: string;
  lines: PrepLine[];
  /** a second group under its own small heading (Lately's posts, Who's schools) */
  more?: { heading: string; lines: PrepLine[] };
}

export interface PrepDeck {
  cards: PrepCard[];
  /** the card the deck opens on: the cover, or After the call once the chat has happened */
  start: number;
  /** the research brief's sources, by number, for the [n] marks */
  sources: { n: number; url?: string; title?: string; demo?: boolean }[];
}

export interface PrepDeckInput {
  person: Pick<
    Person,
    | 'firstName'
    | 'displayName'
    | 'headline'
    | 'currentTitle'
    | 'currentOrganizationRaw'
    | 'currentOrganizationId'
    | 'location'
    | 'isAlumni'
    | 'linkedinUrl'
    | 'doNotContact'
  >;
  user: { school?: string };
  plan: PrepPlan;
  now: Date;
  /** the next calendar event with them, or the one that just ended */
  event?: { startAt: string; endAt?: string; conferenceUrl?: string };
  chat?: { stage: string; completedAt?: string };
  /** their affiliations (LinkedIn's own when Orbit has read them) */
  affiliations: Affiliation[];
  /** the research brief, when there is one */
  brief?: DossierView;
  /** their latest LinkedIn posts Orbit has already read (never read for the deck) */
  posts?: { id: string; at?: string }[];
  jobChange?: JobChange;
  /** the mutuals who know them best, strongest first */
  mutuals?: { personId: string; name: string; phrase: string }[];
  /** the student's own past employers and schools, to say what they share */
  mine?: { orgs: string[] };
  /** everything that happened between them, newest first */
  timeline: { at: string; text: string }[];
  openItems: { text: string }[];
  facts: { type: string; text: string }[];
  /** "Oct 12", "today": the page's own wording for dates */
  when: (iso: string) => string;
}

const STAGES_AFTER = new Set(['completed', 'followed_up', 'nurturing']);
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const postUrl = (id: string) =>
  /^\d+$/.test(id) ? `https://www.linkedin.com/feed/update/urn:li:activity:${id}/` : undefined;

/** The deck for a call with this person. */
export function buildPrepDeck(x: PrepDeckInput): PrepDeck {
  const { person, plan, brief } = x;
  const first = person.firstName || person.displayName;
  const cards: PrepCard[] = [];

  // 1. The call: when, the goal and the one ask
  const ev = x.event;
  cards.push({
    kind: 'call',
    title: `Your chat with ${first}`,
    lead: plan.logistics ? plan.logistics.when : 'No time set yet.',
    lines: [
      ...(ev?.conferenceUrl ? [{ text: 'Join link', href: ev.conferenceUrl, label: 'Call' }] : []),
      { label: 'Your goal', text: plan.goal },
      { label: 'Your one ask', text: plan.ask },
    ],
  });

  // 2. Who they are: the headline, the last three roles with years, school, city, the brief's one line
  const work = x.affiliations.filter((a) => a.kind === 'employment').sort(byRecency);
  const schools = x.affiliations.filter((a) => a.kind === 'education').sort(byRecency);
  const position =
    person.headline ?? [person.currentTitle, person.currentOrganizationRaw].filter(Boolean).join(' at ');
  cards.push({
    kind: 'who',
    title: 'Who they are',
    lead: [position, person.location].filter(Boolean).join(' · ') || undefined,
    lines: [
      ...(brief?.who ? [{ text: brief.who }] : []),
      ...work.slice(0, 3).map((a) => ({
        text: [a.title, a.nameRaw].filter(Boolean).join(', '),
        detail: roleDates(a),
        label: a.isCurrent ? 'Now' : undefined,
        org: { name: a.nameRaw, id: a.organizationId },
      })),
    ],
    more: schools.length
      ? {
          heading: 'School',
          lines: schools.slice(0, 2).map((a) => ({
            text: [a.nameRaw, [a.degree, a.field].filter(Boolean).join(', ')].filter(Boolean).join(' · '),
            org: { name: a.nameRaw, id: a.organizationId },
            label:
              person.isAlumni && x.user.school && norm(a.nameRaw) === norm(x.user.school)
                ? 'You went here too'
                : undefined,
          })),
        }
      : undefined,
  });

  // 3. Lately: the brief's recent items, a job change Orbit saw, their latest posts
  const lately: PrepLine[] = [
    ...(x.jobChange?.to.company
      ? [
          {
            label: monthYear(x.jobChange.startedAt),
            text: `Moved to ${x.jobChange.to.company}${x.jobChange.to.title ? ` as ${x.jobChange.to.title}` : ''}${x.jobChange.from.company ? `, from ${x.jobChange.from.company}` : ''}.`,
          },
        ]
      : []),
    ...(brief?.recently ?? []).slice(0, 3).map((r) => ({ text: r.text, label: r.date, sources: r.sources })),
  ];
  const posts = (x.posts ?? [])
    .filter((p) => p.at)
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
    .slice(0, 3);
  cards.push({
    kind: 'lately',
    title: 'Lately',
    lead:
      lately.length || posts.length
        ? undefined
        : brief
          ? 'Nothing public lately; the call leans on what they tell you.'
          : `No research on ${first} yet. Deep research on their About tab looks them up on the web.`,
    lines: lately,
    more: posts.length
      ? {
          heading: 'Their posts on LinkedIn',
          lines: posts.map((p) => ({ text: `Posted ${x.when(p.at!)}`, href: postUrl(p.id) })),
        }
      : undefined,
  });

  // 4. What you share: the brief's common ground, school, past employers, the mutuals who know them best
  const shared: PrepLine[] = [...(brief?.inCommon ?? []).map((c) => ({ text: c.text, sources: c.sources }))];
  if (person.isAlumni && x.user.school && !shared.some((l) => l.text.includes(x.user.school!)))
    shared.push({ text: `You both went to ${x.user.school}.` });
  const mine = new Set((x.mine?.orgs ?? []).map(norm));
  for (const a of work) {
    if (mine.has(norm(a.nameRaw)) && !shared.some((l) => l.text.includes(a.nameRaw)))
      shared.push({
        text: `You both worked at ${a.nameRaw}.`,
        org: { name: a.nameRaw, id: a.organizationId },
      });
  }
  for (const m of (x.mutuals ?? []).slice(0, 3))
    shared.push({ text: `${m.name} ${m.phrase}`, personId: m.personId, label: 'Mutual' });
  if (shared.length) cards.push({ kind: 'shared', title: 'What you share', lines: shared });

  // 5. Where you left off: the last three things, what you owe them, what they told you
  const seen = new Set<string>();
  const last = x.timeline.filter((t) => !seen.has(t.text) && seen.add(t.text)).slice(0, 3);
  const told = x.facts.filter((f) => f.type === 'advice' || f.type === 'personal').slice(0, 4);
  const leftOff: PrepLine[] = [
    ...last.map((t) => ({ label: x.when(t.at), text: t.text })),
    ...x.openItems.slice(0, 3).map((i) => ({ label: 'You owe them', text: i.text })),
    ...told.map((f) => ({ label: f.type === 'advice' ? 'Their advice' : 'They told you', text: f.text })),
  ];
  if (leftOff.length) cards.push({ kind: 'left_off', title: 'Where you left off', lines: leftOff });

  // 6. The 30-second intro
  cards.push({
    kind: 'intro',
    title: 'Your 30-second intro',
    lead: plan.intro ? 'Say it out loud once before the call.' : undefined,
    lines: [
      ...(plan.intro ? [{ text: plan.intro }] : []),
      ...(plan.introMissing ? [{ text: plan.introMissing, muted: true }] : []),
    ],
  });

  // 7. Openers: the brief's, fully supported only, then what to read first
  const openers: PrepLine[] = (brief?.openers ?? [])
    .filter((o) => o.support !== 'partial')
    .map((o) => ({ text: `“${o.text}”`, sources: o.sources }));
  const reading = plan.research.map((r) => ({ text: r.label, href: r.url, label: 'Read' }));
  if (openers.length || reading.length)
    cards.push({
      kind: 'openers',
      title: 'Openers',
      lead: openers.length ? undefined : 'Nothing to open with from research yet. A look at these helps.',
      lines: [...openers, ...reading],
    });

  // 8. Questions: picked on the card itself (the renderer keeps the picks on the chat)
  cards.push({
    kind: 'questions',
    title: 'Questions to ask',
    lines: plan.questions.map((q) => ({ text: q })),
  });

  // 9. Careful: company context from the brief, how to pitch it to this person, a do-not-contact flag
  const careful: PrepLine[] = [
    ...(person.doNotContact ? [{ text: `You marked ${first} as do not contact.`, label: 'Note' }] : []),
    ...(brief?.carefulClaims.length
      ? brief.carefulClaims.map((c) => ({ text: c.text, sources: c.sources }))
      : (brief?.careful ?? []).map((t) => ({ text: t }))),
    ...plan.logisticsTips.map((t) => ({ text: t, muted: true })),
  ];
  if (careful.length) cards.push({ kind: 'careful', title: 'Keep in mind', lines: careful });

  // 10. After the call
  cards.push({
    kind: 'after',
    title: 'After the call',
    lines: plan.followUps.map((f) => ({ text: f })),
  });

  // the chat has happened (or its time has passed): the deck opens on what to do now
  const ended = !!ev?.endAt && new Date(ev.endAt).getTime() < x.now.getTime();
  const happened = !!x.chat?.completedAt || STAGES_AFTER.has(x.chat?.stage ?? '') || ended;
  return {
    cards,
    start: happened ? cards.length - 1 : 0,
    sources: brief?.sources ?? [],
  };
}

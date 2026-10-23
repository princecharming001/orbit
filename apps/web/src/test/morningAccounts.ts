/**
 * Made-up accounts of every shape for the morning brief's tests: a seeded generator, so every run builds the same
 * ones. Each account is written straight into the (fake) database under its own user, so hundreds fit in one run.
 */
import type {
  Brief,
  CalendarEvent,
  ChatStage,
  CoffeeChat,
  EmailThread,
  MergeSuggestion,
  OutboundMessage,
  Person,
  PersonSource,
  Recommendation,
  StageEvent,
  Suggestion,
  SuggestionKind,
  User,
  UserSettings,
} from '@orbit/core';
import { db } from '../db/schema';
import { isMessageSuggestion } from '../engine/brief';

// ---------- a seeded random source, so every run builds the same accounts ----------

export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    chance: (p: number) => next() < p,
  };
}

const FIRST = [
  'Maya',
  'Omar',
  'Lena',
  'Caleb',
  'Priya',
  'Jordan',
  'Ravi',
  'Hannah',
  'Felix',
  'Noah',
  'Ana',
  "D'Andre",
];
const LAST = [
  'Chen',
  'Haddad',
  'Novak',
  'Weber',
  'Shah',
  'Lee',
  'Jain',
  'Brooks',
  'Adeyemi',
  'Kim',
  "O'Neil",
];
const LONG_FIRST = 'Maximiliana-Josephine';
const LONG_LAST = 'Konstantinopoulou-Vanderbergh de la Cruz';
const ORGS = ['Stripe', 'Figma', 'Notion', 'Goldman Sachs', 'McKinsey', 'Ramp', undefined];
const TITLES = ['Software Engineer', 'Product Manager', 'Analyst', 'Associate', undefined];
export const KINDS: SuggestionKind[] = [
  'new_outreach',
  'warm_up_engage',
  'report_back',
  'follow_up_bump',
  'schedule_propose',
  'schedule_confirm',
  'prep_brief',
  'thank_you',
  'action_item_reminder',
  'nurture_checkin',
  'reconnect',
  'congratulate',
  'ask_referral',
  'intro_request',
  'confirm_stage',
  'confirm_merge',
  'confirm_note_match',
  'confirm_intro',
];
const STAGE_TO: ChatStage[] = ['declined', 'replied', 'scheduled', 'scheduling', 'completed', 'no_response'];

export interface Spec {
  name: string;
  seed: number;
  now: Date;
  people: number;
  /** card kinds to raise (one each, or `perKind` each); `random` picks from all */
  kinds: SuggestionKind[] | 'random';
  cards?: number;
  brief?: boolean;
  longNames?: boolean;
  recs?: number;
  chatsToday?: number;
  warmUps?: number;
  addedByHand?: number;
  hidden?: boolean;
  noBodies?: boolean;
}

export interface Built {
  user: User;
  now: Date;
  settings: UserSettings;
  people: Person[];
  chats: CoffeeChat[];
  suggestions: Suggestion[];
  outbound: OutboundMessage[];
  events: CalendarEvent[];
  recs: Recommendation[];
  merges: MergeSuggestion[];
  stageEvents: StageEvent[];
  threads: EmailThread[];
  brief?: Brief;
}

const iso = (d: Date) => d.toISOString();
export const addH = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000);

let uid = 0;
export async function build(spec: Spec): Promise<Built> {
  const r = rng(spec.seed);
  const now = spec.now;
  const userId = `sim-u${++uid}`;
  const user: User = {
    id: userId,
    email: `student${uid}@school.edu`,
    fullName: 'Sam Rivera',
    firstName: 'Sam',
    lastName: 'Rivera',
    school: 'Cornell University',
    majors: ['Economics'],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    onboardingStep: 11,
    onboardingCompletedAt: iso(addH(now, -24 * 30)),
    createdAt: iso(addH(now, -24 * 60)),
  };
  const settings: UserSettings = {
    userId,
    briefTimeLocal: '07:00',
    briefChannels: ['in_app'],
    quietDays: [],
    weeklyOutreachTarget: r.pick([0, 3, 4, 10]),
    dailySendCapGmail: 20,
    dailySendCapLinkedin: 10,
    perPersonCooldownHours: 48,
    maxBumps: 2,
    tonePreset: 'warm',
    warmUpEnabled: true,
    warmUpDays: 4,
  };
  const people: Person[] = [];
  for (let i = 0; i < spec.people; i++) {
    const long = spec.longNames && r.chance(0.5);
    const firstName = long ? LONG_FIRST : r.pick(FIRST);
    const lastName = long ? LONG_LAST : r.pick(LAST);
    const hasLinkedIn = r.chance(0.6);
    const hasEmail = r.chance(0.6);
    const slug = `${firstName}-${lastName}-${i}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const sources: PersonSource[] = [
      r.pick(['gmail', 'linkedin_csv', 'calendar', 'recommendation'] as const),
    ];
    people.push({
      id: `${userId}-p${i}`,
      userId,
      displayName: `${firstName} ${lastName}`,
      firstName,
      lastName,
      nameNormalized: `${firstName} ${lastName}`.toLowerCase(),
      primaryEmail: hasEmail ? `${slug}@example.com` : undefined,
      emails: hasEmail ? [`${slug}@example.com`] : [],
      linkedinUrl: hasLinkedIn ? `https://www.linkedin.com/in/${slug}` : undefined,
      linkedinSlug: hasLinkedIn ? slug : undefined,
      currentTitle: r.pick(TITLES),
      currentOrganizationRaw: r.pick(ORGS),
      photoUrl: r.chance(0.3) ? `https://example.com/${slug}.jpg` : undefined,
      isAlumni: r.chance(0.3),
      relationshipType: 'unknown' as Person['relationshipType'],
      strength: r.pick([0, 0.1, 0.25, 0.5, 0.8]),
      interactionCount: r.int(0, 20),
      sources,
      isHuman: true,
      hiddenAt: spec.hidden && r.chance(0.15) ? iso(addH(now, -5)) : undefined,
      tags: [],
      createdAt: iso(addH(now, -24 * r.int(40, 400))),
      updatedAt: iso(addH(now, -24)),
    });
  }
  // people added by hand lately, with nothing done yet
  for (let i = 0; i < (spec.addedByHand ?? 0) && i < people.length; i++) {
    const p = people[people.length - 1 - i]!;
    p.sources = ['manual'];
    p.createdAt = iso(addH(now, -24 * r.int(1, 20)));
  }

  const chats: CoffeeChat[] = [];
  const suggestions: Suggestion[] = [];
  const outbound: OutboundMessage[] = [];
  const events: CalendarEvent[] = [];
  const merges: MergeSuggestion[] = [];
  const stageEvents: StageEvent[] = [];
  const threads: EmailThread[] = [];
  const chatFor = (p: Person, stage: ChatStage, extra: Partial<CoffeeChat> = {}): CoffeeChat => {
    const c: CoffeeChat = {
      id: `${p.id}-c${chats.length}`,
      userId,
      personId: p.id,
      stage,
      stageEnteredAt: iso(addH(now, -72)),
      source: 'manual',
      goalTags: [],
      bumpCount: 0,
      priority: 2,
      createdAt: iso(addH(now, -24 * 10)),
      updatedAt: iso(addH(now, -24)),
      ...extra,
    };
    chats.push(c);
    return c;
  };

  const kinds =
    spec.kinds === 'random'
      ? Array.from({ length: spec.cards ?? r.int(0, 12) }, () => r.pick(KINDS))
      : spec.kinds.flatMap((k) => Array.from({ length: spec.cards ?? 1 }, () => k));
  let n = 0;
  for (const kind of kinds) {
    if (!people.length) break;
    const p = people[n % people.length]!;
    const id = `${userId}-s${n++}`;
    const base: Suggestion = {
      id,
      userId,
      kind,
      personId: p.id,
      priorityScore: Math.round(r.next() * 100) / 100,
      reasonText: `Reason for ${kind}`,
      signals: {},
      payload: {},
      status: r.chance(0.9) ? 'pending' : r.pick(['snoozed', 'done', 'dismissed'] as const),
      dedupeKey: `${kind}:${id}`,
      carriedOver: 0,
      expiresAt: iso(addH(now, 72)),
      deferred: r.chance(0.15),
      createdAt: iso(addH(now, -r.int(1, 48))),
    };
    if (base.status === 'snoozed') base.snoozedUntil = iso(addH(now, r.chance(0.5) ? -2 : 20));
    if (isMessageSuggestion(kind)) {
      const chat = kind === 'new_outreach' ? undefined : chatFor(p, 'replied');
      base.chatId = chat?.id;
      // a card kept for later has no draft yet (deferred); some drafts are empty, some are on their way already
      if (!base.deferred && r.chance(0.85)) {
        const o: OutboundMessage = {
          id: `${id}-o`,
          userId,
          personId: p.id,
          chatId: chat?.id,
          suggestionId: id,
          channel: p.primaryEmail ? 'gmail' : 'linkedin',
          kind: 'outreach',
          bodyDraft: spec.noBodies || r.chance(0.1) ? '' : `Hi ${p.firstName},\n\nA short note.\n\nSam`,
          status: r.chance(0.85) ? 'draft' : r.pick(['queued', 'handed_off', 'failed'] as const),
          generatedBy: 'template',
          createdAt: iso(addH(now, -3)),
        };
        outbound.push(o);
        base.outboundMessageId = o.id;
      }
      if (kind === 'schedule_confirm')
        base.payload.time = { startIso: iso(addH(now, r.chance(0.8) ? 48 : -1)) };
    } else if (kind === 'confirm_stage') {
      const c = chatFor(p, 'outreach_sent');
      const ev: StageEvent = {
        id: `${id}-se`,
        userId,
        chatId: c.id,
        fromStage: 'outreach_sent',
        toStage: r.pick(STAGE_TO),
        status: 'proposed',
        actor: 'system',
        reason: 'reply',
        createdAt: iso(addH(now, -2)),
      };
      stageEvents.push(ev);
      base.chatId = c.id;
      base.payload = { stageEventId: ev.id, toStage: ev.toStage };
      base.dedupeKey = `stage:${ev.id}`;
    } else if (kind === 'confirm_merge') {
      const other = people[(n + 1) % people.length]!;
      if (other.id === p.id) continue;
      // one of the pair with LinkedIn, or neither, or both
      if (r.chance(0.3)) other.linkedinUrl = undefined;
      const m: MergeSuggestion = {
        id: `${id}-m`,
        userId,
        personAId: p.id,
        personBId: other.id,
        score: 0.8,
        features: {},
        status: 'pending',
        createdAt: iso(addH(now, -5)),
      };
      merges.push(m);
      base.payload = { mergeId: m.id, otherPersonId: other.id };
      base.dedupeKey = `merge:${m.id}`;
    } else if (kind === 'confirm_intro') {
      const introducer = people[(n + 2) % people.length]!;
      const t = {
        id: `${id}-t`,
        userId,
        externalThreadId: `x-${id}`,
        subject: 'Intro',
        participants: [],
        personIds: [p.id, introducer.id],
        lastMessageAt: iso(addH(now, -4)),
        messageCount: 1,
        possibleIntroduction: {
          introducerId: introducer.id,
          personIds: [p.id],
          messageId: `${id}-msg`,
          at: iso(addH(now, -4)),
          status: 'open',
        },
      } as unknown as EmailThread;
      threads.push(t);
      base.payload = { threadId: t.id, introducerId: introducer.id };
      base.reasonText = `Did ${introducer.firstName} introduce you to ${p.firstName}?`;
    } else if (kind === 'warm_up_engage') {
      const actionId = `${id}-a`;
      const withChat = r.chance(0.9);
      const c = withChat
        ? chatFor(p, 'warming', {
            warmUp: {
              startedAt: iso(addH(now, -48)),
              readyAt: iso(addH(now, 48)),
              actions: [
                {
                  id: actionId,
                  kind: 'view_profile',
                  label: 'Look at their profile',
                  url: `https://www.linkedin.com/in/${p.linkedinSlug ?? 'x'}`,
                  dueAt: iso(addH(now, -1)),
                },
              ],
            },
          })
        : undefined;
      base.chatId = c?.id;
      base.payload = { actionId, url: `https://www.linkedin.com/in/${p.linkedinSlug ?? 'x'}` };
      if (c) base.dedupeKey = `warm:${c.id}:${actionId}`;
    } else if (kind === 'prep_brief') {
      const start = addH(now, r.chance(0.85) ? r.int(1, 8) : -1);
      base.signals = { startAt: iso(start) };
      base.payload = { eventId: `${id}-e` };
    } else if (kind === 'action_item_reminder') {
      base.payload = { actionItemId: `${id}-ai` };
    } else if (kind === 'confirm_note_match') {
      base.payload = { noteId: `${id}-n` };
      if (r.chance(0.5)) base.personId = undefined;
    }
    suggestions.push(base);
  }

  // chats on the calendar today, some already over
  for (let i = 0; i < (spec.chatsToday ?? 0) && people.length; i++) {
    const p = people[(i * 7) % people.length]!;
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const start = addH(startOfDay, r.pick([8, 9, 13, 16, 19]));
    events.push({
      id: `${userId}-e${i}`,
      userId,
      externalEventId: `ext-${i}`,
      title: `Coffee with ${p.firstName}`,
      startAt: iso(start),
      endAt: iso(addH(start, 0.5)),
      status: r.chance(0.9) ? 'confirmed' : 'cancelled',
      attendees: [],
      attendeePersonIds: [p.id],
      isCoffeeChat: true,
    });
  }
  // warm-ups in progress that are not cards: a step due, or done and ready for the first message
  for (let i = 0; i < (spec.warmUps ?? 0) && people.length; i++) {
    const p = people[(i * 5 + 3) % people.length]!;
    const ready = r.chance(0.4);
    const actionId = `${p.id}-wa${i}`;
    const c = chatFor(p, 'warming', {
      warmUp: {
        startedAt: iso(addH(now, -24 * 6)),
        readyAt: iso(addH(now, ready ? -24 : 48)),
        actions: [
          {
            id: actionId,
            kind: 'react_post',
            label: 'React to one recent post',
            url: `https://www.linkedin.com/in/${p.linkedinSlug ?? 'x'}/recent-activity/`,
            dueAt: iso(addH(now, -3)),
            doneAt: ready ? iso(addH(now, -30)) : undefined,
          },
        ],
      },
    });
    // a step the student put off until tomorrow
    if (!ready && r.chance(0.3))
      suggestions.push({
        id: `${c.id}-ws`,
        userId,
        kind: 'warm_up_engage',
        personId: p.id,
        chatId: c.id,
        priorityScore: 0.3,
        reasonText: 'React to one recent post',
        signals: {},
        payload: { actionId, url: 'https://www.linkedin.com/in/x' },
        status: 'snoozed',
        snoozedUntil: iso(addH(now, 20)),
        dedupeKey: `warm:${c.id}:${actionId}`,
        carriedOver: 0,
        expiresAt: iso(addH(now, 72)),
        createdAt: iso(addH(now, -24)),
      });
  }
  // replies, sent first messages
  for (const c of chats) if (r.chance(0.3)) c.lastInboundAt = iso(addH(now, 0.5 - r.int(1, 40)));
  for (let i = 0; i < r.int(0, 6) && people.length; i++) {
    const p = people[(i * 3) % people.length]!;
    outbound.push({
      id: `${userId}-sent${i}`,
      userId,
      personId: p.id,
      channel: 'gmail',
      kind: 'outreach',
      bodyDraft: 'Hi',
      status: 'sent',
      sentAt: iso(addH(now, -24 * r.int(0, 20))),
      generatedBy: 'template',
      createdAt: iso(addH(now, -24 * 21)),
    });
  }
  const recs: Recommendation[] = [];
  for (let i = 0; i < (spec.recs ?? 0) && people.length; i++) {
    const p = people[(i * 11 + 1) % people.length]!;
    recs.push({
      id: `${userId}-r${i}`,
      userId,
      personId: p.id,
      score: r.next(),
      fitScore: 0.5,
      reachScore: 0.5,
      responsePrior: 0.2,
      reasons: r.chance(0.5)
        ? [{ code: 'alumni', text: 'Cornell University alum' }]
        : [{ code: 'function_match', text: `Works in product (${r.pick(['Product Manager', 'Analyst'])})` }],
      status: 'new',
      batchDate: localDate(now),
    });
  }
  const brief: Brief | undefined =
    spec.brief && suggestions.length
      ? {
          id: `${userId}-b`,
          userId,
          kind: 'daily',
          briefDate: localDate(now),
          generatedAt: iso(addH(now, -2)),
          suggestionIds: suggestions.filter(() => r.chance(0.6)).map((s) => s.id),
          summaryText: '',
          stats: {},
        }
      : undefined;

  await db.users.put(user);
  await db.settings.put(settings);
  await db.people.bulkPut(people);
  await db.chats.bulkPut(chats);
  await db.suggestions.bulkPut(suggestions);
  await db.outbound.bulkPut(outbound);
  await db.events.bulkPut(events);
  await db.recommendations.bulkPut(recs);
  await db.merges.bulkPut(merges);
  await db.stageEvents.bulkPut(stageEvents);
  await db.threads.bulkPut(threads);
  if (brief) await db.briefs.put(brief);
  return {
    user,
    now,
    settings,
    people,
    chats,
    suggestions,
    outbound,
    events,
    recs,
    merges,
    stageEvents,
    threads,
    brief,
  };
}

export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- the accounts ----------

export const TUESDAY = new Date('2026-10-06T09:30:00');
const DAYS = [
  TUESDAY,
  new Date('2026-10-10T10:00:00'), // Saturday
  new Date('2026-10-11T21:30:00'), // Sunday night
  new Date('2026-10-05T07:05:00'), // Monday, just after the brief time
  new Date('2026-10-09T14:00:00'), // Friday afternoon
];

export function specs(): Spec[] {
  const out: Spec[] = [
    { name: 'empty account', seed: 1, now: TUESDAY, people: 0, kinds: [] },
    { name: 'one person, nothing due', seed: 2, now: TUESDAY, people: 1, kinds: [] },
    { name: 'dozens of people, nothing due', seed: 3, now: TUESDAY, people: 40, kinds: [] },
    { name: 'hundreds of people, nothing due', seed: 4, now: TUESDAY, people: 400, kinds: [] },
    { name: 'fifty cards at once', seed: 5, now: TUESDAY, people: 120, kinds: 'random', cards: 55, recs: 6 },
    { name: 'fifty first messages', seed: 6, now: TUESDAY, people: 60, kinds: ['new_outreach'], cards: 50 },
    { name: 'every kind, long names', seed: 7, now: TUESDAY, people: 30, kinds: KINDS, longNames: true },
    {
      name: 'drafts with no body',
      seed: 8,
      now: TUESDAY,
      people: 10,
      kinds: ['thank_you', 'follow_up_bump'],
      noBodies: true,
    },
    { name: 'chats today only', seed: 9, now: TUESDAY, people: 6, kinds: [], chatsToday: 3 },
    { name: 'warm-ups only', seed: 10, now: TUESDAY, people: 12, kinds: [], warmUps: 4 },
    { name: 'Discover only', seed: 11, now: TUESDAY, people: 25, kinds: [], recs: 8 },
    { name: 'added by hand only', seed: 12, now: TUESDAY, people: 5, kinds: [], addedByHand: 3 },
    { name: 'hidden people', seed: 13, now: TUESDAY, people: 20, kinds: 'random', cards: 15, hidden: true },
  ];
  // every kind alone, on every day
  let seed = 100;
  for (const now of DAYS)
    for (const k of KINDS)
      out.push({ name: `${k} alone`, seed: seed++, now, people: k === 'confirm_merge' ? 3 : 2, kinds: [k] });
  // two of every kind with a brief that picked some
  for (const k of KINDS)
    out.push({
      name: `${k} twice, with a brief`,
      seed: seed++,
      now: TUESDAY,
      people: 8,
      kinds: [k],
      cards: 2,
      brief: true,
    });
  // and a few hundred mixed accounts
  const r = rng(42);
  while (out.length < 340) {
    const people = r.pick([1, 2, 3, 8, 15, 40, 120, 300]);
    out.push({
      name: `mixed #${out.length}`,
      seed: seed++,
      now: addH(r.pick(DAYS), r.int(-2, 10)),
      people,
      kinds: 'random',
      cards: r.pick([0, 1, 3, 6, 7, 12, 25, 60]),
      brief: r.chance(0.5),
      longNames: r.chance(0.2),
      recs: r.pick([0, 0, 2, 5, 10]),
      chatsToday: r.pick([0, 0, 1, 2]),
      warmUps: r.pick([0, 0, 1, 3]),
      addedByHand: r.pick([0, 0, 1, 2]),
      hidden: r.chance(0.2),
      noBodies: r.chance(0.1),
    });
  }
  return out;
}

/** An account as the database holds it now (the demo, after the real engine made its brief), for the same checks. */
export async function readAccount(user: User, now: Date): Promise<Built> {
  const by = <T>(t: { where(k: string): { equals(v: string): { toArray(): Promise<T[]> } } }) =>
    t.where('userId').equals(user.id).toArray();
  const [settings, people, chats, suggestions, outbound, events, recs, merges, stageEvents, threads, briefs] =
    await Promise.all([
      db.settings.get(user.id),
      by<Person>(db.people),
      by<CoffeeChat>(db.chats),
      by<Suggestion>(db.suggestions),
      by<OutboundMessage>(db.outbound),
      by<CalendarEvent>(db.events),
      by<Recommendation>(db.recommendations),
      by<MergeSuggestion>(db.merges),
      by<StageEvent>(db.stageEvents),
      by<EmailThread>(db.threads),
      by<Brief>(db.briefs),
    ]);
  const brief = briefs
    .filter((b) => b.kind === 'daily')
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
  return {
    user,
    now,
    settings: settings!,
    people,
    chats,
    suggestions,
    outbound,
    events,
    recs: recs.filter((r) => r.status === 'new'),
    merges,
    stageEvents,
    threads,
    brief,
  };
}

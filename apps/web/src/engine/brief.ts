import type {
  Brief,
  CoffeeChat,
  DraftContext,
  EmailMessage,
  MessageKind,
  OutboundMessage,
  Person,
  PersonFact,
  Suggestion,
  SuggestionKind,
  User,
} from '@orbit/core';
import {
  buildWarmUpPlan,
  type Candidate,
  contextText,
  defaultStyleCard,
  generateCandidates,
  generateDraft,
  isBlocked,
  newId,
  proposeWindows,
  selectForBrief,
  suggestionFromCandidate,
  todayKey,
  validateDraft,
  warmUpProgress,
} from '@orbit/core';
import { feedback, notify, recomputeAllStrengths } from '../db/repo';
import { db } from '../db/schema';
import { hasLlm, llmDraft, llmSummary } from '../integrations/anthropic';
import { bestPathStrength, buildReachGraph } from './graph';
import { runTimedStageRules } from './stages';

const DAY = 86_400_000;

async function ruleInput(userId: string, now: Date, scope?: { chatId?: string; personId?: string }) {
  const [
    settings,
    people,
    allChats,
    events,
    actionItems,
    facts,
    targetCompanies,
    recommendations,
    outbound,
    feedbackRows,
  ] = await Promise.all([
    db.settings.get(userId),
    db.people.where('userId').equals(userId).toArray(),
    db.chats.where('userId').equals(userId).toArray(),
    db.events.where('userId').equals(userId).toArray(),
    db.actionItems.where('userId').equals(userId).toArray(),
    db.facts.where('userId').equals(userId).toArray(),
    db.targetCompanies.where('userId').equals(userId).toArray(),
    db.recommendations.where('userId').equals(userId).toArray(),
    db.outbound.where('userId').equals(userId).toArray(),
    db.feedback.where('userId').equals(userId).toArray(),
  ]);
  const chats = scope?.chatId
    ? allChats.filter((c) => c.id === scope.chatId)
    : scope?.personId
      ? allChats.filter((c) => c.personId === scope.personId)
      : allChats;
  const lastInboundByChat = new Map<string, EmailMessage>();
  for (const c of chats) {
    if (!c.threadId) continue;
    const msgs = await db.messages.where('threadId').equals(c.threadId).toArray();
    const last = msgs
      .filter((m) => m.direction === 'inbound' && !m.isAutomated)
      .sort((a, b) => b.sentAt.localeCompare(a.sentAt))[0];
    if (last) lastInboundByChat.set(c.id, last);
  }
  const factsByPerson = new Map<string, PersonFact[]>();
  for (const f of facts) {
    if (f.deletedAt) continue;
    const arr = factsByPerson.get(f.personId) ?? [];
    arr.push(f);
    factsByPerson.set(f.personId, arr);
  }
  const dismissCounts = new Map<string, number>();
  const cutoff = now.getTime() - 60 * DAY;
  for (const fb of feedbackRows) {
    if (fb.kind !== 'dismiss' || new Date(fb.createdAt).getTime() < cutoff || !fb.suggestionId) continue;
    const key = (fb.reason ?? '').split('|')[1] ?? '';
    if (key) dismissCounts.set(key, (dismissCounts.get(key) ?? 0) + 1);
  }
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  weekStart.setHours(0, 0, 0, 0);
  const outreachSentThisWeek = outbound.filter(
    (o) => o.status === 'sent' && o.kind === 'outreach' && o.sentAt && new Date(o.sentAt) >= weekStart,
  ).length;
  const recentlyContacted = new Set(
    outbound
      .filter(
        (o) => o.status === 'sent' && o.sentAt && now.getTime() - new Date(o.sentAt).getTime() < 30 * DAY,
      )
      .map((o) => o.personId),
  );
  const s = settings ?? {
    userId,
    briefTimeLocal: '07:00',
    briefChannels: ['in_app' as const],
    quietDays: [],
    weeklyOutreachTarget: 4,
    dailySendCapGmail: 15,
    dailySendCapLinkedin: 10,
    perPersonCooldownHours: 72,
    maxBumps: 2,
    tonePreset: 'warm' as const,
    warmUpEnabled: true,
    warmUpDays: 4,
  };
  return {
    userId,
    now,
    settings: s,
    people: new Map(people.map((p) => [p.id, p])),
    chats: scope ? chats : allChats,
    lastInboundByChat,
    events: scope
      ? events.filter((e) => !scope.personId || e.attendeePersonIds.includes(scope.personId))
      : events,
    actionItems,
    factsByPerson,
    targetCompanies,
    recommendations,
    dismissCounts,
    outreachSentThisWeek,
    freeSlotsIso: freeSlots(events, now),
    recentlyContacted,
  };
}

/** Two free 30-minute windows in the next 5 working days, 10:00–17:00 local, avoiding existing events. */
export function freeSlots(events: { startAt: string; endAt: string; status: string }[], now: Date): string[] {
  const out: string[] = [];
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  for (let i = 0; i < 10 && out.length < 2; i++) {
    if (d.getDay() === 0 || d.getDay() === 6) {
      d.setDate(d.getDate() + 1);
      continue;
    }
    for (const hour of [10, 14, 16]) {
      const s = new Date(d);
      s.setHours(hour, 0, 0, 0);
      const e = new Date(s.getTime() + 30 * 60_000);
      const busy = events.some(
        (ev) => ev.status !== 'cancelled' && new Date(ev.startAt) < e && new Date(ev.endAt) > s,
      );
      if (!busy) {
        out.push(s.toISOString());
        break;
      }
    }
    d.setDate(d.getDate() + 1);
  }
  return out;
}

export async function upsertSuggestions(
  userId: string,
  cands: (Candidate & { priorityScore: number })[],
  now: Date,
  briefId?: string,
): Promise<Suggestion[]> {
  const out: Suggestion[] = [];
  for (const c of cands) {
    const existing = await db.suggestions.where('dedupeKey').equals(c.dedupeKey).first();
    if (existing) {
      if (['pending', 'snoozed'].includes(existing.status)) {
        if (existing.status === 'snoozed' && existing.snoozedUntil && new Date(existing.snoozedUntil) > now)
          continue;
        await db.suggestions.update(existing.id, {
          status: 'pending',
          priorityScore: c.priorityScore,
          reasonText: c.reasonText,
          signals: c.signals,
          payload: { ...existing.payload, ...c.payload },
          briefId: briefId ?? existing.briefId,
          expiresAt: new Date(now.getTime() + 2 * DAY).toISOString(),
        });
        out.push({
          ...existing,
          status: 'pending',
          priorityScore: c.priorityScore,
          briefId: briefId ?? existing.briefId,
        });
      }
      continue; // decided ones are never recreated
    }
    const s = suggestionFromCandidate(c, userId, now, newId('s'));
    s.briefId = briefId;
    await db.suggestions.add(s);
    out.push(s);
  }
  return out;
}

const DRAFT_KIND: Partial<Record<SuggestionKind, MessageKind>> = {
  new_outreach: 'outreach',
  follow_up_bump: 'bump',
  schedule_propose: 'schedule',
  schedule_confirm: 'reply',
  thank_you: 'thank_you',
  nurture_checkin: 'nurture',
  reconnect: 'nurture',
  congratulate: 'congratulate',
  ask_referral: 'referral_ask',
  intro_request: 'intro_request',
  report_back: 'report_back',
};

/** Kinds that open a new email thread with their own subject instead of replying in the chat's thread. */
const NEW_THREAD_KINDS = new Set<MessageKind>(['outreach', 'intro_request', 'referral_ask']);

/** Extra, user-supplied inputs for a draft (from the needs-input prompt in the editor). */
export interface DraftInputs {
  /** one line only true of the recipient: how the student found them, what they share, what of theirs they read */
  connection?: string;
  /** one real update since the last conversation (nurture) */
  update?: string;
  /** what the student is congratulating them on (congratulate, when no job change is on record) */
  news?: string;
  /** who the student wants an intro to: "Lucas Fischer, Engineering Manager at Ramp" (intro request) */
  target?: string;
  /** the student's answer to a question in the thread (reply) */
  answer?: string;
  /** the role and company for a referral ask: "PM Intern at Notion" */
  role?: string;
  /** one thing they said that stuck with the student (thank-you, when no notes exist yet) */
  takeaway?: string;
}

/** "Lucas Fischer, Engineering Manager at Ramp" -> name, title, org. */
function parseTargetLine(line: string): { name: string; title?: string; org?: string } {
  const t = line.replace(/\s+/g, ' ').trim();
  const [name, ...restParts] = t.split(/\s*[,(]\s*|\s+-\s+/);
  const rest = restParts.join(', ').replace(/\)$/, '');
  const m = rest.match(/^(.*?)\s+(?:at|@)\s+(.+)$/);
  if (m) return { name: name!.trim(), title: m[1]!.trim() || undefined, org: m[2]!.trim() };
  const only = t.match(/^(.+?)\s+(?:at|@)\s+(.+)$/);
  if (!rest && only) return { name: only[1]!.trim(), org: only[2]!.trim() };
  return { name: name!.trim(), title: rest || undefined };
}

/** The person who introduced or pointed the student to `person`, if an intro request to them was sent. */
export async function findReferrerFor(
  userId: string,
  person: Pick<Person, 'id' | 'displayName'>,
): Promise<Person | undefined> {
  const intro = (
    await db.suggestions
      .where('userId')
      .equals(userId)
      .filter(
        (x) =>
          x.kind === 'intro_request' &&
          ['sent', 'approved', 'edited'].includes(x.status) &&
          (x.payload.target as { name?: string } | undefined)?.name === person.displayName,
      )
      .toArray()
  ).sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt))[0];
  if (!intro?.personId) return undefined;
  return db.people.get(intro.personId);
}

/** One concrete thing the student has done, from the resume: the strongest project or experience line. */
function credibilityLine(
  facets: { kind: string; text: string; title?: string; organizationName?: string }[],
): string | undefined {
  const score = (t: string) =>
    (/\b\d[\d,]*\b/.test(t) ? 2 : 0) +
    (/\b(built|shipped|led|grew|raised|published|launched|won)\b/i.test(t) ? 1 : 0);
  const cands = facets
    .filter((f) => f.kind === 'project' || f.kind === 'experience')
    .map((f) => {
      // one clause: the first sentence, cut at a semicolon ("Built X in Go; reduced Y by 30%" -> "Built X in Go")
      const first = (f.text.split(/(?<=[.!?])\s+/)[0] ?? f.text).split(/;\s*/)[0]!;
      const line = first.replace(/\s+/g, ' ').trim().replace(/[.,]$/, '');
      return { line, score: score(line) + (f.kind === 'project' ? 0.5 : 0), len: line.length };
    })
    // it is spliced after the student's name ("Alex built ..."), so it must open with a past-tense verb
    .filter((c) =>
      /^[A-Za-z]+ed\b|^(built|led|ran|won|grew|wrote|made|shipped|taught|drove|began)\b/i.test(c.line),
    )
    .filter((c) => c.len >= 20 && c.len <= 110)
    .sort((a, b) => b.score - a.score || a.len - b.len);
  return cands[0]?.line;
}

export async function buildDraftContext(
  user: User,
  person: Person,
  kind: MessageKind,
  channel: 'gmail' | 'linkedin',
  s?: Suggestion,
  inputs: DraftInputs = {},
  chatOverride?: CoffeeChat,
): Promise<DraftContext> {
  const now = new Date();
  const [goals, settings, style, facts, resumeFacets, chatFound, affiliations, org, events] =
    await Promise.all([
      db.goals.get(user.id),
      db.settings.get(user.id),
      db.styles.get(user.id),
      db.facts
        .where('personId')
        .equals(person.id)
        .filter((f) => !f.deletedAt)
        .toArray(),
      db.resumeFacets.toArray(),
      chatOverride
        ? Promise.resolve(chatOverride)
        : s?.chatId
          ? db.chats.get(s.chatId)
          : db.chats
              .where('personId')
              .equals(person.id)
              .filter((c) => !['archived'].includes(c.stage))
              .first(),
      db.affiliations.where('personId').equals(person.id).toArray(),
      person.currentOrganizationId ? db.organizations.get(person.currentOrganizationId) : undefined,
      db.events.where('userId').equals(user.id).toArray(),
    ]);
  // a report-back is addressed to the referrer; the chat on the suggestion is the target's chat
  const chat = kind === 'report_back' ? undefined : chatFound;
  let thread: DraftContext['thread'];
  if (chat?.threadId) {
    const [msgs, th] = await Promise.all([
      db.messages.where('threadId').equals(chat.threadId).sortBy('sentAt'),
      db.threads.get(chat.threadId),
    ]);
    const lastIn = [...msgs].reverse().find((m) => m.direction === 'inbound');
    const firstOut = msgs.find((m) => m.direction === 'outbound');
    thread = {
      lastInboundBody: lastIn?.bodyText,
      lastInboundAt: lastIn?.sentAt,
      firstOutboundAt: firstOut?.sentAt ?? chat.firstOutreachAt,
      asksOfUser: lastIn?.extraction?.asksOfUser,
      proposedTimes: lastIn?.extraction?.proposedTimes.map((t) => ({ startIso: t.startIso, raw: t.raw })),
      lastSignal: lastIn?.signal,
      inThread: !NEW_THREAD_KINDS.has(kind) && !!th?.externalThreadId,
      subject: th?.subject,
    };
  } else if (chat?.firstOutreachAt) thread = { firstOutboundAt: chat.firstOutreachAt };
  // outreach to someone the student has already emailed with picks that exchange back up (and its thread, when the
  // last message is recent enough to reply to) instead of introducing the student as a stranger
  let history: DraftContext['history'];
  if (kind === 'outreach' && !chat?.threadId) {
    const theirThreads = await db.threads
      .where('userId')
      .equals(user.id)
      .filter((t) => (t.participantPersonIds ?? []).includes(person.id))
      .toArray();
    const msgs = (
      await Promise.all(theirThreads.map((t) => db.messages.where('threadId').equals(t.id).toArray()))
    )
      .flat()
      .filter((m) => !m.isAutomated)
      .sort((a, b) => a.sentAt.localeCompare(b.sentAt));
    const last = msgs.at(-1);
    if (last) {
      const lastThread = theirThreads.find((t) => t.id === last.threadId);
      const recent = now.getTime() - new Date(last.sentAt).getTime() <= 180 * DAY;
      history = {
        lastAt: last.sentAt,
        lastInbound: last.direction === 'inbound',
        repliedEver: msgs.some((m) => m.direction === 'inbound'),
        threadId: recent && lastThread?.externalThreadId ? lastThread.id : undefined,
      };
      if (history.repliedEver && history.threadId && channel === 'gmail')
        thread = { inThread: true, subject: lastThread?.subject };
    }
  }
  // promises the student made to this person in the conversation, kept in the thank-you
  const promises =
    kind === 'thank_you'
      ? (await db.actionItems.where('personId').equals(person.id).toArray())
          .filter((a) => a.userId === user.id && a.status === 'open')
          .map((a) => a.text)
      : undefined;
  const tcId = s?.payload.targetCompanyId as string | undefined;
  let tc = tcId
    ? await db.targetCompanies.get(tcId)
    : person.currentOrganizationRaw
      ? await db.targetCompanies
          .where('userId')
          .equals(user.id)
          .filter(
            (t) =>
              (!!person.currentOrganizationId && t.organizationId === person.currentOrganizationId) ||
              t.nameRaw.toLowerCase() === (person.currentOrganizationRaw ?? '').toLowerCase(),
          )
          .first()
      : undefined;
  // the student said which role (referral ask): "PM Intern at Notion"
  let roleInput: { name: string; roleLabel?: string } | undefined;
  if (inputs.role?.trim()) {
    const m = inputs.role.trim().match(/^(.*?)\s+(?:at|@)\s+(.+)$/);
    roleInput = m ? { roleLabel: m[1]!.trim(), name: m[2]!.trim() } : { name: inputs.role.trim() };
    const known = await db.targetCompanies
      .where('userId')
      .equals(user.id)
      .filter((t) => t.nameRaw.toLowerCase() === roleInput!.name.toLowerCase())
      .first();
    if (known) tc = known;
  }
  let target = s?.payload.target as DraftContext['target'] | undefined;
  if (!target && inputs.target?.trim()) {
    const parsed = parseTargetLine(inputs.target);
    const known = (await db.people.where('userId').equals(user.id).toArray()).find(
      (p) => p.displayName.toLowerCase() === parsed.name.toLowerCase(),
    );
    target = known
      ? { name: known.displayName, title: known.currentTitle, org: known.currentOrganizationRaw }
      : parsed;
  }
  if (target && !target.firstName) target = { ...target, firstName: target.name.split(' ')[0] };
  // real free windows from the student's calendar, in their timezone, on different days and times
  const busy = events.map((e) => ({
    startIso: e.startAt,
    endIso: e.endAt,
    status: e.status,
    withPerson: e.attendeePersonIds?.includes(person.id) || undefined,
  }));
  // a meeting with them already on the calendar and still ahead (a reply never proposes new times over it)
  const upcomingAt = events
    .filter(
      (e) =>
        e.status !== 'cancelled' &&
        e.attendeePersonIds?.includes(person.id) &&
        new Date(e.startAt).getTime() > now.getTime(),
    )
    .sort((a, b) => a.startAt.localeCompare(b.startAt))[0]?.startAt;
  const windows =
    kind === 'schedule' || kind === 'reply'
      ? proposeWindows(busy, now, user.timezone, { seed: person.id })
      : undefined;
  const warm = chat?.warmUp ? warmUpProgress(chat.warmUp, now) : undefined;
  const warmUpNote = chat?.warmUp?.actions.find((a) => a.doneAt && a.note)?.note;
  const commentedOnPost =
    !warmUpNote && !!chat?.warmUp?.actions.some((a) => a.kind === 'comment_post' && a.doneAt);
  // when the conversation happened: the calendar event if there is one, otherwise when the chat was completed
  const meetingEvent = chat?.scheduledEventId
    ? events.find((e) => e.id === chat.scheduledEventId)
    : undefined;
  const meetingAt =
    meetingEvent && new Date(meetingEvent.startAt) <= now ? meetingEvent.startAt : chat?.completedAt;
  // previous employer: the most recent non-current employment affiliation
  const employment = affiliations.filter((a) => a.kind === 'employment');
  const previous = employment
    .filter((a) => !a.isCurrent && a.nameRaw && a.nameRaw !== person.currentOrganizationRaw)
    .sort((a, b) => (b.endDate ?? b.startDate ?? '').localeCompare(a.endDate ?? a.startDate ?? ''))[0];
  // a job change on record: a current role that started in the last 120 days (a LinkedIn re-import that saw a new
  // company or title records exactly that)
  const latest = employment
    .filter((a) => a.isCurrent && a.startDate)
    .sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''))[0];
  // the role it replaced: closed the day the new one opened (a re-import), so a same-company title change is not a "move"
  const replaced = latest?.startDate
    ? employment.find(
        (a) => !a.isCurrent && a.endDate && a.endDate.slice(0, 10) === latest.startDate!.slice(0, 10),
      )
    : undefined;
  const newAffiliation =
    latest?.startDate && now.getTime() - new Date(latest.startDate).getTime() <= 120 * DAY
      ? {
          title: latest.title,
          org: latest.nameRaw,
          since: latest.startDate,
          previousOrg: replaced?.nameRaw,
          // a LinkedIn re-import dates the change by when Orbit saw it, not when it happened
          observed: latest.source === 'linkedin_csv' || undefined,
        }
      : undefined;
  // referrer: on the chat, or the person who received an intro request for this person
  let referrerName = chat?.referrerName;
  if (!referrerName && chat?.referrerPersonId)
    referrerName = (await db.people.get(chat.referrerPersonId))?.firstName;
  if (!referrerName && kind === 'outreach')
    referrerName = (await findReferrerFor(user.id, person))?.firstName;
  // openings used for the same company in the last 30 days (avoid repeating ourselves across a team), and the
  // people there the student has already spoken with (a recruiter email names them)
  const sameOrg = person.currentOrganizationRaw
    ? (await db.people.where('userId').equals(user.id).toArray()).filter(
        (p) =>
          p.id !== person.id &&
          (p.currentOrganizationRaw ?? '').toLowerCase() === person.currentOrganizationRaw!.toLowerCase(),
      )
    : [];
  const recentOpenings: string[] = [];
  const sameOrgContacts: string[] = [];
  for (const p of sameOrg) {
    const rows = await db.outbound.where('personId').equals(p.id).toArray();
    for (const r of rows)
      if (r.opening && now.getTime() - new Date(r.sentAt ?? r.createdAt).getTime() < 30 * DAY)
        recentOpenings.push(r.opening);
    const spoke = await db.chats
      .where('personId')
      .equals(p.id)
      .filter((c) => !!c.completedAt)
      .first();
    if (spoke) sameOrgContacts.push(p.firstName);
  }
  const pastOrgs = resumeFacets
    .filter((f) => f.kind === 'experience' && f.organizationName)
    .map((f) => f.organizationName!)
    .filter((v, i, arr) => arr.indexOf(v) === i);
  const reportBack = s?.payload.reportBack as DraftContext['reportBack'] | undefined;
  const userConnection = inputs.connection?.trim();
  const factList: PersonFact[] = facts
    .sort((a, b) => (b.occurredAt ?? '').localeCompare(a.occurredAt ?? ''))
    .slice(0, 15);
  if (userConnection && !factList.some((f) => f.type === 'connection' && f.text === userConnection))
    factList.unshift({
      id: `input-connection`,
      userId: user.id,
      personId: person.id,
      type: 'connection',
      text: userConnection,
      sourceTable: 'input',
      sourceId: 'input',
      confidence: 1,
      createdAt: now.toISOString(),
    });
  return {
    user: {
      firstName: user.firstName,
      lastName: user.lastName,
      fullName: user.fullName,
      school: user.school,
      gradYear: user.graduationYear,
      degree: user.degree,
      majors: user.majors,
      cycleLabel: goals?.cycleLabel ?? '',
      targetFunctions: goals?.targetFunctions ?? [],
      // the "who I am" clause is composed from structured fields (year, school, major); a free-text resume
      // summary is never spliced in, since heuristic parses put the contact header there
      credibility: credibilityLine(resumeFacets),
      schedulingLink: settings?.schedulingLink,
      timezone: user.timezone,
      pastOrgs,
    },
    styleCard: style?.card ?? defaultStyleCard(settings?.tonePreset ?? 'warm', user.firstName),
    person: {
      firstName: person.firstName,
      lastName: person.lastName,
      fullName: person.displayName,
      title: person.currentTitle,
      org: person.currentOrganizationRaw,
      orgIndustry: org?.industry,
      isAlumni: person.isAlumni,
      relationshipType: person.relationshipType,
      strength: person.strength,
      linkedinConnected: !!person.linkedinConnectedOn,
      linkedinConnectedAt: person.linkedinConnectedOn,
      previousOrg: previous?.nameRaw,
      previousTitle: previous?.title,
    },
    facts: factList,
    kind,
    channel,
    bumpNumber: (chat?.bumpCount ?? 0) + 1,
    proposedWindows: windows,
    busy,
    thread,
    target,
    chat: chat
      ? {
          completedAt: chat.completedAt,
          meetingAt,
          stage: chat.stage,
          referrerName,
          warmUpNote,
          warmUpDone: warm?.done,
          commentedOnPost: commentedOnPost || undefined,
          upcomingAt,
        }
      : referrerName
        ? { referrerName }
        : undefined,
    update: inputs.update?.trim() || undefined,
    news: inputs.news?.trim() || undefined,
    answer: inputs.answer?.trim() || undefined,
    takeaway: inputs.takeaway?.trim() || undefined,
    reengage: s?.payload.reengage as DraftContext['reengage'] | undefined,
    history,
    promises: promises?.length ? promises : undefined,
    newAffiliation,
    targetCompany: tc
      ? {
          name: tc.nameRaw,
          roleLabel: roleInput?.roleLabel ?? goals?.targetRoles[0],
          applied: tc.status === 'applied' || tc.status === 'interviewing',
        }
      : roleInput
        ? { name: roleInput.name, roleLabel: roleInput.roleLabel }
        : undefined,
    reportBack,
    sameOrgContacts,
    recentOpenings,
    seed: person.id,
    now,
  };
}

/**
 * Template first; the LLM may improve voice and specificity only if its result passes the same validator,
 * including the check that it mentions nothing (no name, company, post, mutual connection or figure) that is not in
 * the context pack or the template.
 */
async function materializeDraft(
  user: User,
  person: Person,
  kind: MessageKind,
  channel: 'gmail' | 'linkedin',
  s?: Suggestion,
  inputs: DraftInputs = {},
  chat?: CoffeeChat,
): Promise<{
  out: ReturnType<typeof generateDraft>;
  generatedBy: OutboundMessage['generatedBy'];
  ctx: DraftContext;
}> {
  const ctx = await buildDraftContext(user, person, kind, channel, s, inputs, chat);
  const template = generateDraft(ctx);
  let out = template;
  let generatedBy: OutboundMessage['generatedBy'] = 'template';
  const opts = (context: string) => ({
    kind,
    facts: ctx.facts,
    allowedUrls: [ctx.user.schedulingLink ?? '', user.linkedinUrl ?? ''].filter(Boolean),
    recipientEmail: person.primaryEmail,
    recipientFirstName: person.firstName,
    recipientFullName: person.displayName,
    recentOpenings: ctx.recentOpenings,
    hadConversation: kind === 'referral_ask' ? !!(ctx.chat?.completedAt || ctx.chat?.meetingAt) : undefined,
    channel,
    context,
    asks: kind === 'schedule' || kind === 'reply' ? ctx.thread?.asksOfUser : undefined,
  });
  if (hasLlm() && !template.needsInput.length) {
    const llm = await llmDraft(ctx, template).catch(() => undefined);
    if (llm) {
      const grounded = `${contextText(ctx)}\n${template.subject ?? ''}\n${template.body}\n${template.bodyShort ?? ''}`;
      const issues = validateDraft(llm, opts(grounded));
      if (!isBlocked(issues)) {
        out = { ...llm, needsInput: [], sector: template.sector, register: template.register };
        generatedBy = 'llm';
      }
    }
  }
  return { out, generatedBy, ctx };
}

/**
 * Where a draft goes: the chat's thread for replies, nothing for kinds that open a new thread, except outreach that
 * picks an earlier exchange with the person back up (see `history` in buildDraftContext).
 */
async function threadFor(
  kind: MessageKind,
  chat: CoffeeChat | undefined,
  ctx: DraftContext,
): Promise<{ externalThreadId?: string; inReplyTo?: string }> {
  const threadId = NEW_THREAD_KINDS.has(kind)
    ? kind === 'outreach' && ctx.thread?.inThread
      ? ctx.history?.threadId
      : undefined
    : chat?.threadId;
  if (!threadId) return {};
  const th = await db.threads.get(threadId);
  if (!th?.externalThreadId) return {};
  const last = (await db.messages.where('threadId').equals(threadId).sortBy('sentAt')).pop();
  return { externalThreadId: th.externalThreadId, inReplyTo: last?.headers['message-id'] };
}

function bodyFor(
  out: ReturnType<typeof generateDraft>,
  channel: 'gmail' | 'linkedin',
  kind: MessageKind,
  connected: boolean,
): string {
  // LinkedIn: a connection note (<= 300 chars) for people we are not connected to; a message otherwise
  if (channel === 'linkedin' && kind === 'outreach' && out.bodyShort && !connected) return out.bodyShort;
  return out.body;
}

export async function draftForSuggestion(
  user: User,
  s: Suggestion,
  now = new Date(),
): Promise<OutboundMessage | undefined> {
  const kind = DRAFT_KIND[s.kind];
  if (!kind || !s.personId) return undefined;
  const person = await db.people.get(s.personId);
  if (!person) return undefined;
  const channel: 'gmail' | 'linkedin' =
    (s.payload.channel as 'gmail' | 'linkedin' | undefined) ?? (person.primaryEmail ? 'gmail' : 'linkedin');
  const { out, generatedBy, ctx } = await materializeDraft(user, person, kind, channel, s);
  const chat = s.chatId && kind !== 'report_back' ? await db.chats.get(s.chatId) : undefined;
  const { externalThreadId, inReplyTo } = await threadFor(kind, chat, ctx);
  const msg: OutboundMessage = {
    id: newId('out'),
    userId: user.id,
    personId: person.id,
    chatId: chat?.id,
    suggestionId: s.id,
    channel,
    kind,
    externalThreadId,
    inReplyToMessageId: inReplyTo,
    toEmail: person.primaryEmail,
    toLinkedinUrl: person.linkedinUrl,
    // a reply in an existing thread keeps the thread's subject; anything else carries the subject the template
    // wrote for its kind (never a generic "Quick question" on a check-in or a thank-you)
    subject: externalThreadId && kind !== 'outreach' ? undefined : out.subject,
    bodyDraft: bodyFor(out, channel, kind, !!person.linkedinConnectedOn),
    status: 'draft',
    generatedBy,
    claims: out.claims,
    needsInput: out.needsInput.length ? out.needsInput : undefined,
    opening: out.opening,
    createdAt: now.toISOString(),
  };
  await db.outbound.add(msg);
  await db.suggestions.update(s.id, { outboundMessageId: msg.id });
  return msg;
}

export async function draftMessage(
  user: User,
  personId: string,
  kind: MessageKind,
  channel: 'gmail' | 'linkedin',
  chatId?: string,
  inputs: DraftInputs = {},
): Promise<OutboundMessage> {
  const person = (await db.people.get(personId))!;
  const chat = chatId
    ? await db.chats.get(chatId)
    : await db.chats
        .where('personId')
        .equals(personId)
        .filter((c) => c.stage !== 'archived')
        .first();
  const { out, generatedBy, ctx } = await materializeDraft(
    user,
    person,
    kind,
    channel,
    undefined,
    inputs,
    chat,
  );
  const where = await threadFor(kind, chat, ctx);
  const msg: OutboundMessage = {
    id: newId('out'),
    userId: user.id,
    personId,
    chatId: chat?.id,
    channel,
    kind,
    externalThreadId: where.externalThreadId,
    inReplyToMessageId: where.inReplyTo,
    toEmail: person.primaryEmail,
    toLinkedinUrl: person.linkedinUrl,
    subject: out.subject,
    bodyDraft: bodyFor(out, channel, kind, !!person.linkedinConnectedOn),
    status: 'draft',
    generatedBy,
    claims: out.claims,
    needsInput: out.needsInput.length ? out.needsInput : undefined,
    opening: out.opening,
    createdAt: new Date().toISOString(),
  };
  await db.outbound.add(msg);
  return msg;
}

/**
 * Re-draft an existing message with what the student supplied (a connection line, an update). The connection line
 * is kept as a fact on the person so later drafts (bumps, LinkedIn note) can reuse it.
 */
export async function regenerateDraft(
  user: User,
  messageId: string,
  inputs: DraftInputs,
): Promise<OutboundMessage | undefined> {
  const msg = await db.outbound.get(messageId);
  if (!msg || msg.userId !== user.id || msg.status !== 'draft') return undefined;
  const person = await db.people.get(msg.personId);
  if (!person) return undefined;
  const now = new Date();
  if (inputs.connection?.trim()) {
    const text = inputs.connection.trim().replace(/\s+/g, ' ');
    const dup = await db.facts
      .where('personId')
      .equals(person.id)
      .filter((f) => f.type === 'connection' && !f.deletedAt && f.text === text)
      .first();
    if (!dup)
      await db.facts.add({
        id: newId('f'),
        userId: user.id,
        personId: person.id,
        type: 'connection',
        text,
        sourceTable: 'outbound',
        sourceId: msg.id,
        occurredAt: now.toISOString(),
        confidence: 1,
        createdAt: now.toISOString(),
      });
  }
  const s = msg.suggestionId ? await db.suggestions.get(msg.suggestionId) : undefined;
  const chat = msg.chatId ? await db.chats.get(msg.chatId) : undefined;
  const { out, generatedBy } = await materializeDraft(
    user,
    person,
    msg.kind,
    msg.channel as 'gmail' | 'linkedin',
    s,
    inputs,
    chat,
  );
  const changes: Partial<OutboundMessage> = {
    subject: msg.externalThreadId ? msg.subject : (out.subject ?? msg.subject),
    bodyDraft: bodyFor(out, msg.channel as 'gmail' | 'linkedin', msg.kind, !!person.linkedinConnectedOn),
    bodyFinal: undefined,
    bodyFinalHash: undefined,
    generatedBy,
    claims: out.claims,
    needsInput: out.needsInput.length ? out.needsInput : undefined,
    opening: out.opening,
  };
  await db.outbound.update(messageId, changes);
  await feedback(user.id, 'edit', {
    outboundMessageId: messageId,
    reason: `input:${Object.keys(inputs).join(',')}`,
  } as never);
  return { ...msg, ...changes };
}

/**
 * Redraft pending suggestion drafts the student has not touched when what they were drafted from has changed: notes
 * with new facts arrived after a thank-you was drafted, or the calendar changed under proposed windows. The draft
 * keeps its id; a redraft that would ask the student for something the current draft already has is not applied.
 */
export async function refreshPendingDrafts(
  user: User,
  scope: { personId?: string; kinds?: MessageKind[] } = {},
): Promise<number> {
  const pending = await db.suggestions
    .where('userId')
    .equals(user.id)
    .filter(
      (s) =>
        s.status === 'pending' && !!s.outboundMessageId && (!scope.personId || s.personId === scope.personId),
    )
    .toArray();
  let changed = 0;
  for (const s of pending) {
    const d = await db.outbound.get(s.outboundMessageId!);
    if (d?.status !== 'draft' || d.bodyFinal !== undefined) continue;
    if (scope.kinds && !scope.kinds.includes(d.kind)) continue;
    const person = await db.people.get(d.personId);
    if (!person) continue;
    const chat = d.chatId ? await db.chats.get(d.chatId) : undefined;
    const { out, generatedBy } = await materializeDraft(
      user,
      person,
      d.kind,
      d.channel as 'gmail' | 'linkedin',
      s,
      {},
      chat,
    );
    const body = bodyFor(out, d.channel as 'gmail' | 'linkedin', d.kind, !!person.linkedinConnectedOn);
    if (body === d.bodyDraft) continue;
    if (out.needsInput.length > (d.needsInput?.length ?? 0)) continue;
    await db.outbound.update(d.id, {
      subject: d.externalThreadId ? d.subject : (out.subject ?? d.subject),
      bodyDraft: body,
      generatedBy,
      claims: out.claims,
      needsInput: out.needsInput.length ? out.needsInput : undefined,
      opening: out.opening,
    });
    changed++;
  }
  return changed;
}

/** ⚡ rules: run the rule engine for one chat/person right away (reply received, note ingested, event changed). */
export async function evaluateImmediateSuggestions(
  userId: string,
  scope: { chatId?: string; personId?: string },
  now = new Date(),
): Promise<void> {
  const user = await db.users.get(userId);
  if (!user || !user.onboardingCompletedAt) return;
  const inp = await ruleInput(userId, now, scope);
  const cands = generateCandidates(inp).filter((c) =>
    [
      'thank_you',
      'schedule_propose',
      'schedule_confirm',
      'prep_brief',
      'warm_up_engage',
      'ask_referral',
      'report_back',
    ].includes(c.kind),
  );
  await retireStale(
    userId,
    cands,
    new Set(inp.chats.map((c) => c.id)),
    ['thank_you', 'schedule_propose', 'schedule_confirm', 'prep_brief'],
    now,
  );
  const scored = selectForBrief(cands, inp.dismissCounts, 5);
  const created = await upsertSuggestions(userId, scored, now);
  for (const s of created)
    if (!s.outboundMessageId && DRAFT_KIND[s.kind]) await draftForSuggestion(user, s, now);
  await addConfirmationCards(userId, now);
}

/** Suggestions that describe the state of a chat right now; they stop being true when that state changes. */
const STATE_KINDS: SuggestionKind[] = [
  'thank_you',
  'schedule_propose',
  'schedule_confirm',
  'prep_brief',
  'follow_up_bump',
];

/**
 * Retire pending suggestions whose trigger is gone: a "confirm Thursday at 2pm" card once the chat is scheduled, a
 * thank-you once it was sent from Gmail, times to propose once the meeting is on the calendar. Only chats the rules
 * just looked at are touched, and only the kinds they were asked to produce.
 */
async function retireStale(
  userId: string,
  cands: { dedupeKey: string }[],
  chatIds: Set<string>,
  kinds: SuggestionKind[],
  now: Date,
): Promise<void> {
  const live = new Set(cands.map((c) => c.dedupeKey));
  const stale = await db.suggestions
    .where('userId')
    .equals(userId)
    .filter(
      (s) =>
        s.status === 'pending' &&
        kinds.includes(s.kind) &&
        !!s.chatId &&
        chatIds.has(s.chatId) &&
        !live.has(s.dedupeKey),
    )
    .toArray();
  for (const s of stale)
    await db.suggestions.update(s.id, { status: 'expired', decidedAt: now.toISOString() });
}

async function addConfirmationCards(userId: string, now: Date): Promise<void> {
  const proposed = await db.stageEvents
    .where('userId')
    .equals(userId)
    .filter((e) => e.status === 'proposed')
    .toArray();
  for (const e of proposed) {
    const chat = await db.chats.get(e.chatId);
    const person = chat ? await db.people.get(chat.personId) : undefined;
    if (!chat || !person) continue;
    await upsertSuggestions(
      userId,
      [
        {
          kind: 'confirm_stage',
          personId: person.id,
          chatId: chat.id,
          dedupeKey: `stage:${e.id}`,
          reasonText: `Looks like ${person.firstName} ${describeStage(e.toStage)}. Move to ${e.toStage.replace('_', ' ')}?`,
          signals: { confidence: e.confidence },
          payload: { stageEventId: e.id, toStage: e.toStage },
          urgency: 0.85,
          goalRelevance: 0.5,
          confidence: e.confidence ?? 0.7,
          priorityScore: 0.6,
        },
      ],
      now,
    );
  }
  const merges = await db.merges
    .where('userId')
    .equals(userId)
    .filter((m) => m.status === 'pending')
    .toArray();
  for (const m of merges) {
    const [a, b] = await Promise.all([db.people.get(m.personAId), db.people.get(m.personBId)]);
    if (!a || !b) continue;
    await upsertSuggestions(
      userId,
      [
        {
          kind: 'confirm_merge',
          personId: a.id,
          dedupeKey: `merge:${m.id}`,
          reasonText: `Are ${a.displayName} and ${b.displayName} the same person?`,
          signals: { score: m.score },
          payload: { mergeId: m.id, otherPersonId: b.id },
          urgency: 0.4,
          goalRelevance: 0.3,
          confidence: m.score,
          priorityScore: 0.25,
        },
      ],
      now,
    );
  }
  const unmatched = await db.notes
    .where('userId')
    .equals(userId)
    .filter((n) => n.matchStatus === 'unmatched')
    .toArray();
  for (const n of unmatched) {
    await upsertSuggestions(
      userId,
      [
        {
          kind: 'confirm_note_match',
          dedupeKey: `note:${n.id}`,
          reasonText: `Who was "${n.title ?? 'this note'}" with?`,
          signals: {},
          payload: { noteId: n.id },
          urgency: 0.5,
          goalRelevance: 0.3,
          confidence: 1,
          priorityScore: 0.3,
        },
      ],
      now,
    );
  }
}

function describeStage(stage: string): string {
  return (
    {
      replied: 'replied',
      scheduling: 'wants to schedule',
      scheduled: 'is booked',
      completed: 'met with you',
      declined: 'declined',
      no_response: 'went quiet',
    }[stage] ?? `moved to ${stage}`
  );
}

export async function generateBrief(user: User, kind: Brief['kind'], now = new Date()): Promise<Brief> {
  const briefDate = todayKey(now, user.timezone);
  const existing = await db.briefs
    .where('[userId+kind+briefDate]')
    .equals([user.id, kind, briefDate])
    .first();
  const settings = await db.settings.get(user.id);
  await runTimedStageRules(user.id, settings?.maxBumps ?? 2, now);
  await recomputeAllStrengths(user.id, now);
  const inp = await ruleInput(user.id, now);
  const cands = generateCandidates(inp);
  await retireStale(user.id, cands, new Set(inp.chats.map((c) => c.id)), [...STATE_KINDS], now);
  const selected = selectForBrief(cands, inp.dismissCounts, 7);
  const briefId = existing?.id ?? newId('b');
  const sugg = await upsertSuggestions(user.id, selected, now, briefId);
  await addConfirmationCards(user.id, now);
  for (const s of sugg)
    if (!s.outboundMessageId && DRAFT_KIND[s.kind]) await draftForSuggestion(user, s, now);
  // carry-over / expiry of older pending suggestions
  const pending = await db.suggestions
    .where('userId')
    .equals(user.id)
    .filter((s) => s.status === 'pending' && s.briefId !== briefId && !!s.briefId)
    .toArray();
  for (const s of pending) {
    if (s.carriedOver >= 1) {
      await db.suggestions.update(s.id, { status: 'expired', decidedAt: now.toISOString() });
      await feedback(user.id, 'expire', { suggestionId: s.id });
    } else await db.suggestions.update(s.id, { carriedOver: s.carriedOver + 1 });
  }
  const upcoming = inp.events.filter(
    (e) =>
      e.status !== 'cancelled' &&
      e.isCoffeeChat &&
      new Date(e.startAt) > now &&
      new Date(e.startAt).getTime() - now.getTime() < 7 * DAY,
  );
  const counts = new Map<string, number>();
  for (const s of sugg) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  const parts: string[] = [];
  const label = (k: string, n: number) =>
    ({
      follow_up_bump: `${n} follow-up${n > 1 ? 's' : ''}`,
      thank_you: `${n} thank-you${n > 1 ? 's' : ''}`,
      schedule_propose: `${n} to schedule`,
      schedule_confirm: `${n} time to confirm`,
      prep_brief: `${n} chat to prep`,
      warm_up_engage: `${n} LinkedIn warm-up${n > 1 ? 's' : ''}`,
      new_outreach: `${n} new ${n > 1 ? 'people' : 'person'} to message`,
      nurture_checkin: `${n} check-in`,
      reconnect: `${n} reconnect`,
      ask_referral: `${n} referral ask`,
      action_item_reminder: `${n} promise to keep`,
      intro_request: `${n} intro ask`,
      report_back: `${n} loop to close`,
      confirm_stage: `${n} to confirm`,
    })[k] ?? `${n} ${k.replace(/_/g, ' ')}`;
  for (const [k, n] of counts) parts.push(label(k, n));
  const summaryText = sugg.length
    ? `${parts.join(', ')}${upcoming.length ? `; ${upcoming.length} chat${upcoming.length > 1 ? 's' : ''} coming up this week` : ''}.`
    : upcoming.length
      ? `Nothing to send today. ${upcoming.length} chat${upcoming.length > 1 ? 's' : ''} coming up this week.`
      : 'Nothing to do today — your network is in good shape.';
  const brief: Brief = {
    id: briefId,
    userId: user.id,
    kind,
    briefDate,
    generatedAt: now.toISOString(),
    suggestionIds: sugg.map((s) => s.id),
    summaryText,
    stats: { candidates: cands.length, shown: sugg.length, upcoming: upcoming.length },
  };
  await db.briefs.put(brief);
  if (!existing)
    await notify(
      user.id,
      'brief',
      kind === 'welcome' ? 'Your first brief is ready' : `Today: ${summaryText}`,
      undefined,
      '/today',
    );
  return brief;
}

export async function refreshPersonSummary(user: User, personId: string): Promise<void> {
  const person = await db.people.get(personId);
  if (!person) return;
  const facts = (await db.facts.where('personId').equals(personId).toArray()).filter((f) => !f.deletedAt);
  const tps = (await db.touchpoints.where('personId').equals(personId).toArray())
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, 10);
  const goals = await db.goals.get(user.id);
  let summary: string | undefined;
  let talkingPoints: string[] | undefined;
  if (hasLlm() && (facts.length || tps.length)) {
    const r = await llmSummary(
      person.displayName,
      facts.map((f) => ({ type: f.type, text: f.text })),
      tps.map((t) => `${t.occurredAt.slice(0, 10)}: ${t.summary ?? t.kind}`),
      goals?.cycleLabel ?? '',
    ).catch(() => undefined);
    if (r) {
      summary = r.summary;
      talkingPoints = r.talkingPoints;
    }
  }
  if (!summary) {
    const role =
      person.currentTitle && person.currentOrganizationRaw
        ? `${person.currentTitle} at ${person.currentOrganizationRaw}`
        : (person.headline ?? 'a contact');
    const adv = facts.find((f) => f.type === 'advice');
    const off = facts.find((f) => f.type === 'offer');
    const hook = facts.find((f) => f.type === 'hook');
    const n = tps.length;
    summary = `${person.firstName} is ${role}${person.isAlumni ? ` and a ${user.school} alum` : ''}. ${n ? `You have ${n} recent interaction${n === 1 ? '' : 's'}, most recently ${tps[0]!.occurredAt.slice(0, 10)}.` : 'No interactions yet.'}${adv ? ` Advice: ${adv.text.replace(/\.$/, '')}.` : ''}${off ? ` They offered: ${off.text.replace(/\.$/, '')}.` : ''}`;
    talkingPoints = [
      hook ? `Ask about: ${hook.text}` : undefined,
      off ? `Follow up on their offer: ${off.text}` : undefined,
      adv ? `Report back on their advice: ${adv.text}` : undefined,
      person.currentOrganizationRaw
        ? `What's changed at ${person.currentOrganizationRaw} recently`
        : undefined,
    ]
      .filter((x): x is string => !!x)
      .slice(0, 5);
  }
  await db.people.update(personId, { summary, summaryUpdatedAt: new Date().toISOString(), talkingPoints });
}

export async function startWarmUpOrOutreach(
  user: User,
  personId: string,
  channel: 'gmail' | 'linkedin',
  source: CoffeeChat['source'] = 'manual',
): Promise<{ chat: CoffeeChat; draft?: OutboundMessage }> {
  const settings = await db.settings.get(user.id);
  const person = (await db.people.get(personId))!;
  const now = new Date();
  let chat = await db.chats
    .where('personId')
    .equals(personId)
    .filter((c) => !['declined', 'no_response', 'archived'].includes(c.stage))
    .first();
  const cold =
    person.strength < 0.2 &&
    channel === 'linkedin' &&
    !!person.linkedinSlug &&
    (settings?.warmUpEnabled ?? true);
  if (!chat) {
    const referrer = await findReferrerFor(user.id, person);
    chat = {
      id: newId('c'),
      userId: user.id,
      personId,
      organizationId: person.currentOrganizationId,
      stage: cold ? 'warming' : 'identified',
      stageEnteredAt: now.toISOString(),
      source,
      goalTags: [],
      outreachChannel: channel,
      bumpCount: 0,
      priority: 2,
      warmUp: cold ? buildWarmUpPlan(person.linkedinSlug!, now, settings?.warmUpDays ?? 4) : undefined,
      referrerPersonId: referrer?.id,
      referrerName: referrer?.firstName,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await db.chats.add(chat);
    await db.stageEvents.add({
      id: newId('se'),
      userId: user.id,
      chatId: chat.id,
      toStage: chat.stage,
      status: 'applied',
      actor: 'user',
      reason: cold ? 'warmup:started' : 'user:start',
      createdAt: now.toISOString(),
      decidedAt: now.toISOString(),
    });
  }
  await db.recommendations.where('personId').equals(personId).modify({ status: 'converted' });
  if (chat.stage === 'warming') {
    await evaluateImmediateSuggestions(user.id, { chatId: chat.id, personId }, now);
    return { chat };
  }
  const draft = await draftMessage(user, personId, 'outreach', channel, chat.id);
  return { chat, draft };
}

export async function markWarmUpAction(
  userId: string,
  chatId: string,
  actionId: string,
  done: boolean,
  note?: string,
): Promise<void> {
  const chat = await db.chats.get(chatId);
  if (!chat?.warmUp) return;
  const now = new Date().toISOString();
  const actions = chat.warmUp.actions.map((a) =>
    a.id === actionId
      ? {
          ...a,
          doneAt: done ? now : a.doneAt,
          skippedAt: done ? a.skippedAt : now,
          note: note?.trim() ? note.trim() : a.note,
        }
      : a,
  );
  await db.chats.update(chatId, { warmUp: { ...chat.warmUp, actions }, updatedAt: now });
  if (done) {
    await db.touchpoints.add({
      id: newId('tp'),
      userId,
      personId: chat.personId,
      kind: 'linkedin_engaged',
      occurredAt: now,
      refTable: 'warmup',
      refId: `${chatId}:${actionId}`,
      summary: note?.trim()
        ? `Engaged with their post: ${note.trim().slice(0, 80)}`
        : 'Engaged with their LinkedIn activity',
      weight: 0.15,
    });
  }
  await feedback(userId, done ? 'warmup_done' : 'warmup_skip', {
    refTable: 'chats',
    refId: chatId,
    reason: actionId,
  });
  await db.suggestions
    .where('dedupeKey')
    .equals(`warm:${chatId}:${actionId}`)
    .modify({ status: 'done', decidedAt: now });
  const user = await db.users.get(userId);
  if (user) await evaluateImmediateSuggestions(userId, { chatId, personId: chat.personId });
}

export async function recommendationsRefresh(user: User, now = new Date()): Promise<number> {
  const { recommendPeople } = await import('@orbit/core');
  const [goals, targetCompanies, resumeFacets, people, chats, existing] = await Promise.all([
    db.goals.get(user.id),
    db.targetCompanies.where('userId').equals(user.id).toArray(),
    db.resumeFacets.toArray(),
    db.people.where('userId').equals(user.id).toArray(),
    db.chats.where('userId').equals(user.id).toArray(),
    db.recommendations.where('userId').equals(user.id).toArray(),
  ]);
  if (!goals) return 0;
  const { g } = await buildReachGraph(user.id);
  const recent = new Set(
    existing
      .filter(
        (r) =>
          r.status === 'dismissed' ||
          (r.status === 'new' && now.getTime() - new Date(r.batchDate).getTime() < 14 * DAY),
      )
      .map((r) => r.personId),
  );
  const recs = recommendPeople({
    userId: user.id,
    user: { school: user.school, majors: user.majors, gradYear: user.graduationYear },
    goals,
    targetCompanies,
    resumeFacets,
    people,
    chats,
    pathStrength: (id) => bestPathStrength(g, id),
    recentlyRecommended: recent,
    now,
  });
  for (const r of recs) {
    r.bestPath = undefined;
    const prev = existing.find((e) => e.personId === r.personId && e.status === 'saved');
    if (prev) continue;
    await db.recommendations
      .where('personId')
      .equals(r.personId)
      .filter((e) => e.status === 'new')
      .delete();
    await db.recommendations.put(r);
  }
  return recs.length;
}

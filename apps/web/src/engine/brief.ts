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
  defaultStyleCard,
  generateCandidates,
  generateDraft,
  isBlocked,
  newId,
  STAGE_LABELS,
  selectForBrief,
  suggestionFromCandidate,
  todayKey,
  validateDraft,
  warmUpProgress,
} from '@orbit/core';
import { feedback, notify, recomputeAllStrengths } from '../db/repo';
import { db } from '../db/schema';
import { describeLlmFailure, hasLlm, llmDraft, llmSummary, toLlmError } from '../integrations/anthropic';
import { bestPathStrength, buildReachGraph } from './graph';
import { personSummary } from './prep';
import { runTimedStageRules } from './stages';

const DAY = 86_400_000;

const surfacedLlmFailures = new Set<string>();

/**
 * Tell the student, once, that a Claude call failed and why (bad key, network, refusal, daily
 * limit). Orbit keeps working on templates and rules. One notification per user and reason while
 * an unread one exists, so a failing key during a 300-thread sync produces one notice, not 300.
 * Always resolves to undefined so callers can use it as their `.catch` fallback.
 */
export async function surfaceLlmFailure(userId: string, e: unknown): Promise<undefined> {
  const err = toLlmError(e);
  const { title, body } = describeLlmFailure(err);
  const key = `${userId}:${err.reason}`;
  if (surfacedLlmFailures.has(key)) return undefined;
  surfacedLlmFailures.add(key);
  try {
    const open = await db.notifications
      .where('userId')
      .equals(userId)
      .filter((n) => !n.readAt && n.kind === 'integration_problem' && n.title === title)
      .first();
    if (!open) await notify(userId, 'integration_problem', title, body, '/settings/integrations');
  } finally {
    // the in-memory key only serialises concurrent failures; the unread notification is the lasting guard
    surfacedLlmFailures.delete(key);
  }
  return undefined;
}

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

/** Extra, user-supplied inputs for a draft (from the needs-input prompt in the editor). */
export interface DraftInputs {
  /** one line only true of the recipient: how the student found them, what they share, what of theirs they read */
  connection?: string;
  /** one real update since the last conversation (nurture) */
  update?: string;
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
      const first = f.text.split(/(?<=[.!?])\s+/)[0] ?? f.text;
      const line = first.replace(/\s+/g, ' ').trim().replace(/\.$/, '');
      return { line, score: score(line) + (f.kind === 'project' ? 0.5 : 0), len: line.length };
    })
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
  const [goals, settings, style, facts, resumeFacets, chatFound, affiliations, org] = await Promise.all([
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
  ]);
  // a report-back is addressed to the referrer; the chat on the suggestion is the target's chat
  const chat = kind === 'report_back' ? undefined : chatFound;
  const summary = resumeFacets.find((f) => f.kind === 'summary')?.text;
  let thread: DraftContext['thread'];
  if (chat?.threadId) {
    const msgs = await db.messages.where('threadId').equals(chat.threadId).sortBy('sentAt');
    const lastIn = [...msgs].reverse().find((m) => m.direction === 'inbound');
    const firstOut = msgs.find((m) => m.direction === 'outbound');
    thread = {
      lastInboundBody: lastIn?.bodyText,
      lastInboundAt: lastIn?.sentAt,
      firstOutboundAt: firstOut?.sentAt ?? chat.firstOutreachAt,
      asksOfUser: lastIn?.extraction?.asksOfUser,
      proposedTimes: lastIn?.extraction?.proposedTimes.map((t) => ({ startIso: t.startIso, raw: t.raw })),
      lastSignal: lastIn?.signal,
    };
  } else if (chat?.firstOutreachAt) thread = { firstOutboundAt: chat.firstOutreachAt };
  const tcId = s?.payload.targetCompanyId as string | undefined;
  const tc = tcId
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
  const target = s?.payload.target as DraftContext['target'] | undefined;
  if (target && !target.firstName) target.firstName = target.name.split(' ')[0];
  const windows = (s?.payload.windows as string[] | undefined)?.map((w) => ({ startIso: w }));
  const warm = chat?.warmUp ? warmUpProgress(chat.warmUp, now) : undefined;
  const warmUpNote = chat?.warmUp?.actions.find((a) => a.doneAt && a.note)?.note;
  // previous employer: the most recent non-current employment affiliation
  const previous = affiliations
    .filter(
      (a) =>
        a.kind === 'employment' && !a.isCurrent && a.nameRaw && a.nameRaw !== person.currentOrganizationRaw,
    )
    .sort((a, b) => (b.endDate ?? b.startDate ?? '').localeCompare(a.endDate ?? a.startDate ?? ''))[0];
  // referrer: on the chat, or the person who received an intro request for this person
  let referrerName = chat?.referrerName;
  if (!referrerName && chat?.referrerPersonId)
    referrerName = (await db.people.get(chat.referrerPersonId))?.firstName;
  if (!referrerName && kind === 'outreach')
    referrerName = (await findReferrerFor(user.id, person))?.firstName;
  // openings used for the same company in the last 30 days (avoid repeating ourselves across a team)
  const sameOrg = person.currentOrganizationRaw
    ? (await db.people.where('userId').equals(user.id).toArray()).filter(
        (p) =>
          p.id !== person.id &&
          (p.currentOrganizationRaw ?? '').toLowerCase() === person.currentOrganizationRaw!.toLowerCase(),
      )
    : [];
  const recentOpenings: string[] = [];
  for (const p of sameOrg) {
    const rows = await db.outbound.where('personId').equals(p.id).toArray();
    for (const r of rows)
      if (r.opening && now.getTime() - new Date(r.sentAt ?? r.createdAt).getTime() < 30 * DAY)
        recentOpenings.push(r.opening);
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
  if (userConnection)
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
      cycleLabel: goals?.cycleLabel ?? 'this recruiting cycle',
      targetFunctions: goals?.targetFunctions ?? [],
      oneLiner: summary
        ? summary
            .replace(/^.*? is /, `${user.firstName} is `)
            .replace(/\.$/, '')
            .replace(new RegExp(`^${user.firstName} is `), '')
        : undefined,
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
      previousOrg: previous?.nameRaw,
      previousTitle: previous?.title,
    },
    facts: factList,
    kind,
    channel,
    bumpNumber: (chat?.bumpCount ?? 0) + 1,
    proposedWindows: windows,
    thread,
    target,
    chat: chat
      ? {
          completedAt: chat.completedAt,
          stage: chat.stage,
          referrerName,
          warmUpNote,
          warmUpDone: warm?.done,
        }
      : referrerName
        ? { referrerName }
        : undefined,
    update: inputs.update?.trim() || undefined,
    targetCompany: tc
      ? {
          name: tc.nameRaw,
          roleLabel: goals?.targetRoles[0],
          applied: tc.status === 'applied' || tc.status === 'interviewing',
        }
      : undefined,
    reportBack,
    recentOpenings,
    seed: person.id,
    now,
  };
}

/** Template first; the LLM may improve voice and specificity only if its result passes the same validator. */
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
  if (hasLlm() && !template.needsInput.length) {
    const llm = await llmDraft(ctx, template).catch((e) => surfaceLlmFailure(user.id, e));
    if (llm) {
      const issues = validateDraft(llm, {
        kind,
        facts: ctx.facts,
        allowedUrls: [ctx.user.schedulingLink ?? '', user.linkedinUrl ?? ''].filter(Boolean),
        recipientEmail: person.primaryEmail,
        recipientFirstName: person.firstName,
        recipientFullName: person.displayName,
        recentOpenings: ctx.recentOpenings,
        hadConversation: kind === 'referral_ask' ? !!ctx.chat?.completedAt : undefined,
        channel,
      });
      if (!isBlocked(issues)) {
        out = { ...llm, needsInput: [], sector: template.sector, register: template.register };
        generatedBy = 'llm';
      }
    }
  }
  return { out, generatedBy, ctx };
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
  const { out, generatedBy } = await materializeDraft(user, person, kind, channel, s);
  const chat = s.chatId && kind !== 'report_back' ? await db.chats.get(s.chatId) : undefined;
  let externalThreadId: string | undefined;
  let inReplyTo: string | undefined;
  if (chat?.threadId && kind !== 'outreach') {
    const th = await db.threads.get(chat.threadId);
    externalThreadId = th?.externalThreadId;
    const last = (await db.messages.where('threadId').equals(chat.threadId).sortBy('sentAt')).pop();
    inReplyTo = last?.headers['message-id'];
  }
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
    subject: out.subject ?? (externalThreadId ? undefined : `Quick question`),
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
  const { out, generatedBy } = await materializeDraft(user, person, kind, channel, undefined, inputs, chat);
  const th = chat?.threadId ? await db.threads.get(chat.threadId) : undefined;
  const msg: OutboundMessage = {
    id: newId('out'),
    userId: user.id,
    personId,
    chatId: chat?.id,
    channel,
    kind,
    externalThreadId: kind === 'outreach' ? undefined : th?.externalThreadId,
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

/** ⚡ rules: run the rule engine for one chat/person right away (reply received, note ingested, event changed). */
export async function evaluateImmediateSuggestions(
  userId: string,
  scope: { chatId?: string; personId?: string },
  now = new Date(),
): Promise<void> {
  const user = await db.users.get(userId);
  if (!user || !user.onboardingCompletedAt) return;
  const inp = await ruleInput(userId, now, scope);
  const cands = generateCandidates(inp).filter(
    (c) =>
      [
        'thank_you',
        'schedule_propose',
        'schedule_confirm',
        'prep_brief',
        'warm_up_engage',
        'ask_referral',
        'report_back',
      ].includes(c.kind) ||
      // an intro that just landed is answered while it is fresh, not at the next brief
      (c.kind === 'new_outreach' && !!c.signals.introducedBy),
  );
  const scored = selectForBrief(cands, inp.dismissCounts, 5);
  const created = await upsertSuggestions(userId, scored, now);
  for (const s of created)
    if (!s.outboundMessageId && DRAFT_KIND[s.kind]) await draftForSuggestion(user, s, now);
  await addConfirmationCards(userId, now);
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
          reasonText: `Looks like ${person.firstName} ${describeStage(e.toStage)}. Mark this chat as ${STAGE_LABELS[e.toStage].toLowerCase()}?`,
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

const BRIEF_LABELS: Record<SuggestionKind, (n: number) => string> = {
  follow_up_bump: (n) => `${n} follow-up${n > 1 ? 's' : ''}`,
  thank_you: (n) => `${n} thank-you${n > 1 ? 's' : ''}`,
  schedule_propose: (n) => `${n} to schedule`,
  schedule_confirm: (n) => `${n} time${n > 1 ? 's' : ''} to confirm`,
  prep_brief: (n) => `${n} chat${n > 1 ? 's' : ''} to prep`,
  warm_up_engage: (n) => `${n} LinkedIn warm-up${n > 1 ? 's' : ''}`,
  new_outreach: (n) => `${n} new ${n > 1 ? 'people' : 'person'} to message`,
  nurture_checkin: (n) => `${n} check-in${n > 1 ? 's' : ''}`,
  reconnect: (n) => `${n} to reconnect with`,
  congratulate: (n) => `${n} to congratulate`,
  ask_referral: (n) => `${n} referral ask${n > 1 ? 's' : ''}`,
  action_item_reminder: (n) => `${n} promise${n > 1 ? 's' : ''} to keep`,
  intro_request: (n) => `${n} intro ask${n > 1 ? 's' : ''}`,
  report_back: (n) => `${n} loop${n > 1 ? 's' : ''} to close`,
  confirm_stage: (n) => `${n} update${n > 1 ? 's' : ''} to confirm`,
  confirm_merge: (n) => `${n} possible duplicate${n > 1 ? 's' : ''}`,
  confirm_note_match: (n) => `${n} note${n > 1 ? 's' : ''} to match`,
};

/** The one-line summary at the top of Today. It always names a real next step, never "all good" on an empty network. */
export function briefSummaryText(counts: Map<string, number>, upcoming: number, peopleCount: number): string {
  const parts = [...counts].map(([k, n]) => BRIEF_LABELS[k as SuggestionKind]?.(n) ?? `${n} to review`);
  const coming = upcoming ? `${upcoming} chat${upcoming > 1 ? 's' : ''} coming up this week` : '';
  if (parts.length) return `${parts.join(', ')}${coming ? `; ${coming}` : ''}.`;
  if (coming) return `Nothing to send today. ${coming[0]!.toUpperCase()}${coming.slice(1)}.`;
  if (peopleCount === 0)
    return 'Orbit has nobody to work with yet. Connect Google or upload your LinkedIn connections to get your first suggestions.';
  return 'Nothing needs you today. Pick someone from Discover to start a new conversation.';
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
  const peopleCount = [...inp.people.values()].filter((p) => p.isHuman && !p.hiddenAt).length;
  const summaryText = briefSummaryText(counts, upcoming.length, peopleCount);
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
  const allTps = (await db.touchpoints.where('personId').equals(personId).toArray()).sort((a, b) =>
    b.occurredAt.localeCompare(a.occurredAt),
  );
  const tps = allTps.slice(0, 10);
  const goals = await db.goals.get(user.id);
  let summary: string | undefined;
  let talkingPoints: string[] | undefined;
  if (hasLlm() && (facts.length || tps.length)) {
    const r = await llmSummary(
      person.displayName,
      facts.map((f) => ({ type: f.type, text: f.text })),
      tps.map((t) => `${t.occurredAt.slice(0, 10)}: ${t.summary ?? t.kind}`),
      goals?.cycleLabel ?? '',
    ).catch((e) => surfaceLlmFailure(user.id, e));
    if (r) {
      summary = r.summary;
      talkingPoints = r.talkingPoints;
    }
  }
  if (!summary) {
    const t = personSummary({ user, person, facts, touchpoints: allTps, now: new Date() });
    summary = t.summary;
    talkingPoints = t.talkingPoints;
  }
  await db.people.update(personId, { summary, summaryUpdatedAt: new Date().toISOString(), talkingPoints });
}

/** A cold LinkedIn-only contact gets a few days of light engagement before the first message (13-linkedin-warm-up). */
export function needsWarmUp(
  person: Pick<Person, 'strength' | 'linkedinSlug'>,
  channel: 'gmail' | 'linkedin',
  warmUpEnabled: boolean,
): boolean {
  return person.strength < 0.2 && channel === 'linkedin' && !!person.linkedinSlug && warmUpEnabled;
}

export async function startWarmUpOrOutreach(
  user: User,
  personId: string,
  channel: 'gmail' | 'linkedin',
  source: CoffeeChat['source'] = 'manual',
  opts: { skipWarmUp?: boolean } = {},
): Promise<{ chat: CoffeeChat; draft?: OutboundMessage }> {
  const settings = await db.settings.get(user.id);
  const person = (await db.people.get(personId))!;
  const now = new Date();
  let chat = await db.chats
    .where('personId')
    .equals(personId)
    .filter((c) => !['declined', 'no_response', 'archived'].includes(c.stage))
    .first();
  const cold = !opts.skipWarmUp && needsWarmUp(person, channel, settings?.warmUpEnabled ?? true);
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
  if (chat.stage === 'warming' && !opts.skipWarmUp) {
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

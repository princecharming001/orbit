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
  isQuietDay,
  isRuleSuggestion,
  lastContactPhrase,
  newId,
  scoreCandidate,
  selectForBrief,
  staleReason,
  suggestionFromCandidate,
  todayKey,
  validateDraft,
  warmUpProgress,
} from '@orbit/core';
import { addTouchpoint, feedback, notify, recomputeAllStrengths } from '../db/repo';
import { db } from '../db/schema';
import { hasLlm, llmDraft, llmSummary } from '../integrations/anthropic';
import { bestPathStrength, buildReachGraph } from './graph';
import { retireSuggestions, runTimedStageRules } from './stages';

const DAY = 86_400_000;

async function ruleInput(userId: string, now: Date, scope?: { chatId?: string; personId?: string }) {
  const [
    user,
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
    touchpoints,
  ] = await Promise.all([
    db.users.get(userId),
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
    db.touchpoints.where('userId').equals(userId).toArray(),
  ]);
  // the last real conversation per person (not a CC, a connection or a like)
  const lastConversationByPerson = new Map<string, string>();
  for (const t of touchpoints) {
    if (!CONVERSATION_TOUCHPOINTS.has(t.kind)) continue;
    const prev = lastConversationByPerson.get(t.personId);
    if (!prev || prev < t.occurredAt) lastConversationByPerson.set(t.personId, t.occurredAt);
  }
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
      // an auto-reply or an out-of-office note is not the person answering
      .filter((m) => m.direction === 'inbound' && !m.isAutomated && m.signal !== 'out_of_office')
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
    timezone: user?.timezone,
    lastConversationByPerson,
  };
}

const CONVERSATION_TOUCHPOINTS = new Set([
  'meeting',
  'email_in',
  'email_out',
  'linkedin_in',
  'linkedin_out',
  'note',
]);

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
  opts: { deferred?: boolean } = {},
): Promise<Suggestion[]> {
  const out: Suggestion[] = [];
  const deferred = opts.deferred ? true : undefined;
  for (const c of cands) {
    const existing = await db.suggestions.where('dedupeKey').equals(c.dedupeKey).first();
    if (existing) {
      // a user decision (dismissed, sent, done, approved, edited) is final; a system expiry is not: the trigger is
      // true again, so the card comes back
      if (!['pending', 'snoozed', 'expired'].includes(existing.status)) continue;
      if (existing.status === 'snoozed' && existing.snoozedUntil && new Date(existing.snoozedUntil) > now)
        continue;
      const revived = existing.status === 'expired';
      let outboundMessageId = existing.outboundMessageId;
      if (outboundMessageId) {
        const draft = await db.outbound.get(outboundMessageId);
        if (!draft || draft.status !== 'draft') outboundMessageId = undefined;
      }
      const payload = { ...existing.payload, ...c.payload };
      const changes: Partial<Suggestion> = {
        status: 'pending',
        priorityScore: c.priorityScore,
        reasonText: c.reasonText,
        signals: c.signals,
        payload,
        briefId: deferred ? existing.briefId : (briefId ?? existing.briefId),
        deferred,
        outboundMessageId,
        expiredReason: undefined,
        snoozedUntil: undefined,
        decidedAt: undefined,
        carriedOver:
          briefId && !deferred && existing.briefId && existing.briefId !== briefId
            ? existing.carriedOver + 1
            : existing.carriedOver,
        expiresAt: new Date(now.getTime() + 2 * DAY).toISOString(),
      };
      if (revived) changes.createdAt = now.toISOString();
      await db.suggestions.update(existing.id, changes);
      const row = { ...existing, ...changes } as Suggestion;
      // proposed times moved on (windows rolled forward, a different slot): an untouched draft must follow
      if (
        outboundMessageId &&
        TIME_KINDS.has(c.kind) &&
        JSON.stringify(timesOf(existing.payload)) !== JSON.stringify(timesOf(payload))
      )
        await refreshUntouchedDraft(userId, row);
      // something new is known about them (notes, a reply, a fact typed in): a thank-you or check-in written
      // before that must use it
      else if (outboundMessageId) await refreshIfFactsNewer(userId, row);
      out.push(row);
      continue;
    }
    const s = suggestionFromCandidate(c, userId, now, newId('s'));
    s.briefId = deferred ? undefined : briefId;
    s.deferred = deferred;
    await db.suggestions.add(s);
    out.push(s);
  }
  return out;
}

const TIME_KINDS = new Set<SuggestionKind>(['schedule_propose', 'schedule_confirm']);
const timesOf = (p: Record<string, unknown>) => [p.windows ?? null, p.time ?? null];

/**
 * Re-draft a suggestion's message when what it rests on changed (times rolled forward, notes from the chat came
 * in), as long as the student has not touched it: an approved, edited or sent message is never rewritten.
 */
export async function refreshUntouchedDraft(userId: string, s: Suggestion): Promise<boolean> {
  if (!s.outboundMessageId) return false;
  const draft = await db.outbound.get(s.outboundMessageId);
  if (!draft || draft.status !== 'draft' || draft.bodyFinal) return false;
  const user = await db.users.get(userId);
  if (!user) return false;
  return !!(await regenerateDraft(user, draft.id, {}));
}

/**
 * The validity pass: every pending or snoozed rule card is checked against what is true now. A card whose rule no
 * longer fires (the chat moved on, the time passed, a newer reply arrived, the item was done) is retired as
 * `expired` with a reason. With a scope, only that chat's (or person's) cards are checked, because the rules
 * only ran for them.
 */
export async function revalidateSuggestions(
  userId: string,
  cands: Candidate[],
  now: Date,
  scope?: { chatId?: string; personId?: string },
): Promise<number> {
  const keys = new Set(cands.map((c) => c.dedupeKey));
  const rows = await db.suggestions
    .where('userId')
    .equals(userId)
    .filter((s) => (s.status === 'pending' || s.status === 'snoozed') && isRuleSuggestion(s))
    .toArray();
  let retired = 0;
  for (const s of rows) {
    if (keys.has(s.dedupeKey)) continue;
    if (scope) {
      if (SCOPE_GLOBAL_KINDS.has(s.kind)) continue;
      const inScope = scope.chatId
        ? s.chatId === scope.chatId
        : !!scope.personId && !!s.chatId && s.personId === scope.personId;
      if (!inScope) continue;
    }
    const chat = s.chatId ? await db.chats.get(s.chatId) : undefined;
    const actionItem =
      s.kind === 'action_item_reminder' && s.payload.actionItemId
        ? await db.actionItems.get(s.payload.actionItemId as string)
        : undefined;
    const reason = staleReason(s, { chat, actionItem, now, stillCandidate: false }) ?? 'superseded';
    await retireSuggestions([s], reason, now);
    retired++;
  }
  return retired;
}

/** Kinds whose rules read the whole network (weekly pacing, cadences); a scoped run cannot judge them. */
const SCOPE_GLOBAL_KINDS = new Set<SuggestionKind>([
  'new_outreach',
  'nurture_checkin',
  'reconnect',
  'action_item_reminder',
]);

/** Re-check everything pending against the current data without building a new brief (Today runs this on open). */
export async function revalidatePending(userId: string, now = new Date()): Promise<number> {
  const inp = await ruleInput(userId, now);
  const retired = await revalidateSuggestions(userId, generateCandidates(inp), now);
  await retireMovedOnConfirmations(userId, now);
  await refreshFactDrafts(userId);
  return retired;
}

/** Bring every pending, untouched fact-led draft up to date with what is now known about the person. */
async function refreshFactDrafts(userId: string): Promise<void> {
  const pending = await db.suggestions
    .where('userId')
    .equals(userId)
    .filter((s) => s.status === 'pending' && !!s.outboundMessageId && FACT_DRAFT_KINDS.has(s.kind))
    .toArray();
  for (const s of pending) await refreshIfFactsNewer(userId, s);
}

/** Draft the message for cards that were kept without one (deferred), when the student opens them. */
export async function ensureDrafts(user: User, ids: string[], now = new Date()): Promise<void> {
  for (const id of ids) {
    const s = await db.suggestions.get(id);
    if (s && s.status === 'pending' && !s.outboundMessageId && DRAFT_KIND[s.kind])
      await draftForSuggestion(user, s, now);
  }
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
    // a status-news card carries the update itself (applied, interviewing, offer); the student's own text wins
    update: inputs.update?.trim() || (s?.payload.update as string | undefined) || undefined,
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
    const llm = await llmDraft(ctx, template).catch(() => undefined);
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

/** Kinds whose draft leans on what the student knows about the person (what was said, their news). */
export const FACT_DRAFT_KINDS = new Set<SuggestionKind>(['thank_you', 'nurture_checkin', 'ask_referral']);

/**
 * Re-draft an untouched thank-you, check-in or referral ask when the person has facts newer than the draft (the
 * notes landed after the calendar event ended, the student typed a fact in). The newest fact seen is stored on the
 * suggestion (`payload.factsAsOf`), so the same facts never cause a second re-draft. Facts the drafting itself
 * stored (a connection line, source `outbound`) do not count.
 */
export async function refreshIfFactsNewer(
  userId: string,
  s: Suggestion,
  opts: { factsJustAdded?: boolean } = {},
): Promise<boolean> {
  if (!s.personId || !s.outboundMessageId || !FACT_DRAFT_KINDS.has(s.kind)) return false;
  const draft = await db.outbound.get(s.outboundMessageId);
  if (!draft || draft.status !== 'draft' || draft.bodyFinal) return false;
  const facts = await db.facts
    .where('personId')
    .equals(s.personId)
    .filter((f) => !f.deletedAt && f.sourceTable !== 'outbound')
    .toArray();
  const newest = facts.reduce((m, f) => (f.createdAt > m ? f.createdAt : m), '');
  // a caller that just wrote facts knows they are new even when the clock has not moved since the draft
  const seen =
    typeof s.payload?.factsAsOf === 'string'
      ? s.payload.factsAsOf
      : opts.factsJustAdded
        ? ''
        : draft.createdAt;
  if (!newest || newest <= seen) return false;
  const changed = await refreshUntouchedDraft(userId, s);
  await db.suggestions.update(s.id, { payload: { ...s.payload, factsAsOf: newest } });
  return changed;
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
  const all = generateCandidates(inp);
  // whatever this chat's rules no longer produce is no longer true
  await revalidateSuggestions(userId, all, now, scope);
  const cands = all.filter((c) =>
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
  const scored = selectForBrief(cands, inp.dismissCounts, 5);
  const created = await upsertSuggestions(userId, scored, now);
  for (const s of created)
    if (!s.outboundMessageId && DRAFT_KIND[s.kind]) await draftForSuggestion(user, s, now);
  await addConfirmationCards(userId, now);
}

/** A proposed stage change is only a question while the chat is still where it was when Orbit proposed it. */
async function retireMovedOnConfirmations(userId: string, now: Date): Promise<void> {
  const proposed = await db.stageEvents
    .where('userId')
    .equals(userId)
    .filter((e) => e.status === 'proposed')
    .toArray();
  for (const e of proposed) {
    const chat = await db.chats.get(e.chatId);
    if (chat && (!e.fromStage || chat.stage === e.fromStage) && chat.stage !== e.toStage) continue;
    const reason = `superseded:${chat?.stage ?? 'gone'}`;
    await db.stageEvents.update(e.id, {
      status: 'rejected',
      reason: `${e.reason}|${reason}`,
      decidedAt: now.toISOString(),
    });
    await retireSuggestions(
      await db.suggestions.where('dedupeKey').equals(`stage:${e.id}`).toArray(),
      reason,
      now,
    );
  }
}

async function addConfirmationCards(userId: string, now: Date): Promise<void> {
  await retireMovedOnConfirmations(userId, now);
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
  // validity pass first: nothing stale survives into (or next to) the new brief
  await revalidateSuggestions(user.id, cands, now);
  const people = inp.people;
  const selected = selectForBrief(cands, inp.dismissCounts, 7, {
    orgOf: (pid) => {
      const p = people.get(pid);
      return p?.currentOrganizationId ?? p?.currentOrganizationRaw;
    },
    quiet: isQuietDay(now, inp.settings, user.timezone),
  });
  const briefId = existing?.id ?? newId('b');
  const sugg = await upsertSuggestions(user.id, selected, now, briefId);
  // everything still true that did not make the cut is kept for the next brief instead of being lost
  const chosen = new Set(selected.map((c) => c.dedupeKey));
  const rest = cands
    .filter((c) => !chosen.has(c.dedupeKey))
    .map((c) => ({ ...c, priorityScore: scoreCandidate(c, inp.dismissCounts) }));
  await upsertSuggestions(user.id, rest, now, briefId, { deferred: true });
  await addConfirmationCards(user.id, now);
  for (const s of sugg)
    if (!s.outboundMessageId && DRAFT_KIND[s.kind]) await draftForSuggestion(user, s, now);
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
    const history = lastContactPhrase(tps, new Date(), user.timezone);
    summary = `${person.firstName} is ${role}${person.isAlumni ? ` and a ${user.school} alum` : ''}. ${history}${adv ? ` Advice: ${adv.text.replace(/\.$/, '')}.` : ''}${off ? ` They offered: ${off.text.replace(/\.$/, '')}.` : ''}`;
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
      warmUp: cold
        ? buildWarmUpPlan(person.linkedinSlug!, now, settings?.warmUpDays ?? 4, user.timezone)
        : undefined,
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
  const current = chat.warmUp.actions.find((a) => a.id === actionId);
  if (!current) return;
  // a second click on Done (or Skip) changes nothing: no duplicate touchpoint, no second feedback row
  if (done ? !!current.doneAt : !!current.skippedAt || !!current.doneAt) return;
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
    await addTouchpoint({
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

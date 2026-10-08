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
  isQuietDay,
  isRuleSuggestion,
  newId,
  proposeWindows,
  resumeOneLiner,
  STAGE_LABELS,
  schoolShort,
  scoreCandidate,
  selectForBrief,
  staleReason,
  suggestionFromCandidate,
  todayKey,
  validateDraft,
  WHY_THEM_GAP,
  warmUpProgress,
  whenLabel,
  whyThemSentence,
} from '@orbit/core';
import { addTouchpoint, feedback, notify, recomputeAllStrengths } from '../db/repo';
import { db } from '../db/schema';
import { describeLlmFailure, hasLlm, llmDraft, llmSummary, toLlmError } from '../integrations/anthropic';
import { bestPathStrength, buildReachGraph, reachPersonIn } from './graph';
import {
  introductionQuestionCandidate,
  retireIntroductionQuestion,
  staleIntroductionQuestion,
} from './introductions';
import { noteMatchCandidate } from './notes';
import { personSummary } from './prep';
import { currentResumeFacets, sharesOrgNow } from './resume';
import { retireSuggestions, runTimedStageRules } from './stages';

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
    // free time is only known from a calendar: without one, a scheduling draft asks for the student's times instead
    // of offering slots they never chose
    freeSlotsIso: (await calendarKnown(userId)) ? freeSlots(events, now) : [],
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

/**
 * Whether Orbit can see the student's calendar (Google, or the demo's sample calendar). Without it, the few meetings it
 * knows of are the ones typed in, so "free" times would be guesses.
 */
export async function calendarKnown(userId: string): Promise<boolean> {
  const all = await db.integrations.where('userId').equals(userId).toArray();
  return all.some((i) => (i.provider === 'google' || i.provider === 'demo') && i.status === 'active');
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
  opts: { deferred?: boolean } = {},
): Promise<Suggestion[]> {
  const out: Suggestion[] = [];
  const deferred = opts.deferred ? true : undefined;
  for (const c of cands) {
    // a first message the student already started (or opened to send) answers the "First message" card: it is not
    // raised, or brought back, beside it
    if (
      c.kind === 'new_outreach' &&
      c.personId &&
      (await db.outbound
        .where('personId')
        .equals(c.personId)
        .filter(
          (o) =>
            o.kind === 'outreach' && !o.suggestionId && ['draft', 'queued', 'handed_off'].includes(o.status),
        )
        .count())
    )
      continue;
    const existing = await db.suggestions.where('dedupeKey').equals(c.dedupeKey).first();
    if (existing) {
      // a user decision (dismissed, sent, done, approved, edited) is final; a system expiry is not: the trigger is
      // true again, so the card comes back
      if (!['pending', 'snoozed', 'expired'].includes(existing.status)) continue;
      if (existing.status === 'snoozed' && existing.snoozedUntil && new Date(existing.snoozedUntil) > now)
        continue;
      const revived = existing.status === 'expired';
      let outboundMessageId = existing.outboundMessageId;
      // a cancelled draft (the card was retired) is replaced; one in the student's hands (queued, handed off to
      // the mail app, failed with its error) stays on the card, or "I sent it" and "Undo" would vanish under them
      if (outboundMessageId) {
        const draft = await db.outbound.get(outboundMessageId);
        if (!draft || draft.status === 'cancelled' || draft.status === 'sent') outboundMessageId = undefined;
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
        await refreshUntouchedDraft(userId, row, now);
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
export async function refreshUntouchedDraft(
  userId: string,
  s: Suggestion,
  now = new Date(),
): Promise<boolean> {
  if (!s.outboundMessageId) return false;
  const draft = await db.outbound.get(s.outboundMessageId);
  if (draft?.status !== 'draft' || draft.bodyFinal) return false;
  const user = await db.users.get(userId);
  if (!user) return false;
  return !!(await regenerateDraft(user, draft.id, {}, now));
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
      // a card the rules make from one chat alone (an intro to answer) is judged by a run over that chat
      if (SCOPE_GLOBAL_KINDS.has(s.kind) && !CHAT_RULE_KEYS.some((p) => s.dedupeKey.startsWith(p))) continue;
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

/** Cards of a network-wide kind that one chat's rules decide alone: "write to Sam while the intro is fresh". */
const CHAT_RULE_KEYS = ['intro:', 'introreply:'];

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

/** True for a card whose job is a message for the student to approve (it has, or will get, a draft). */
export function isMessageSuggestion(kind: SuggestionKind): boolean {
  return !!DRAFT_KIND[kind];
}

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

/** The person who introduced or pointed the student to `person`: an intro request sent to them, or a suggestion from a chat. */
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
  if (intro?.personId) return db.people.get(intro.personId);
  // someone the student met suggested this person (captured on the prep tab)
  const suggested = await db.facts
    .where('personId')
    .equals(person.id)
    .filter((x) => x.type === 'connection' && x.sourceTable === 'suggested_by' && !x.deletedAt)
    .last();
  if (suggested) return db.people.get(suggested.sourceId);
  // someone told the student, in a chat their notes recorded, to get in touch with this person by full name
  // ("told me to reach out to her colleague Marcus Lee"): they are the referrer, not a cold lead
  const name = person.displayName.trim();
  if (name.split(/\s+/).length < 2) return undefined;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pointer = new RegExp(
    `\\b(reach(ed)? out to|get in touch with|talk to|speak (to|with)|meet|email|contact|connect with|introduce me to|ping|follow up with)\\b[^.]*\\b${esc}\\b`,
    'i',
  );
  const told = await db.facts
    .where('userId')
    .equals(userId)
    .filter(
      (f) => !f.deletedAt && f.personId !== person.id && f.sourceTable === 'notes' && pointer.test(f.text),
    )
    .last();
  return told ? db.people.get(told.personId) : undefined;
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

/**
 * The "who I am" clause override. The template composes the clean clause from structured fields ("a junior at
 * Cornell studying computer science"), so a resume summary is used only when those fields are missing, and then
 * only as a short "a/an ..." clause (`resumeOneLiner`: no contact details), cut at its first comma so interests and
 * asides stay out, with the school's short name.
 */
function oneLinerFor(user: User, summary: string | undefined): string | undefined {
  if (user.school && user.graduationYear) return undefined;
  const clause = resumeOneLiner(summary)?.split(/,\s*/)[0]?.trim();
  if (!clause) return undefined;
  return user.school ? clause.replace(user.school, schoolShort(user.school)) : clause;
}

export async function buildDraftContext(
  user: User,
  person: Person,
  kind: MessageKind,
  channel: 'gmail' | 'linkedin',
  s?: Suggestion,
  inputs: DraftInputs = {},
  chatOverride?: CoffeeChat,
  /** the moment the draft is written for (free windows and relative dates); defaults to now */
  now = new Date(),
): Promise<DraftContext> {
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
      // only the current resume's facets the student kept
      currentResumeFacets(user.id),
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
  const summary = resumeFacets.find((f) => f.kind === 'summary')?.text;
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
      // only what passed between the student and this person: on a group thread (an intro that CC'd them),
      // the introducer's note is not something they wrote
      .filter(
        (m) =>
          !m.isAutomated &&
          (m.direction === 'inbound'
            ? m.fromPersonId === person.id
            : [...m.toEmails, ...m.ccEmails].some((e) => person.emails.includes(e))),
      )
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
    (kind === 'schedule' || kind === 'reply') && (await calendarKnown(user.id))
      ? proposeWindows(busy, now, user.timezone, { seed: person.id })
      : undefined;
  const warm = chat?.warmUp ? warmUpProgress(chat.warmUp, now, user.timezone) : undefined;
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
  const orgRoles = resumeFacets
    .filter((f) => f.kind === 'experience' && f.organizationName)
    .map((f) => ({ name: f.organizationName!, title: f.title, current: !f.endDate }));
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
      oneLiner: oneLinerFor(user, summary),
      credibility: credibilityLine(resumeFacets),
      schedulingLink: settings?.schedulingLink,
      timezone: user.timezone,
      pastOrgs,
      orgRoles,
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
    missedProposal: s?.payload.missedProposal as DraftContext['missedProposal'],
    busy,
    thread,
    target,
    chat: chat
      ? {
          completedAt: chat.completedAt,
          meetingAt,
          stage: chat.stage,
          referrerName,
          introducedAt: chat.introducedAt,
          warmUpNote,
          warmUpDone: warm?.done,
          commentedOnPost: commentedOnPost || undefined,
          upcomingAt,
        }
      : referrerName
        ? { referrerName }
        : undefined,
    // a status-news card carries the update itself (applied, interviewing, offer); the student's own text wins
    update: inputs.update?.trim() || (s?.payload.update as string | undefined) || undefined,
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
  now?: Date,
): Promise<{
  out: ReturnType<typeof generateDraft>;
  generatedBy: OutboundMessage['generatedBy'];
  ctx: DraftContext;
}> {
  const ctx = await buildDraftContext(user, person, kind, channel, s, inputs, chat, now);
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
    const llm = await llmDraft(ctx, template).catch((e) => surfaceLlmFailure(user.id, e));
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
  const { out, generatedBy, ctx } = await materializeDraft(
    user,
    person,
    kind,
    channel,
    s,
    {},
    undefined,
    now,
  );
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
  /** the chat to write in; undefined finds the person's chat; null drafts outside any chat (a fresh first message) */
  chatId?: string | null,
  inputs: DraftInputs = {},
): Promise<OutboundMessage> {
  const person = (await db.people.get(personId))!;
  const chat = chatId
    ? await db.chats.get(chatId)
    : chatId === null
      ? undefined
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
  if (draft?.status !== 'draft' || draft.bodyFinal) return false;
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
  now = new Date(),
  /**
   * The text the student has edited. When it still holds the bracketed "Why them" gap, only that gap is filled with
   * their line and the rest of their words stay; the fresh draft becomes what "Reset to suggested" goes back to.
   */
  opts: { mine?: string } = {},
): Promise<OutboundMessage | undefined> {
  const msg = await db.outbound.get(messageId);
  if (!msg || msg.userId !== user.id || msg.status !== 'draft') return undefined;
  const person = await db.people.get(msg.personId);
  if (!person) return undefined;
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
    now,
  );
  const merged =
    opts.mine && inputs.connection?.trim() && WHY_THEM_GAP.test(opts.mine)
      ? opts.mine.replace(WHY_THEM_GAP, whyThemSentence(inputs.connection))
      : undefined;
  const changes: Partial<OutboundMessage> = {
    // the student's own subject stays when their text is kept
    subject: msg.externalThreadId || merged ? msg.subject : (out.subject ?? msg.subject),
    bodyDraft: bodyFor(out, msg.channel as 'gmail' | 'linkedin', msg.kind, !!person.linkedinConnectedOn),
    bodyFinal: merged,
    bodyFinalHash: undefined,
    generatedBy,
    claims: out.claims,
    needsInput: out.needsInput.length ? out.needsInput : undefined,
    opening: out.opening,
  };
  // drafting takes a while: if the student approved it in the meantime, the approved text is theirs to keep
  const applied = await db.transaction('rw', db.outbound, async () => {
    const cur = await db.outbound.get(messageId);
    if (cur?.status !== 'draft' || cur.bodyFinal !== msg.bodyFinal) return false;
    await db.outbound.update(messageId, changes);
    return true;
  });
  if (!applied) return undefined;
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

/**
 * A draft says when things happened in words that depend on the day ("Thank you for making time yesterday"). On a
 * new day, a draft written on an earlier one is rewritten with today's words; a draft the student edited keeps their
 * text and only has the old day word swapped for the new one ("yesterday" becomes "on Monday").
 */
export async function refreshDatedDrafts(user: User, now = new Date()): Promise<number> {
  const tz = user.timezone || 'UTC';
  const today = todayKey(now, tz);
  const drafts = await db.outbound
    .where('userId')
    .equals(user.id)
    .filter((o) => o.status === 'draft' && !!o.suggestionId)
    .toArray();
  let changed = 0;
  for (const d of drafts) {
    const since = new Date(d.draftedAt ?? d.createdAt);
    if (todayKey(since, tz) === today) continue;
    const s = await db.suggestions.get(d.suggestionId!);
    if (s?.status !== 'pending') continue;
    const person = await db.people.get(d.personId);
    if (!person) continue;
    const chat = d.chatId ? await db.chats.get(d.chatId) : undefined;
    if (d.bodyFinal === undefined) {
      const { out, generatedBy } = await materializeDraft(
        user,
        person,
        d.kind,
        d.channel as 'gmail' | 'linkedin',
        s,
        {},
        chat,
        now,
      );
      if (out.needsInput.length > (d.needsInput?.length ?? 0)) continue;
      const body = bodyFor(out, d.channel as 'gmail' | 'linkedin', d.kind, !!person.linkedinConnectedOn);
      await db.outbound.update(d.id, {
        draftedAt: now.toISOString(),
        ...(body === d.bodyDraft
          ? {}
          : {
              bodyDraft: body,
              subject: d.externalThreadId ? d.subject : (out.subject ?? d.subject),
              generatedBy,
              claims: out.claims,
              opening: out.opening,
            }),
      });
      if (body !== d.bodyDraft) changed++;
      continue;
    }
    // edited: swap only the day word of the meeting it thanks them for
    const event = chat?.scheduledEventId ? await db.events.get(chat.scheduledEventId) : undefined;
    const meetingAt = event && new Date(event.startAt) <= now ? event.startAt : chat?.completedAt;
    const before = whenLabel(meetingAt, since, tz);
    const after = whenLabel(meetingAt, now, tz);
    let bodyFinal = d.bodyFinal;
    if (before && after && before !== after && (d.kind === 'thank_you' || d.kind === 'referral_ask')) {
      const re = new RegExp(`\\b${before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      bodyFinal = bodyFinal.replace(re, after);
    }
    await db.outbound.update(d.id, { draftedAt: now.toISOString(), bodyFinal });
    if (bodyFinal !== d.bodyFinal) changed++;
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
  if (!user?.onboardingCompletedAt) return;
  const inp = await ruleInput(userId, now, scope);
  const all = generateCandidates(inp);
  // whatever this chat's rules no longer produce is no longer true
  await revalidateSuggestions(userId, all, now, scope);
  const cands = all.filter(
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
      // the reply to an email introduction is due now, not in the next morning's batch
      !!c.signals.introducedBy,
  );
  const scored = selectForBrief(cands, inp.dismissCounts, 5);
  const created = await upsertSuggestions(userId, scored, now);
  for (const s of created)
    if (!s.outboundMessageId && DRAFT_KIND[s.kind]) await draftForSuggestion(user, s, now);
  await addConfirmationCards(userId, now);
}

/**
 * A proposed stage change is only a question while the chat is still where it was when Orbit proposed it, and "Did
 * Lena introduce you to Sam?" only while no introduction is recorded on the thread and Sam has no card yet.
 */
async function retireMovedOnConfirmations(userId: string, now: Date): Promise<void> {
  for (const t of await openIntroductionQuestions(userId)) {
    const reason = await staleIntroductionQuestion(t);
    if (reason) await retireIntroductionQuestion(t, reason, now);
  }
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
  for (const t of await openIntroductionQuestions(userId)) {
    const c = await introductionQuestionCandidate(t);
    if (c) await upsertSuggestions(userId, [c], now);
  }
  const merges = await db.merges
    .where('userId')
    .equals(userId)
    .filter((m) => m.status === 'pending')
    .toArray();
  for (const m of merges) {
    const [a, b] = await Promise.all([db.people.get(m.personAId), db.people.get(m.personBId)]);
    if (!a || !b) continue;
    // a guess with little behind it (different first names, no shared address) waits behind "can wait"; it does not
    // take one of the few spots on Today
    const lower = (x?: string) => (x ?? '').trim().toLowerCase();
    const emails = new Set([a.primaryEmail, ...a.emails].filter(Boolean).map((e) => lower(e)));
    const sharedEmail = [b.primaryEmail, ...b.emails].some((e) => e && emails.has(lower(e)));
    const weak = !sharedEmail && lower(a.firstName) !== lower(b.firstName);
    // different first names and different employers: the guess argues against itself, so it is not asked at all
    const orgA = lower(a.currentOrganizationRaw);
    const orgB = lower(b.currentOrganizationRaw);
    if (weak && orgA && orgB && orgA !== orgB) {
      const shown = await db.suggestions.where('dedupeKey').equals(`merge:${m.id}`).toArray();
      await retireSuggestions(shown, 'weak_merge_guess', now);
      continue;
    }
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
      undefined,
      { deferred: weak },
    );
  }
  const unmatched = await db.notes
    .where('userId')
    .equals(userId)
    .filter((n) => n.matchStatus === 'unmatched')
    .toArray();
  if (unmatched.length) {
    const user = await db.users.get(userId);
    for (const n of unmatched)
      await upsertSuggestions(
        userId,
        [await noteMatchCandidate({ id: userId, timezone: user?.timezone ?? 'UTC' }, n)],
        now,
      );
  }
}

/** Threads with an open "Did Lena introduce you to Sam?" question. */
function openIntroductionQuestions(userId: string) {
  return db.threads
    .where('userId')
    .equals(userId)
    .filter((t) => t.possibleIntroduction?.status === 'open')
    .toArray();
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
  schedule_propose: (n) => `${n} chat${n > 1 ? 's' : ''} to propose times for`,
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
  confirm_stage: (n) => `${n} stage update${n > 1 ? 's' : ''} to check`,
  confirm_merge: (n) => `${n} possible duplicate${n > 1 ? 's' : ''}`,
  confirm_note_match: (n) => `${n} note${n > 1 ? 's' : ''} to match`,
  confirm_intro: (n) => `${n} intro${n > 1 ? 's' : ''} to confirm`,
};

/** The one-line summary at the top of Today. It always names a real next step, never "all good" on an empty network. */
export function briefSummaryText(counts: Map<string, number>, upcoming: number, peopleCount: number): string {
  const parts = [...counts].map(([k, n]) => BRIEF_LABELS[k as SuggestionKind]?.(n) ?? `${n} to review`);
  const coming = upcoming ? `${upcoming} chat${upcoming > 1 ? 's' : ''} coming up this week` : '';
  if (parts.length) return `${parts.join(', ')}${coming ? `; ${coming}` : ''}.`;
  if (coming) return `Nothing to send today. ${coming[0]!.toUpperCase()}${coming.slice(1)}.`;
  if (peopleCount === 0)
    return 'Welcome. Your first step is to add a few people you want to talk to, then Orbit suggests what to do each day.';
  // Today names the next step below the line (a draft to finish, someone to write to, who to meet)
  return 'Nothing needs you today.';
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
  await refreshDatedDrafts(user, now);
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
  /** they are in the student's own club or at their job now (`sharesOrgNow`): no warm-up for someone you see */
  sharedOrgNow = false,
): boolean {
  return (
    person.strength < 0.2 && channel === 'linkedin' && !!person.linkedinSlug && warmUpEnabled && !sharedOrgNow
  );
}

export async function startWarmUpOrOutreach(
  user: User,
  personId: string,
  channel: 'gmail' | 'linkedin',
  source: CoffeeChat['source'] = 'manual',
  opts: { skipWarmUp?: boolean } = {},
): Promise<{ chat?: CoffeeChat; draft?: OutboundMessage }> {
  const settings = await db.settings.get(user.id);
  const person = (await db.people.get(personId))!;
  const now = new Date();
  let chat = await db.chats
    .where('personId')
    .equals(personId)
    .filter((c) => !['declined', 'no_response', 'archived'].includes(c.stage))
    .first();
  // a person someone pointed the student to is written to now, naming who suggested it: no warm-up
  const cold =
    !opts.skipWarmUp &&
    needsWarmUp(
      person,
      channel,
      settings?.warmUpEnabled ?? true,
      sharesOrgNow(person, await currentResumeFacets(user.id)),
    ) &&
    !(await findReferrerFor(user.id, person));
  // a first message the student already started for this person is the one they continue: a second click (or a page
  // that asks again while the first draft is still being written) never makes a second copy
  const started = await unsentDraftOf(personId, 'outreach');
  // Looking at a first draft is not starting a chat: the chat (and its Pipeline card) is opened when the message is
  // approved and sent (openChatForOutreach). Only a warm-up, which has steps to track, opens one right away.
  if (!chat && !cold) {
    await retireFirstMessageCards(user.id, personId, now, true);
    if (started) return { draft: started };
    // null: an old declined or silent chat is not the context for a fresh first message
    const draft = await draftMessage(user, personId, 'outreach', channel, null);
    return { draft };
  }
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
  await retireFirstMessageCards(user.id, personId, now, !(chat.stage === 'warming' && !opts.skipWarmUp));
  if (chat.stage === 'warming' && !opts.skipWarmUp) {
    await evaluateImmediateSuggestions(user.id, { chatId: chat.id, personId }, now);
    return { chat };
  }
  if (started) return { chat, draft: started };
  const draft = await draftMessage(user, personId, 'outreach', channel, chat.id);
  return { chat, draft };
}

/** The newest message of this kind the student started for a person and has not sent or discarded. */
export async function unsentDraftOf(
  personId: string,
  kind: MessageKind,
): Promise<OutboundMessage | undefined> {
  const all = await db.outbound
    .where('personId')
    .equals(personId)
    .filter((m) => m.kind === kind && m.status === 'draft')
    .toArray();
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** A "First message" card for this person is answered by what was just started (a warm-up or the draft). */
async function retireFirstMessageCards(
  userId: string,
  personId: string,
  now: Date,
  /** a first message is being opened now: the card's draft is the one it continues */
  keepDraft: boolean,
): Promise<void> {
  const cards = await db.suggestions
    .where('userId')
    .equals(userId)
    .filter((x) => x.personId === personId && x.kind === 'new_outreach' && x.status === 'pending')
    .toArray();
  // the card's draft becomes a started draft (edits and all) instead of being cancelled with the card when it is the
  // message being opened, or when the student already wrote in it; an untouched one goes with the card (a warm-up)
  for (const c of cards) {
    if (!c.outboundMessageId) continue;
    const draft = await db.outbound.get(c.outboundMessageId);
    if (draft?.status !== 'draft' || (!keepDraft && !draft.bodyFinal)) continue;
    await db.outbound.update(draft.id, { suggestionId: undefined });
    await db.suggestions.update(c.id, { outboundMessageId: undefined });
    c.outboundMessageId = undefined;
  }
  if (cards.length) await retireSuggestions(cards, 'superseded:started', now);
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
    currentResumeFacets(user.id),
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
  const named = new Map(people.map((p) => [p.id, p]));
  for (const r of recs) {
    r.bestPath = undefined;
    // someone the student met pointed them at this person: that comes first, and no warm-up is needed
    const person = named.get(r.personId);
    const referrer = person ? await findReferrerFor(user.id, person) : undefined;
    if (referrer && !r.reasons.some((x) => x.code === 'referred'))
      r.reasons.unshift({ code: 'referred', text: `${referrer.firstName} suggested you get in touch` });
    // "Reachable through someone you know" names who: the first person on the best route, who could introduce them
    const via = r.reasons.find((x) => x.code === 'path');
    if (via) {
      const route = reachPersonIn(g, r.personId, 1)[0];
      const introducer = route && route.hops.length >= 2 ? named.get(route.hops[0]!.toId) : undefined;
      if (introducer) {
        r.bestPath = route;
        via.text = `${introducer.firstName} knows them and could introduce you`;
      }
    }
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

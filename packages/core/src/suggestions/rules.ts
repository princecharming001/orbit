import { maxBumpsFor, sectorOf } from '../drafts/sector';
import type {
  ActionItem,
  CalendarEvent,
  ChatStage,
  CoffeeChat,
  EmailMessage,
  Person,
  PersonFact,
  ProposedTime,
  Recommendation,
  RelationshipType,
  Suggestion,
  SuggestionKind,
  TargetCompany,
  UserSettings,
} from '../types';
import { todayKey } from '../util/ids';
import { warmUpProgress } from '../warmup/rules';

export interface RuleInput {
  userId: string;
  now: Date;
  settings: UserSettings;
  people: Map<string, Person>;
  chats: CoffeeChat[];
  lastInboundByChat: Map<string, EmailMessage>;
  events: CalendarEvent[];
  actionItems: ActionItem[];
  factsByPerson: Map<string, PersonFact[]>;
  targetCompanies: TargetCompany[];
  recommendations: Recommendation[];
  dismissCounts: Map<string, number>; // `${kind}:${personId}` -> dismissals in 60 days
  outreachSentThisWeek: number;
  freeSlotsIso: string[]; // from calendar free/busy
  recentlyContacted: Set<string>; // personIds contacted in last 30d
  recentBriefDate?: string;
  /** the student's IANA timezone; calendar-day comparisons (due today, overdue) use it */
  timezone?: string;
  /** personId -> ISO time of the last real conversation (meeting, note, email or LinkedIn message, either way) */
  lastConversationByPerson?: Map<string, string>;
}

export interface Candidate {
  kind: SuggestionKind;
  personId?: string;
  chatId?: string;
  dedupeKey: string;
  reasonText: string;
  signals: Record<string, unknown>;
  payload: Record<string, unknown>;
  urgency: number;
  goalRelevance: number;
  confidence: number;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Playbook: a nurture note every 4 to 6 weeks while the cycle is live; closer ties a little sooner. */
const CADENCE: Record<RelationshipType, number> = {
  mentor: 28,
  alumni: 35,
  recruiter: 42,
  peer: 42,
  colleague: 42,
  professor: 42,
  family_friend: 42,
  unknown: 42,
  other: 42,
};
/** A hook older than this is stale news; the check-in would reference something that already happened. */
const HOOK_MAX_AGE_DAYS = 90;
/** A thank-you is only natural within this window after the conversation. */
export const THANK_YOU_WINDOW_DAYS = 3;
/** A proposed time has to be at least this far away to be worth confirming. */
const CONFIRM_LEAD_HOURS = 2;

export function businessDaysBetween(a: Date, b: Date): number {
  let n = 0;
  const d = new Date(a);
  while (d < b) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) n++;
  }
  return n;
}
/** Local date of the Monday that starts the outreach week containing `d` (weeks run Monday to Sunday). */
export function weekMondayKey(d: Date): string {
  const m = new Date(d);
  m.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  m.setHours(0, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${m.getFullYear()}-${pad(m.getMonth() + 1)}-${pad(m.getDate())}`;
}
const monthKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}`;
const quarterKey = (d: Date) => `${d.getFullYear()}-q${Math.floor(d.getMonth() / 3)}`;
const dayKey = (iso: string, tz?: string) => todayKey(new Date(iso), tz);

/** A proposed time is usable when it is still ahead (with some lead) and the student is free then. */
export function usableProposedTime(
  t: ProposedTime,
  events: Pick<CalendarEvent, 'startAt' | 'endAt' | 'status'>[],
  now: Date,
): 'ok' | 'passed' | 'busy' {
  const start = new Date(t.startIso).getTime();
  if (Number.isNaN(start) || start < now.getTime() + CONFIRM_LEAD_HOURS * HOUR) return 'passed';
  const end = t.endIso ? new Date(t.endIso).getTime() : start + 30 * 60_000;
  const busy = events.some(
    (e) =>
      e.status !== 'cancelled' && new Date(e.startAt).getTime() < end && new Date(e.endAt).getTime() > start,
  );
  return busy ? 'busy' : 'ok';
}

export function generateCandidates(inp: RuleInput): Candidate[] {
  const out: Candidate[] = [];
  const { now } = inp;
  const goalRel = (personId?: string) => {
    if (!personId) return 0.2;
    const p = inp.people.get(personId);
    const orgRaw = (p?.currentOrganizationRaw ?? '').toLowerCase();
    const tc = inp.targetCompanies.find(
      (t) =>
        (p?.currentOrganizationId && t.organizationId === p.currentOrganizationId) ||
        (orgRaw && t.nameRaw.toLowerCase() === orgRaw),
    );
    if (tc) return tc.priority === 1 ? 1 : 0.8;
    if (p?.isAlumni) return 0.3;
    return 0.2;
  };
  for (const chat of inp.chats) {
    const person = inp.people.get(chat.personId);
    if (!person || !person.isHuman || person.hiddenAt) continue;
    const rel = goalRel(chat.personId);
    // a live conversation is worth more than its company alone: never let a cold lead outrank it
    const liveRel = Math.max(rel, 0.6);
    // warm-up
    if (chat.stage === 'warming' && chat.warmUp) {
      const prog = warmUpProgress(chat.warmUp, now);
      if (prog.ready) {
        out.push({
          kind: 'new_outreach',
          personId: chat.personId,
          chatId: chat.id,
          dedupeKey: `new:${chat.personId}:${chat.id}`,
          reasonText: `Warm-up done (${prog.done} of ${prog.total}); ready to message ${person.firstName}`,
          signals: { warmUpDone: prog.done },
          payload: { channel: 'linkedin' },
          urgency: 0.6,
          goalRelevance: rel,
          confidence: 1,
        });
      } else if (prog.nextAction) {
        out.push({
          kind: 'warm_up_engage',
          personId: chat.personId,
          chatId: chat.id,
          dedupeKey: `warm:${chat.id}:${prog.nextAction.id}`,
          reasonText: `${prog.nextAction.label}; warming up before you message ${person.firstName}`,
          signals: { actionId: prog.nextAction.id, overdue: prog.overdue },
          payload: { actionId: prog.nextAction.id, url: prog.nextAction.url, label: prog.nextAction.label },
          urgency: prog.overdue ? 0.65 : 0.55,
          goalRelevance: rel,
          confidence: 1,
        });
      }
      continue;
    }
    if (chat.stage === 'outreach_sent' && chat.lastOutboundAt) {
      const since = new Date(chat.lastOutboundAt);
      const bdays = businessDaysBetween(since, now);
      const threshold = chat.outreachChannel === 'linkedin' ? 10 : 5;
      const maxBumps = maxBumpsFor(
        sectorOf({ title: person.currentTitle, org: person.currentOrganizationRaw }),
        inp.settings.maxBumps,
      );
      if (
        bdays >= threshold &&
        chat.bumpCount < maxBumps &&
        (!chat.lastInboundAt || new Date(chat.lastInboundAt) < since)
      ) {
        out.push({
          kind: 'follow_up_bump',
          personId: chat.personId,
          chatId: chat.id,
          dedupeKey: `bump:${chat.id}:${chat.bumpCount + 1}`,
          reasonText:
            chat.bumpCount === 0
              ? `No reply in ${bdays} business days; one short bump in case it got buried`
              : `Still quiet after ${bdays} business days; a graceful last word, then let it rest`,
          signals: { businessDays: bdays, bumpCount: chat.bumpCount },
          payload: {},
          urgency: Math.min(0.9, 0.7 + 0.1 * (bdays - threshold)),
          goalRelevance: liveRel,
          confidence: 1,
        });
      }
    }
    const lastIn = inp.lastInboundByChat.get(chat.id);
    const awaitingReply =
      !!lastIn &&
      (!chat.lastOutboundAt || new Date(chat.lastOutboundAt) < new Date(lastIn.sentAt)) &&
      // a chat already on the calendar needs no times proposed or confirmed
      !inp.events.some(
        (e) =>
          e.chatId === chat.id && e.status !== 'cancelled' && new Date(e.endAt).getTime() > now.getTime(),
      );
    if (
      chat.stage === 'replied' &&
      lastIn &&
      awaitingReply &&
      ['reply_positive', 'question', 'reply_neutral', 'intro_offer', 'referral_offer'].includes(
        lastIn.signal ?? '',
      )
    ) {
      out.push({
        kind: 'schedule_propose',
        personId: chat.personId,
        chatId: chat.id,
        dedupeKey: `sched:${chat.id}:${lastIn.id}`,
        reasonText: `${person.firstName} replied; propose times`,
        signals: { signal: lastIn.signal },
        payload: { inReplyTo: lastIn.id, windows: inp.freeSlotsIso.slice(0, 2) },
        urgency: 0.9,
        goalRelevance: liveRel,
        confidence: lastIn.signalConfidence ?? 0.7,
      });
    }
    const proposedTimes =
      lastIn?.signal === 'scheduling_proposal' ? (lastIn.extraction?.proposedTimes ?? []) : [];
    if (
      (chat.stage === 'scheduling' || chat.stage === 'replied') &&
      lastIn &&
      awaitingReply &&
      proposedTimes.length
    ) {
      const checked = proposedTimes.map((t) => ({ t, verdict: usableProposedTime(t, inp.events, now) }));
      const usable = checked.find((c) => c.verdict === 'ok')?.t;
      if (usable) {
        out.push({
          kind: 'schedule_confirm',
          personId: chat.personId,
          chatId: chat.id,
          dedupeKey: `confirm:${chat.id}:${lastIn.id}`,
          reasonText: `${person.firstName} suggested ${usable.raw}; confirm it`,
          signals: { proposed: usable },
          payload: { inReplyTo: lastIn.id, time: usable },
          urgency: 1,
          goalRelevance: liveRel,
          confidence: lastIn.signalConfidence ?? 0.7,
        });
      } else {
        // every suggested time has passed or clashes with the calendar: answer with new times instead
        const first = checked[0]!;
        const why = first.verdict === 'busy' ? 'you are busy then' : 'that time has passed';
        out.push({
          kind: 'schedule_propose',
          personId: chat.personId,
          chatId: chat.id,
          dedupeKey: `sched:${chat.id}:${lastIn.id}`,
          reasonText: `${person.firstName} suggested ${first.t.raw}, but ${why}; propose new times`,
          signals: { signal: lastIn.signal, missedProposal: first.t.raw, missedReason: first.verdict },
          payload: {
            inReplyTo: lastIn.id,
            windows: inp.freeSlotsIso.slice(0, 2),
            missedProposal: { raw: first.t.raw, startIso: first.t.startIso, reason: first.verdict },
          },
          urgency: 0.95,
          goalRelevance: liveRel,
          confidence: lastIn.signalConfidence ?? 0.7,
        });
      }
    } else if (
      chat.stage === 'scheduling' &&
      lastIn &&
      awaitingReply &&
      lastIn.signal !== 'scheduling_confirmation'
    ) {
      out.push({
        kind: 'schedule_propose',
        personId: chat.personId,
        chatId: chat.id,
        dedupeKey: `sched:${chat.id}:${lastIn.id}`,
        reasonText: `${person.firstName} is waiting on times from you`,
        signals: { signal: lastIn.signal },
        payload: { inReplyTo: lastIn.id, windows: inp.freeSlotsIso.slice(0, 2) },
        urgency: 0.9,
        goalRelevance: liveRel,
        confidence: 0.8,
      });
    }
    if (chat.stage === 'completed' && chat.completedAt && thankYouDue(chat, now)) {
      out.push({
        kind: 'thank_you',
        personId: chat.personId,
        chatId: chat.id,
        dedupeKey: `thank:${chat.id}`,
        reasonText: `You spoke ${relTime(chat.completedAt, now, inp.timezone)}. Send a thank-you while it is fresh.`,
        signals: { completedAt: chat.completedAt },
        payload: {},
        urgency: 0.95,
        goalRelevance: liveRel,
        confidence: 1,
      });
    }
    if (
      chat.stage === 'nurturing' ||
      (chat.stage === 'followed_up' &&
        chat.followedUpAt &&
        now.getTime() - new Date(chat.followedUpAt).getTime() > 14 * DAY)
    ) {
      const lastIso = inp.lastConversationByPerson?.get(person.id) ?? person.lastInteractionAt;
      const last = lastIso ? new Date(lastIso) : undefined;
      const days = last ? (now.getTime() - last.getTime()) / DAY : 999;
      const cadence = CADENCE[person.relationshipType];
      const facts = inp.factsByPerson.get(person.id) ?? [];
      const hook = facts
        .filter((f) => (f.type === 'hook' || f.type === 'offer') && !f.deletedAt)
        .filter(
          (f) => now.getTime() - new Date(f.occurredAt ?? f.createdAt).getTime() <= HOOK_MAX_AGE_DAYS * DAY,
        )
        .sort((a, b) => (b.occurredAt ?? b.createdAt).localeCompare(a.occurredAt ?? a.createdAt))[0];
      if (days >= cadence && !inp.recentlyContacted.has(person.id) && hook) {
        out.push({
          kind: 'nurture_checkin',
          personId: chat.personId,
          chatId: chat.id,
          dedupeKey: `nurture:${person.id}:${monthKey(now)}`,
          reasonText: `${Math.round(days)} days since your last conversation; you have a hook: "${hook.text.slice(0, 60)}"`,
          signals: { days, cadence, hookId: hook.id },
          payload: { hookId: hook.id },
          urgency: 0.4,
          goalRelevance: rel,
          confidence: 1,
        });
      }
    }
    if (['followed_up', 'nurturing'].includes(chat.stage)) {
      const facts = inp.factsByPerson.get(person.id) ?? [];
      const offer = facts.find(
        (f) => f.type === 'offer' && /refer|word|forward/i.test(f.text) && !f.deletedAt,
      );
      const orgRaw = (person.currentOrganizationRaw ?? '').toLowerCase();
      const tc = inp.targetCompanies.find(
        (t) =>
          ((person.currentOrganizationId && t.organizationId === person.currentOrganizationId) ||
            t.nameRaw.toLowerCase() === orgRaw) &&
          (t.status === 'applied' ||
            (t.deadline && new Date(t.deadline).getTime() - now.getTime() < 21 * DAY)),
      );
      if (tc && (offer || person.strength >= 0.5) && !inp.recentlyContacted.has(person.id)) {
        const soon = tc.deadline && new Date(tc.deadline).getTime() - now.getTime() < 7 * DAY;
        out.push({
          kind: 'ask_referral',
          personId: person.id,
          chatId: chat.id,
          dedupeKey: `ref:${person.id}:${tc.id}`,
          reasonText: offer
            ? `${person.firstName} offered to refer you and ${tc.nameRaw} is ${tc.status === 'applied' ? 'in progress' : 'closing soon'}`
            : `${tc.nameRaw} deadline is near and you're close with ${person.firstName}`,
          signals: { offerId: offer?.id, deadline: tc.deadline },
          payload: { targetCompanyId: tc.id, offerId: offer?.id },
          urgency: 0.65 + (soon ? 0.2 : 0),
          goalRelevance: 1,
          confidence: 1,
        });
      }
    }
  }
  // report back to whoever made the intro, once the chat with the target resolved
  for (const chat of inp.chats) {
    if (!chat.referrerPersonId) continue;
    const referrer = inp.people.get(chat.referrerPersonId);
    const target = inp.people.get(chat.personId);
    if (!referrer || !target || referrer.hiddenAt) continue;
    const outcome =
      chat.stage === 'completed' || chat.stage === 'followed_up' || chat.stage === 'nurturing'
        ? 'spoke'
        : chat.stage === 'declined'
          ? 'declined'
          : chat.stage === 'no_response'
            ? 'no_reply'
            : undefined;
    if (!outcome) continue;
    const at = outcome === 'spoke' ? chat.completedAt : chat.stageEnteredAt;
    if (!at || now.getTime() - new Date(at).getTime() > 21 * DAY) continue;
    out.push({
      kind: 'report_back',
      personId: referrer.id,
      chatId: chat.id,
      dedupeKey: `report:${chat.id}`,
      reasonText:
        outcome === 'spoke'
          ? `You spoke with ${target.firstName}; close the loop with ${referrer.firstName}, who made the intro`
          : `${target.firstName} ${outcome === 'declined' ? 'passed' : 'never replied'}; let ${referrer.firstName} know so the intro doesn't dangle`,
      signals: { outcome, at },
      payload: {
        reportBack: {
          targetName: target.displayName,
          outcome,
          when: relTime(at, now, inp.timezone),
        },
        channel: referrer.primaryEmail ? 'gmail' : 'linkedin',
      },
      urgency: outcome === 'spoke' ? 0.7 : 0.45,
      goalRelevance: goalRel(referrer.id),
      confidence: 1,
    });
  }
  // prep briefs: from 30 hours before the chat until it starts
  for (const e of inp.events) {
    if (e.status === 'cancelled' || !e.attendeePersonIds.length) continue;
    const start = new Date(e.startAt).getTime();
    const hours = (start - now.getTime()) / HOUR;
    if (hours > 0 && hours <= 30 && (e.isCoffeeChat ?? false)) {
      const pid = e.attendeePersonIds[0]!;
      const p = inp.people.get(pid);
      if (!p) continue;
      const rel = relTime(e.startAt, now, inp.timezone);
      out.push({
        kind: 'prep_brief',
        personId: pid,
        chatId: e.chatId,
        dedupeKey: `prep:${e.id}`,
        reasonText: `Chat with ${p.firstName} ${rel === 'tomorrow' ? 'is tomorrow' : `starts ${rel}`}. Prep takes two minutes.`,
        signals: { startAt: e.startAt },
        payload: { eventId: e.id },
        urgency: 0.95,
        goalRelevance: goalRel(pid),
        confidence: e.coffeeChatConfidence ?? 0.8,
      });
    }
  }
  // action items: due today or overdue, by calendar day in the student's timezone
  const today = todayKey(now, inp.timezone);
  for (const a of inp.actionItems) {
    if (a.status !== 'open' || !a.dueAt) continue;
    const dueDay = dayKey(a.dueAt, inp.timezone);
    if (dueDay <= today) {
      const overdue = dueDay < today;
      const p = a.personId ? inp.people.get(a.personId) : undefined;
      out.push({
        kind: 'action_item_reminder',
        personId: a.personId,
        chatId: a.chatId,
        dedupeKey: `ai:${a.id}`,
        reasonText: `${overdue ? 'Overdue' : 'Due today'}: ${a.text.slice(0, 80)}${p ? ` (for ${p.firstName})` : ''}`,
        signals: { dueAt: a.dueAt, overdue },
        payload: { actionItemId: a.id },
        urgency: 0.7 + (overdue ? 0.15 : 0),
        goalRelevance: goalRel(a.personId),
        confidence: 1,
      });
    }
  }
  // reconnect (strong ties cooling)
  for (const p of inp.people.values()) {
    if (!p.isHuman || p.hiddenAt) continue;
    const last = p.lastInteractionAt ? new Date(p.lastInteractionAt) : undefined;
    const days = last ? (now.getTime() - last.getTime()) / DAY : 0;
    const wasStrong = (p.strengthBreakdown?.raw ?? 0) >= 1.5;
    if (
      wasStrong &&
      p.strength < 0.35 &&
      days > 60 &&
      (goalRel(p.id) >= 0.8 || p.isAlumni) &&
      !inp.recentlyContacted.has(p.id) &&
      !inp.chats.some(
        (c) =>
          c.personId === p.id && ['outreach_sent', 'replied', 'scheduling', 'scheduled'].includes(c.stage),
      )
    ) {
      out.push({
        kind: 'reconnect',
        personId: p.id,
        dedupeKey: `reconnect:${p.id}:${quarterKey(now)}`,
        reasonText: `You used to talk often with ${p.firstName}; it's been ${Math.round(days)} days`,
        signals: { days, rawStrength: p.strengthBreakdown?.raw },
        payload: {},
        urgency: 0.35,
        goalRelevance: goalRel(p.id),
        confidence: 1,
      });
    }
  }
  // new outreach from recommendations (weekly pacing; the week runs Monday to Sunday)
  const remaining = Math.max(0, inp.settings.weeklyOutreachTarget - inp.outreachSentThisWeek);
  const weekdayIndex = (now.getDay() + 6) % 7; // Monday = 0 ... Sunday = 6
  const behind = weekdayIndex >= 2 && remaining > inp.settings.weeklyOutreachTarget / 2;
  let added = 0;
  for (const r of inp.recommendations
    .filter((r) => r.status === 'new' || r.status === 'saved')
    .sort((a, b) => (b.status === 'saved' ? 1 : 0) - (a.status === 'saved' ? 1 : 0) || b.score - a.score)) {
    if (added >= Math.min(2, remaining)) break;
    if (inp.chats.some((c) => c.personId === r.personId && c.stage !== 'archived')) continue;
    const p = inp.people.get(r.personId);
    if (!p) continue;
    out.push({
      kind: 'new_outreach',
      personId: r.personId,
      dedupeKey: `new:${r.personId}:${weekMondayKey(now)}`,
      reasonText:
        r.reasons
          .map((x) => x.text)
          .slice(0, 2)
          .join('; ') || 'Good fit for your goals',
      signals: { score: r.score, recommendationId: r.id },
      payload: { recommendationId: r.id, channel: p.primaryEmail ? 'gmail' : 'linkedin' },
      urgency: behind ? 0.5 : remaining > 0 ? 0.3 : 0.2,
      goalRelevance: Math.max(goalRel(r.personId), r.fitScore),
      confidence: 1,
    });
    added++;
  }
  return out;
}

/** A thank-you is due while the conversation is fresh and nothing has gone out since it ended. */
export function thankYouDue(chat: Pick<CoffeeChat, 'completedAt' | 'lastOutboundAt'>, now: Date): boolean {
  if (!chat.completedAt) return false;
  const completed = new Date(chat.completedAt).getTime();
  if (now.getTime() - completed >= THANK_YOU_WINDOW_DAYS * DAY) return false;
  if (chat.lastOutboundAt && new Date(chat.lastOutboundAt).getTime() > completed) return false;
  return true;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

const dayNumber = (d: Date, tz?: string) => Math.round(Date.parse(`${todayKey(d, tz)}T00:00:00Z`) / DAY);

/**
 * Plain English for how far `iso` is from `now`, in both directions. Close times read in minutes or hours; further
 * out, calendar days in the student's timezone decide between "tomorrow", "yesterday" and "in N days".
 */
export function relTime(iso: string, now: Date, tz?: string): string {
  const at = new Date(iso);
  const diff = at.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const minutes = Math.round(abs / 60_000);
  const hours = Math.round(abs / HOUR);
  const future = diff >= 0;
  if (minutes < 1) return future ? 'right now' : 'just now';
  if (minutes < 50) return future ? `in ${plural(minutes, 'minute')}` : `${plural(minutes, 'minute')} ago`;
  if (minutes < 90) return future ? 'in about an hour' : 'about an hour ago';
  const days = Math.abs(dayNumber(at, tz) - dayNumber(now, tz));
  if (hours < 6 || days === 0) return future ? `in ${plural(hours, 'hour')}` : `${plural(hours, 'hour')} ago`;
  if (days === 1) return future ? 'tomorrow' : 'yesterday';
  return future ? `in ${days} days` : `${days} days ago`;
}

export function scoreCandidate(c: Candidate, dismissCounts: Map<string, number>): number {
  const value = 0.5 + 0.5 * c.goalRelevance;
  const dismissals = dismissCounts.get(`${c.kind}:${c.personId ?? ''}`) ?? 0;
  const fatigue = Math.max(0.4, 1 - 0.15 * dismissals);
  return c.urgency * value * c.confidence * fatigue;
}

/** Always shown when true: a time to confirm, a thank-you, a chat to prep, a stage to confirm. */
export const HARD_URGENT: SuggestionKind[] = ['schedule_confirm', 'thank_you', 'prep_brief', 'confirm_stage'];
/** Commitments inside live threads: taken before any cold outreach, however the scores land. */
export const OBLIGATION_KINDS: SuggestionKind[] = [
  'follow_up_bump',
  'schedule_propose',
  'action_item_reminder',
  'ask_referral',
  'report_back',
];
/** Kinds that carry a message to the person; the one-per-person and per-company rules apply to these only. */
export const MESSAGE_KINDS: SuggestionKind[] = [
  'new_outreach',
  'follow_up_bump',
  'schedule_propose',
  'schedule_confirm',
  'thank_you',
  'nurture_checkin',
  'reconnect',
  'congratulate',
  'ask_referral',
  'intro_request',
  'report_back',
];
/** At most this many non-urgent messages to the same company in one brief. */
export const PER_COMPANY_CAP = 2;

export function selectForBrief(
  cands: Candidate[],
  dismissCounts: Map<string, number>,
  max = 7,
  opts: { orgOf?: (personId: string) => string | undefined } = {},
): (Candidate & { priorityScore: number })[] {
  const scored = cands
    .map((c) => ({ ...c, priorityScore: scoreCandidate(c, dismissCounts) }))
    .sort((a, b) => b.priorityScore - a.priorityScore);
  const chosen: (Candidate & { priorityScore: number })[] = [];
  const perPerson = new Set<string>();
  const perKind = new Map<SuggestionKind, number>();
  const perOrg = new Map<string, number>();
  const limits: Partial<Record<SuggestionKind, number>> = {
    new_outreach: 2,
    reconnect: 1,
    nurture_checkin: 1,
    warm_up_engage: 2,
  };
  const isHard = (c: Candidate) =>
    HARD_URGENT.includes(c.kind) || (c.kind === 'new_outreach' && !!c.signals.warmUpDone);
  const isMessage = (c: Candidate) => MESSAGE_KINDS.includes(c.kind);
  const take = (c: Candidate & { priorityScore: number }) => {
    if (chosen.length >= max) return;
    const message = isMessage(c);
    const hard = isHard(c);
    if (message && !hard && c.personId && perPerson.has(c.personId)) return;
    const n = perKind.get(c.kind) ?? 0;
    if (limits[c.kind] !== undefined && n >= limits[c.kind]!) return;
    const org = message && !hard && c.personId ? opts.orgOf?.(c.personId)?.toLowerCase() : undefined;
    if (org && (perOrg.get(org) ?? 0) >= PER_COMPANY_CAP) return;
    chosen.push(c);
    if (message && c.personId) perPerson.add(c.personId);
    perKind.set(c.kind, n + 1);
    if (org) perOrg.set(org, (perOrg.get(org) ?? 0) + 1);
  };
  for (const c of scored) if (isHard(c) && chosen.length < 5) take(c);
  for (const c of scored) if (!chosen.includes(c) && OBLIGATION_KINDS.includes(c.kind)) take(c);
  for (const c of scored) if (!chosen.includes(c)) take(c);
  return chosen;
}

export function suggestionFromCandidate(
  c: Candidate & { priorityScore: number },
  userId: string,
  now: Date,
  id: string,
): Suggestion {
  const expires = new Date(now);
  expires.setDate(expires.getDate() + 2);
  return {
    id,
    userId,
    kind: c.kind,
    personId: c.personId,
    chatId: c.chatId,
    priorityScore: c.priorityScore,
    reasonText: c.reasonText,
    signals: c.signals,
    payload: c.payload,
    status: 'pending',
    dedupeKey: c.dedupeKey,
    carriedOver: 0,
    expiresAt: expires.toISOString(),
    createdAt: now.toISOString(),
  };
}

/** Kinds that generateCandidates produces; a pending row of one of these is only true while its rule still fires. */
export const RULE_KINDS: SuggestionKind[] = [
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
  'ask_referral',
];

/** Stages in which a suggestion of this kind can still be true for its chat. Kinds not listed do not depend on the stage. */
export const KIND_STAGES: Partial<Record<SuggestionKind, ChatStage[]>> = {
  thank_you: ['completed'],
  schedule_propose: ['replied', 'scheduling'],
  schedule_confirm: ['replied', 'scheduling'],
  follow_up_bump: ['outreach_sent'],
  warm_up_engage: ['warming'],
  new_outreach: ['identified', 'warming'],
  nurture_checkin: ['nurturing', 'followed_up'],
  ask_referral: ['followed_up', 'nurturing'],
  prep_brief: ['identified', 'warming', 'outreach_sent', 'replied', 'scheduling', 'scheduled'],
  report_back: ['completed', 'followed_up', 'nurturing', 'declined', 'no_response'],
};

export function kindAllowedInStage(kind: SuggestionKind, stage: ChatStage): boolean {
  const stages = KIND_STAGES[kind];
  return !stages || stages.includes(stage);
}

/**
 * Why a pending suggestion is no longer true, or undefined while it still is. `stillCandidate` says whether the
 * rules produced the same dedupeKey just now; the rest only names the reason for the record.
 */
export function staleReason(
  s: Pick<Suggestion, 'kind' | 'payload' | 'createdAt' | 'chatId' | 'dedupeKey'>,
  ctx: { chat?: CoffeeChat; actionItem?: ActionItem; now: Date; stillCandidate: boolean },
): string | undefined {
  if (ctx.stillCandidate) return undefined;
  const chat = ctx.chat;
  if (s.chatId && chat && !kindAllowedInStage(s.kind, chat.stage)) return `stage:${chat.stage}`;
  switch (s.kind) {
    case 'schedule_confirm': {
      const t = (s.payload.time as { startIso?: string } | undefined)?.startIso;
      if (t && new Date(t).getTime() <= ctx.now.getTime()) return 'time_passed';
      if (chat?.lastInboundAt && new Date(chat.lastInboundAt) > new Date(s.createdAt)) return 'newer_inbound';
      return 'superseded';
    }
    case 'schedule_propose':
      if (chat?.lastInboundAt && new Date(chat.lastInboundAt) > new Date(s.createdAt)) return 'newer_inbound';
      if (chat?.lastOutboundAt && new Date(chat.lastOutboundAt) > new Date(s.createdAt))
        return 'already_sent';
      return 'superseded';
    case 'follow_up_bump':
      if (
        chat?.lastInboundAt &&
        chat.lastOutboundAt &&
        new Date(chat.lastInboundAt) > new Date(chat.lastOutboundAt)
      )
        return 'replied';
      if (chat && s.dedupeKey !== `bump:${chat.id}:${chat.bumpCount + 1}`) return 'bumped';
      if (chat?.lastOutboundAt && new Date(chat.lastOutboundAt) > new Date(s.createdAt))
        return 'already_sent';
      return 'superseded';
    case 'thank_you':
      if (
        chat?.lastOutboundAt &&
        chat.completedAt &&
        new Date(chat.lastOutboundAt) > new Date(chat.completedAt)
      )
        return 'thanked';
      return 'window_passed';
    case 'prep_brief':
      return 'event_passed';
    case 'action_item_reminder':
      return ctx.actionItem && ctx.actionItem.status !== 'open' ? 'action_item_closed' : 'not_due';
    default:
      return 'superseded';
  }
}

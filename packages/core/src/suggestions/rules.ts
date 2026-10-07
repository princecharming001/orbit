import { maxBumpsFor, sectorOf } from '../drafts/sector';
import type {
  ActionItem,
  CalendarEvent,
  CoffeeChat,
  EmailMessage,
  Person,
  PersonFact,
  Recommendation,
  RelationshipType,
  Suggestion,
  SuggestionKind,
  TargetCompany,
  UserSettings,
} from '../types';
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

function businessDaysBetween(a: Date, b: Date): number {
  let n = 0;
  const d = new Date(a);
  while (d < b) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) n++;
  }
  return n;
}
const isoWeek = (d: Date) =>
  `${d.getFullYear()}-w${Math.ceil((d.getDate() + 6 - d.getDay()) / 7)}-${d.getMonth()}`;
const monthKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}`;
const quarterKey = (d: Date) => `${d.getFullYear()}-q${Math.floor(d.getMonth() / 3)}`;

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
          reasonText: `${prog.nextAction.label}, to warm up before you message ${person.firstName}`,
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
          goalRelevance: rel,
          confidence: 1,
        });
      }
    }
    const lastIn = inp.lastInboundByChat.get(chat.id);
    if (
      chat.stage === 'replied' &&
      lastIn &&
      ['reply_positive', 'question', 'reply_neutral', 'intro_offer', 'referral_offer'].includes(
        lastIn.signal ?? '',
      ) &&
      (!chat.lastOutboundAt || new Date(chat.lastOutboundAt) < new Date(lastIn.sentAt))
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
        goalRelevance: rel,
        confidence: lastIn.signalConfidence ?? 0.7,
      });
    }
    if (
      (chat.stage === 'scheduling' || chat.stage === 'replied') &&
      lastIn?.signal === 'scheduling_proposal' &&
      (lastIn.extraction?.proposedTimes.length ?? 0) > 0 &&
      (!chat.lastOutboundAt || new Date(chat.lastOutboundAt) < new Date(lastIn.sentAt))
    ) {
      const t = lastIn.extraction!.proposedTimes[0]!;
      out.push({
        kind: 'schedule_confirm',
        personId: chat.personId,
        chatId: chat.id,
        dedupeKey: `confirm:${chat.id}:${lastIn.id}`,
        reasonText: `${person.firstName} suggested ${t.raw}; confirm it`,
        signals: { proposed: t },
        payload: { inReplyTo: lastIn.id, time: t },
        urgency: 1,
        goalRelevance: rel,
        confidence: lastIn.signalConfidence ?? 0.7,
      });
    } else if (
      chat.stage === 'scheduling' &&
      lastIn &&
      (!chat.lastOutboundAt || new Date(chat.lastOutboundAt) < new Date(lastIn.sentAt)) &&
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
        goalRelevance: rel,
        confidence: 0.8,
      });
    }
    if (
      chat.stage === 'completed' &&
      chat.completedAt &&
      now.getTime() - new Date(chat.completedAt).getTime() < 3 * DAY
    ) {
      out.push({
        kind: 'thank_you',
        personId: chat.personId,
        chatId: chat.id,
        dedupeKey: `thank:${chat.id}`,
        reasonText: `You spoke ${relTime(chat.completedAt, now)}; send a thank-you`,
        signals: { completedAt: chat.completedAt },
        payload: {},
        urgency: 0.95,
        goalRelevance: rel,
        confidence: 1,
      });
    }
    if (
      chat.stage === 'nurturing' ||
      (chat.stage === 'followed_up' &&
        chat.followedUpAt &&
        now.getTime() - new Date(chat.followedUpAt).getTime() > 14 * DAY)
    ) {
      const last = person.lastInteractionAt ? new Date(person.lastInteractionAt) : undefined;
      const days = last ? (now.getTime() - last.getTime()) / DAY : 999;
      const cadence = CADENCE[person.relationshipType];
      const facts = inp.factsByPerson.get(person.id) ?? [];
      const hook = facts.find((f) => (f.type === 'hook' || f.type === 'offer') && !f.deletedAt);
      if (days >= cadence && !inp.recentlyContacted.has(person.id) && hook) {
        out.push({
          kind: 'nurture_checkin',
          personId: chat.personId,
          chatId: chat.id,
          dedupeKey: `nurture:${person.id}:${monthKey(now)}`,
          reasonText: `${Math.round(days)} days since you last spoke; you have a hook: "${hook.text.slice(0, 60)}"`,
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
          when: relTime(at, now),
        },
        channel: referrer.primaryEmail ? 'gmail' : 'linkedin',
      },
      urgency: outcome === 'spoke' ? 0.7 : 0.45,
      goalRelevance: goalRel(referrer.id),
      confidence: 1,
    });
  }
  // prep briefs
  for (const e of inp.events) {
    if (e.status === 'cancelled' || !e.attendeePersonIds.length) continue;
    const start = new Date(e.startAt).getTime();
    const hours = (start - now.getTime()) / 3_600_000;
    // within 30 hours, or on the next business day: a Friday or weekend brief preps Monday's chat
    const soon = hours <= 30 || start < endOfNextBusinessDay(now);
    if (hours > -1 && soon && (e.isCoffeeChat ?? false)) {
      const pid = e.attendeePersonIds[0]!;
      const p = inp.people.get(pid);
      if (!p) continue;
      out.push({
        kind: 'prep_brief',
        personId: pid,
        chatId: e.chatId,
        dedupeKey: `prep:${e.id}`,
        reasonText: `Chat with ${p.firstName} ${relTime(e.startAt, now)}; prep in 2 minutes`,
        signals: { startAt: e.startAt },
        payload: { eventId: e.id },
        urgency: hours <= 30 ? 0.95 : 0.8,
        goalRelevance: goalRel(pid),
        confidence: e.coffeeChatConfidence ?? 0.8,
      });
    }
  }
  // action items
  for (const a of inp.actionItems) {
    if (a.status !== 'open' || !a.dueAt) continue;
    const due = new Date(a.dueAt).getTime();
    if (due <= now.getTime() + DAY) {
      const overdue = due < now.getTime() - DAY;
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
  // new outreach from recommendations (weekly pacing)
  const remaining = Math.max(0, inp.settings.weeklyOutreachTarget - inp.outreachSentThisWeek);
  const behind = now.getDay() >= 3 && remaining > inp.settings.weeklyOutreachTarget / 2;
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
      dedupeKey: `new:${r.personId}:${isoWeek(now)}`,
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

/** The end of the next business day after `now`, in local time (Friday and the weekend both look ahead to Monday). */
export function endOfNextBusinessDay(now: Date): number {
  const d = new Date(now);
  do d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

export function relTime(iso: string, now: Date): string {
  const diff = new Date(iso).getTime() - now.getTime();
  const h = Math.round(Math.abs(diff) / 3_600_000);
  const d = Math.round(Math.abs(diff) / DAY);
  if (diff > 0)
    return h < 36 ? (h <= 1 ? 'in about an hour' : h < 24 ? `in ${h} hours` : 'tomorrow') : `in ${d} days`;
  return h < 1 ? 'just now' : h < 24 ? `${h} hours ago` : d === 1 ? 'yesterday' : `${d} days ago`;
}

export function scoreCandidate(c: Candidate, dismissCounts: Map<string, number>): number {
  const value = 0.5 + 0.5 * c.goalRelevance;
  const dismissals = dismissCounts.get(`${c.kind}:${c.personId ?? ''}`) ?? 0;
  const fatigue = Math.max(0.4, 1 - 0.15 * dismissals);
  return c.urgency * value * c.confidence * fatigue;
}

const HARD_URGENT: SuggestionKind[] = ['schedule_confirm', 'thank_you', 'prep_brief', 'confirm_stage'];

export function selectForBrief(
  cands: Candidate[],
  dismissCounts: Map<string, number>,
  max = 7,
): (Candidate & { priorityScore: number })[] {
  const scored = cands
    .map((c) => ({ ...c, priorityScore: scoreCandidate(c, dismissCounts) }))
    .sort((a, b) => b.priorityScore - a.priorityScore);
  const chosen: (Candidate & { priorityScore: number })[] = [];
  const perPerson = new Set<string>();
  const perKind = new Map<SuggestionKind, number>();
  const limits: Partial<Record<SuggestionKind, number>> = {
    new_outreach: 2,
    reconnect: 1,
    nurture_checkin: 1,
    warm_up_engage: 2,
  };
  const take = (c: Candidate & { priorityScore: number }) => {
    if (chosen.length >= max) return;
    if (c.personId && perPerson.has(c.personId) && !isHard(c)) return;
    const n = perKind.get(c.kind) ?? 0;
    if (limits[c.kind] !== undefined && n >= limits[c.kind]!) return;
    chosen.push(c);
    if (c.personId) perPerson.add(c.personId);
    perKind.set(c.kind, n + 1);
  };
  const isHard = (c: Candidate) =>
    HARD_URGENT.includes(c.kind) || (c.kind === 'new_outreach' && !!c.signals.warmUpDone);
  for (const c of scored) if (isHard(c) && chosen.length < 5) take(c);
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

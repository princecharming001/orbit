import { maxBumpsFor, sectorOf } from '../drafts/sector';
import { declineReengage } from '../pipeline/transitions';
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
import { addBusinessDays, businessDaysBetween, localWeekday } from './calendar';

export * from './calendar';

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

/** Business days of silence before the first bump, and before the second (graceful last) one, by channel. */
export const BUMP_AFTER_BUSINESS_DAYS = { gmail: [5, 8], linkedin: [10, 12] } as const;
/** Business days of silence after the last allowed bump before the chat is closed as no response. */
export const NO_RESPONSE_AFTER_LAST_BUMP_BUSINESS_DAYS = 10;
/** An offered intro that has not happened after this many days gets a gentle follow-up. */
const INTRO_FOLLOWUP_AFTER_DAYS = 7;
const INTRO_FOLLOWUP_MAX_DAYS = 60;
/** An email introduction is answered within days; after two weeks the card stays, but the nudge does not. */
const INTRO_REPLY_DAYS = 14;
/** A live company: this many open threads there already and new cold outreach to it waits. */
const LIVE_THREADS_PER_COMPANY = 2;
const LIVE_STAGES: ChatStage[] = ['outreach_sent', 'replied', 'scheduling', 'scheduled'];
/** An offer to make an introduction, as opposed to an offer to refer or to forward a resume. */
export const INTRO_OFFER = /\b(intro(duce|duction)?|connect (you|me)|put (you|me) in touch)\b/i;
const REFERRAL_OFFER =
  /\b(refer|referral|put in a (good )?word|forward (your|my) resume|pass (your|my) resume)\b/i;
/** The status change of a target company is news worth sharing for this long. */
const STATUS_NEWS_DAYS = 21;
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

/**
 * Whether a proposed time can still be accepted: 'passed' once it has started, 'busy' when it clashes with the
 * calendar, 'soon' when it is still ahead but less than CONFIRM_LEAD_HOURS away (confirmable, but only right now),
 * 'ok' otherwise.
 */
export function usableProposedTime(
  t: ProposedTime,
  events: Pick<CalendarEvent, 'startAt' | 'endAt' | 'status'>[],
  now: Date,
): 'ok' | 'soon' | 'passed' | 'busy' {
  const start = new Date(t.startIso).getTime();
  if (Number.isNaN(start) || start <= now.getTime()) return 'passed';
  const end = t.endIso ? new Date(t.endIso).getTime() : start + 30 * 60_000;
  const busy = events.some(
    (e) =>
      e.status !== 'cancelled' && new Date(e.startAt).getTime() < end && new Date(e.endAt).getTime() > start,
  );
  if (busy) return 'busy';
  return start < now.getTime() + CONFIRM_LEAD_HOURS * HOUR ? 'soon' : 'ok';
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
          reasonText: prog.skippedAll
            ? `You skipped the warm-up. Message ${person.firstName} without it?`
            : `Warm-up done (${prog.done} of ${prog.total}); ready to message ${person.firstName}`,
          signals: { warmUpDone: prog.done, warmUpSkipped: prog.skippedAll || undefined },
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
    // someone introduced the student by email: answer while the intro is fresh, before any cold note (the
    // introducer is copied and watching)
    if (chat.stage === 'identified' && chat.introducedAt && !chat.lastOutboundAt) {
      const referrer = chat.referrerPersonId ? inp.people.get(chat.referrerPersonId) : undefined;
      const age = (now.getTime() - new Date(chat.introducedAt).getTime()) / DAY;
      if (referrer && age >= 0 && age <= INTRO_REPLY_DAYS) {
        out.push({
          kind: 'new_outreach',
          personId: chat.personId,
          chatId: chat.id,
          dedupeKey: `introreply:${chat.id}`,
          reasonText: `${referrer.firstName} introduced you to ${person.firstName} ${relTime(chat.introducedAt, now, inp.timezone)}; reply while the intro is fresh`,
          signals: { introducedBy: referrer.id, introducedAt: chat.introducedAt },
          payload: { channel: person.primaryEmail ? 'gmail' : 'linkedin', introducedBy: referrer.id },
          urgency: age > 3 ? 0.9 : 0.8,
          goalRelevance: liveRel,
          confidence: 1,
        });
      }
    }
    if (chat.stage === 'outreach_sent' && chat.lastOutboundAt) {
      const due = bumpDue(chat, person, inp);
      if (due) {
        out.push({
          kind: 'follow_up_bump',
          personId: chat.personId,
          chatId: chat.id,
          dedupeKey: `bump:${chat.id}:${chat.bumpCount + 1}`,
          reasonText: due.backFromOoo
            ? `${person.firstName} was out of office and should be back now; a short bump so your note is not lost`
            : chat.bumpCount === 0
              ? `No reply in ${due.bdays} business days; one short bump in case it got buried`
              : `Still quiet after ${due.bdays} business days; a graceful last word, then let it rest`,
          signals: { businessDays: due.bdays, bumpCount: chat.bumpCount, bumpNumber: chat.bumpCount + 1 },
          payload: { bumpNumber: chat.bumpCount + 1 },
          urgency: Math.min(0.9, 0.7 + 0.1 * (due.bdays - due.threshold)),
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
      ) &&
      // they said no to a call but yes to questions over email: proposing times would ignore what they asked
      !lastIn.extraction?.prefersEmail &&
      // they handed the student to someone else (redirect, "looping in Sam"): the next step is with that person
      !(lastIn.signal === 'intro_offer' && lastIn.extraction?.handoff)
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
      // a time with some lead first; one that starts within the next couple of hours can still be taken, now
      const usable = checked.find((c) => c.verdict === 'ok') ?? checked.find((c) => c.verdict === 'soon');
      if (usable) {
        const soon = usable.verdict === 'soon';
        out.push({
          kind: 'schedule_confirm',
          personId: chat.personId,
          chatId: chat.id,
          dedupeKey: `confirm:${chat.id}:${lastIn.id}`,
          reasonText: soon
            ? `${person.firstName} suggested ${usable.t.raw}, which starts ${relTime(usable.t.startIso, now, inp.timezone)}; confirm it right away`
            : `${person.firstName} suggested ${usable.t.raw}; confirm it`,
          signals: { proposed: usable.t, startsSoon: soon || undefined },
          payload: { inReplyTo: lastIn.id, time: usable.t },
          urgency: 1,
          goalRelevance: liveRel,
          confidence: lastIn.signalConfidence ?? 0.7,
        });
      } else {
        // every suggested time has passed or clashes with the calendar: answer with new times instead (the draft
        // owns up to the missed slot or names the conflict)
        const first = checked[0]! as { t: ProposedTime; verdict: 'passed' | 'busy' };
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
    const facts = (inp.factsByPerson.get(person.id) ?? []).filter((f) => !f.deletedAt);
    const factTime = (f: PersonFact) => new Date(f.occurredAt ?? f.createdAt).getTime();
    const settled = chat.stage === 'nurturing' || chat.stage === 'followed_up';
    // an intro they offered and that has not happened yet: a gentle follow-up with a blurb they can forward
    const introOffer = settled
      ? facts
          .filter((f) => f.type === 'offer' && INTRO_OFFER.test(f.text) && !REFERRAL_OFFER.test(f.text))
          .filter((f) => {
            const age = (now.getTime() - factTime(f)) / DAY;
            return age >= INTRO_FOLLOWUP_AFTER_DAYS && age <= INTRO_FOLLOWUP_MAX_DAYS;
          })
          .sort((a, b) => factTime(b) - factTime(a))[0]
      : undefined;
    const introHappened =
      !!introOffer &&
      inp.chats.some(
        (c) => c.referrerPersonId === person.id && new Date(c.createdAt).getTime() >= factTime(introOffer),
      );
    const quietSince = (days: number) =>
      !chat.lastOutboundAt || now.getTime() - new Date(chat.lastOutboundAt).getTime() >= days * DAY;
    if (introOffer && !introHappened && quietSince(5)) {
      const target = introTarget(introOffer.text);
      const age = Math.round((now.getTime() - factTime(introOffer)) / DAY);
      out.push({
        kind: 'intro_request',
        personId: person.id,
        chatId: chat.id,
        dedupeKey: `introfu:${introOffer.id}`,
        reasonText: `${person.firstName} offered to introduce you to ${target.phrase} ${age} days ago; follow up with a blurb they can forward`,
        signals: { offerId: introOffer.id, offeredAt: introOffer.occurredAt ?? introOffer.createdAt },
        payload: {
          offerId: introOffer.id,
          target: {
            name: target.name,
            firstName: target.name,
            org: person.currentOrganizationRaw,
            offered: true,
          },
        },
        urgency: 0.6,
        goalRelevance: liveRel,
        confidence: 1,
      });
    }
    // a decline with a time limit ("not this quarter") is a "not now": once the window has passed (and at least three
    // weeks after they said it), one polite second try is fair
    if (chat.stage === 'declined' && lastIn?.signal === 'reply_decline') {
      const saidAt = new Date(lastIn.sentAt);
      const re = declineReengage(lastIn.bodyText, saidAt);
      const due = re ? Math.max(new Date(re.at).getTime(), saidAt.getTime() + 21 * DAY) : 0;
      if (
        re &&
        now.getTime() >= due &&
        now.getTime() - due < 45 * DAY &&
        (!chat.lastOutboundAt || new Date(chat.lastOutboundAt) < saidAt) &&
        !inp.recentlyContacted.has(person.id)
      )
        out.push({
          kind: 'reconnect',
          personId: chat.personId,
          chatId: chat.id,
          dedupeKey: `reengage:${chat.id}:${lastIn.id}`,
          reasonText: `${person.firstName} said not ${re.said}; that has passed, so one short note is fair`,
          signals: { saidAt: lastIn.sentAt, reengageAt: re.at },
          payload: { reengage: { said: re.said, past: re.past, at: lastIn.sentAt } },
          urgency: 0.5,
          goalRelevance: rel,
          confidence: 0.9,
        });
    }
    if (
      chat.stage === 'nurturing' ||
      (chat.stage === 'followed_up' &&
        chat.followedUpAt &&
        now.getTime() - new Date(chat.followedUpAt).getTime() > 14 * DAY)
    ) {
      // the last real conversation: a meeting, note, email or message either way, or the chat itself
      const convIso = [inp.lastConversationByPerson?.get(person.id), chat.completedAt]
        .filter((x): x is string => !!x)
        .sort()
        .pop();
      // without one, any touch (a LinkedIn connection, a CC) still dates the relationship, but is not a conversation
      const lastIso = convIso ?? person.lastInteractionAt;
      const days = lastIso ? (now.getTime() - new Date(lastIso).getTime()) / DAY : undefined;
      const since = convIso ? 'since your last conversation' : 'since you were last in touch';
      const cadence = CADENCE[person.relationshipType];
      // an offered intro gets its own follow-up; "how did that go?" is not a question about an offer
      const hook = facts
        .filter((f) => f.type === 'hook' || (f.type === 'offer' && !INTRO_OFFER.test(f.text)))
        .filter((f) => now.getTime() - factTime(f) <= HOOK_MAX_AGE_DAYS * DAY)
        .sort((a, b) => factTime(b) - factTime(a))[0];
      // with no hook, a plain "quick update" note is still worth sending every six to eight weeks; the draft asks
      // the student for the update instead of inventing one
      // (only after a real conversation: "keeps it warm" means nothing when you never actually talked)
      const updateDue = !!convIso && days !== undefined && days >= cadence + 14;
      // with no date at all, only a hook can justify a note; its text then says nothing about time
      const cadenceDue = days === undefined ? !!hook : days >= cadence;
      if (cadenceDue && !inp.recentlyContacted.has(person.id) && (hook || updateDue)) {
        out.push({
          kind: 'nurture_checkin',
          personId: chat.personId,
          chatId: chat.id,
          dedupeKey: `nurture:${person.id}:${monthKey(now)}`,
          reasonText: hook
            ? days === undefined
              ? `You have a reason to check in with ${person.firstName}: "${clip(hook.text, 60)}"`
              : `${Math.round(days)} days ${since}; you have a hook: "${clip(hook.text, 60)}"`
            : `${Math.round(days ?? 0)} days ${since}; a short update on your search keeps it warm`,
          signals: { days, cadence, hookId: hook?.id },
          payload: hook ? { hookId: hook.id } : { needsUpdate: true },
          urgency: 0.4,
          goalRelevance: rel,
          confidence: 1,
        });
      }
    }
    if (settled) {
      const offer = facts.find((f) => f.type === 'offer' && REFERRAL_OFFER.test(f.text));
      const tc = targetCompanyOf(person, inp.targetCompanies);
      const deadlineDays = tc?.deadline ? (new Date(tc.deadline).getTime() - now.getTime()) / DAY : undefined;
      // a referral only helps before or right with the application: ask while researching once the deadline is
      // within a month (or they offered), and right away once applied
      const timely =
        !!tc &&
        (tc.status === 'applied' ||
          (tc.status === 'researching' &&
            (!!offer || (deadlineDays !== undefined && deadlineDays >= 0 && deadlineDays <= 30))));
      if (tc && timely && (offer || person.strength >= 0.5) && !inp.recentlyContacted.has(person.id)) {
        const soon = deadlineDays !== undefined && deadlineDays < 7;
        out.push({
          kind: 'ask_referral',
          personId: person.id,
          chatId: chat.id,
          dedupeKey: `ref:${person.id}:${tc.id}`,
          reasonText: offer
            ? tc.status === 'applied'
              ? `${person.firstName} offered to refer you and your ${tc.nameRaw} application is in`
              : `${person.firstName} offered to refer you; ask before you apply to ${tc.nameRaw}`
            : tc.status === 'applied'
              ? `You applied to ${tc.nameRaw} and you're close with ${person.firstName}; a referral can still help`
              : `${tc.nameRaw} closes ${deadlineDays !== undefined && deadlineDays < 1.5 ? 'very soon' : `in ${Math.ceil(deadlineDays ?? 0)} days`}; ask ${person.firstName} for a referral before you apply`,
          signals: { offerId: offer?.id, deadline: tc.deadline, status: tc.status },
          payload: { targetCompanyId: tc.id, offerId: offer?.id },
          urgency: 0.65 + (soon ? 0.2 : 0),
          goalRelevance: 1,
          confidence: 1,
        });
      }
    }
  }
  // an intro just landed ("Looping in Sam"): write to the person introduced while it is fresh
  for (const chat of inp.chats) {
    // (an intro read from an email carries introducedAt and gets its card from the intro reply rule above)
    if (chat.stage !== 'identified' || !chat.referrerPersonId || chat.lastOutboundAt || chat.introducedAt)
      continue;
    if (now.getTime() - new Date(chat.stageEnteredAt).getTime() > 14 * DAY) continue;
    const target = inp.people.get(chat.personId);
    const referrer = inp.people.get(chat.referrerPersonId);
    if (!target?.isHuman || target.hiddenAt || !referrer) continue;
    out.push({
      kind: 'new_outreach',
      personId: target.id,
      chatId: chat.id,
      dedupeKey: `intro:${chat.id}`,
      reasonText: `${referrer.firstName} introduced you to ${target.firstName}; write to ${target.firstName} while the intro is fresh`,
      signals: { introducedBy: referrer.id },
      payload: { channel: target.primaryEmail ? 'gmail' : 'linkedin' },
      urgency: 0.85,
      goalRelevance: goalRel(target.id),
      confidence: 1,
    });
  }
  // status news: applied, interviewing or an offer at a target company goes to the people who helped there
  // (and, for an offer, to mentors), one card per person; the brief's one-check-in limit spreads them over days
  for (const tc of inp.targetCompanies) {
    if (!['applied', 'interviewing', 'offer'].includes(tc.status) || !tc.statusChangedAt) continue;
    const changed = new Date(tc.statusChangedAt).getTime();
    if (now.getTime() - changed > STATUS_NEWS_DAYS * DAY || changed > now.getTime()) continue;
    for (const chat of inp.chats) {
      if (chat.stage !== 'followed_up' && chat.stage !== 'nurturing') continue;
      const p = inp.people.get(chat.personId);
      if (!p?.isHuman || p.hiddenAt) continue;
      const atCompany = targetCompanyOf(p, [tc]) === tc;
      const mentor = p.relationshipType === 'mentor' && tc.status === 'offer';
      if (!atCompany && !mentor) continue;
      // they already know if you talked after the change
      const lastTalk = inp.lastConversationByPerson?.get(p.id);
      if (lastTalk && new Date(lastTalk).getTime() > changed) continue;
      const update =
        tc.status === 'offer'
          ? `I received an offer from ${tc.nameRaw}, and I wanted to thank you for your help along the way`
          : tc.status === 'interviewing'
            ? `I'm now interviewing with ${tc.nameRaw}`
            : `I submitted my application to ${tc.nameRaw}`;
      out.push({
        kind: 'nurture_checkin',
        personId: p.id,
        chatId: chat.id,
        dedupeKey: `status:${tc.id}:${tc.status}:${p.id}`,
        reasonText:
          tc.status === 'offer'
            ? `You have an offer from ${tc.nameRaw}; thank ${p.firstName} and share the news`
            : tc.status === 'interviewing'
              ? `You're interviewing at ${tc.nameRaw}; tell ${p.firstName}, who helped you get there`
              : `You applied to ${tc.nameRaw}; let ${p.firstName} know, since you talked with them`,
        signals: { targetCompanyId: tc.id, status: tc.status, statusChangedAt: tc.statusChangedAt },
        payload: { targetCompanyId: tc.id, statusUpdate: tc.status, update },
        urgency: tc.status === 'offer' ? 0.6 : 0.5,
        goalRelevance: atCompany ? 1 : 0.6,
        confidence: 1,
      });
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
  // prep briefs: from 30 hours before the chat until it starts, and all day the day before (a brief built just
  // after midnight still lists tomorrow's chat), by calendar day in the student's timezone
  const tomorrow = new Date(Date.parse(`${todayKey(now, inp.timezone)}T00:00:00Z`) + DAY)
    .toISOString()
    .slice(0, 10);
  // the next weekday after today in the student's timezone: a Friday or weekend brief preps Monday's chat
  let nextBusinessDay = tomorrow;
  while ([0, 6].includes(new Date(`${nextBusinessDay}T00:00:00Z`).getUTCDay()))
    nextBusinessDay = new Date(Date.parse(`${nextBusinessDay}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
  for (const e of inp.events) {
    if (e.status === 'cancelled' || !e.attendeePersonIds.length) continue;
    const start = new Date(e.startAt).getTime();
    const hours = (start - now.getTime()) / HOUR;
    // within 30 hours, all of tomorrow, or on the next business day (not the weekend days before it)
    const day = todayKey(new Date(start), inp.timezone);
    const soon = hours <= 30 || day <= tomorrow || day === nextBusinessDay;
    if (hours > 0 && soon && (e.isCoffeeChat ?? false)) {
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
        urgency: hours <= 30 ? 0.95 : 0.8,
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
        reasonText: `${overdue ? 'Overdue' : 'Due today'}: ${clip(a.text, 80)}${p ? ` (for ${p.firstName})` : ''}`,
        signals: { dueAt: a.dueAt, overdue },
        payload: { actionItemId: a.id },
        urgency: 0.7 + (overdue ? 0.15 : 0),
        // a promise made to someone is the student's word: it outranks any company fit score
        goalRelevance: 1,
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
  // companies where the student already has live threads: a third cold note there waits until one resolves, so
  // contacts do not compare near-identical emails
  const orgKey = (p?: Person) =>
    p ? (p.currentOrganizationId ?? p.currentOrganizationRaw?.toLowerCase() ?? undefined) : undefined;
  const liveByOrg = new Map<string, number>();
  for (const c of inp.chats) {
    if (!LIVE_STAGES.includes(c.stage)) continue;
    const k = orgKey(inp.people.get(c.personId));
    if (k) liveByOrg.set(k, (liveByOrg.get(k) ?? 0) + 1);
  }
  for (const r of inp.recommendations
    .filter((r) => r.status === 'new' || r.status === 'saved')
    .sort((a, b) => (b.status === 'saved' ? 1 : 0) - (a.status === 'saved' ? 1 : 0) || b.score - a.score)) {
    if (added >= Math.min(2, remaining)) break;
    if (inp.chats.some((c) => c.personId === r.personId && c.stage !== 'archived')) continue;
    const p = inp.people.get(r.personId);
    if (!p) continue;
    const k = orgKey(p);
    if (k && (liveByOrg.get(k) ?? 0) >= LIVE_THREADS_PER_COMPANY) continue;
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

/** The end of the next business day after `now`, in local time (Friday and the weekend both look ahead to Monday). */
export function endOfNextBusinessDay(now: Date): number {
  const d = new Date(now);
  do d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/** The target company a person works at, matched by organization id or by name. */
export function targetCompanyOf(
  p: Pick<Person, 'currentOrganizationId' | 'currentOrganizationRaw'>,
  tcs: TargetCompany[],
): TargetCompany | undefined {
  const orgRaw = (p.currentOrganizationRaw ?? '').toLowerCase();
  return tcs.find(
    (t) =>
      (!!p.currentOrganizationId && t.organizationId === p.currentOrganizationId) ||
      (!!orgRaw && t.nameRaw.toLowerCase() === orgRaw),
  );
}

/**
 * Who an offered intro is to, from the offer as the note or the email phrased it ("Happy to intro me to their PM
 * lead", "offered to connect me with Priya on the growth team"). `phrase` is for the card ("their PM lead"),
 * `name` is how the student says it back to the person who offered ("your PM lead").
 */
export function introTarget(offer: string): { phrase: string; name: string } {
  const m =
    /\b(?:intro(?:duce)?|connect|put)\b(?: (?:me|you|him|her|them))?(?: in touch)? (?:to|with) (.+?)(?:[.;!?]|,| if | when | once |$)/i.exec(
      offer,
    );
  const raw = (m?.[1] ?? '').trim().replace(/\s+/g, ' ');
  if (!raw || raw.length > 60) return { phrase: 'someone they know', name: 'the person you mentioned' };
  const phrase = raw.replace(/^(his|her)\b/i, 'their');
  const name = phrase.replace(/^their\b/i, 'your').replace(/^(a|an) /i, 'a ');
  return { phrase, name };
}

/**
 * Whether a follow-up bump is due on an unanswered thread: enough business days of silence since the last message
 * (5 then 8 for email, 10 then 12 for LinkedIn; holidays and the winter freeze do not count), bumps left under the
 * sector cap, and any out-of-office return date (plus two business days) behind us.
 */
export function bumpDue(
  chat: Pick<
    CoffeeChat,
    | 'stage'
    | 'lastOutboundAt'
    | 'lastInboundAt'
    | 'bumpCount'
    | 'outreachChannel'
    | 'bumpNotBefore'
    | 'outOfOfficeUntil'
  >,
  person: Pick<Person, 'currentTitle' | 'currentOrganizationRaw'>,
  inp: Pick<RuleInput, 'now' | 'settings' | 'timezone'>,
): { bdays: number; threshold: number; backFromOoo: boolean } | undefined {
  if (chat.stage !== 'outreach_sent' || !chat.lastOutboundAt) return undefined;
  const since = new Date(chat.lastOutboundAt);
  if (chat.lastInboundAt && new Date(chat.lastInboundAt) >= since) return undefined;
  const maxBumps = maxBumpsFor(
    sectorOf({ title: person.currentTitle, org: person.currentOrganizationRaw }),
    inp.settings.maxBumps,
  );
  if (chat.bumpCount >= maxBumps) return undefined;
  const steps = BUMP_AFTER_BUSINESS_DAYS[chat.outreachChannel === 'linkedin' ? 'linkedin' : 'gmail'];
  const threshold = steps[Math.min(chat.bumpCount, steps.length - 1)]!;
  const bdays = businessDaysBetween(since, inp.now, inp.timezone);
  if (bdays < threshold) return undefined;
  // an out-of-office return date (YYYY-MM-DD) holds the bump until two business days after it, like bumpNotBefore
  const holds = [
    chat.bumpNotBefore ? new Date(chat.bumpNotBefore) : undefined,
    chat.outOfOfficeUntil
      ? addBusinessDays(new Date(`${chat.outOfOfficeUntil}T12:00:00Z`), 2, inp.timezone)
      : undefined,
  ].filter((d): d is Date => !!d && !Number.isNaN(d.getTime()));
  const notBefore = holds.length ? new Date(Math.max(...holds.map((d) => d.getTime()))) : undefined;
  if (notBefore && inp.now < notBefore) return undefined;
  // the out-of-office reply is what held the bump back if, without it, the bump would have been due earlier
  const backFromOoo =
    !!notBefore && addBusinessDays(since, threshold, inp.timezone).getTime() < notBefore.getTime();
  return { bdays, threshold, backFromOoo };
}

/**
 * On a quiet day only time-bound items make the brief. Quiet days are the student's own choice (`quietDays`,
 * weekdays in their timezone): many students do their networking on weekends, so a Saturday or a holiday is not
 * quiet unless they say so. Business days still govern when a bump is due and when a thread is closed.
 */
export function isQuietDay(now: Date, settings: Pick<UserSettings, 'quietDays'>, tz?: string): boolean {
  return settings.quietDays.includes(localWeekday(now, tz));
}

/** A thank-you is due while the conversation is fresh and nothing has gone out since it ended. */
export function thankYouDue(chat: Pick<CoffeeChat, 'completedAt' | 'lastOutboundAt'>, now: Date): boolean {
  if (!chat.completedAt) return false;
  const completed = new Date(chat.completedAt).getTime();
  if (now.getTime() - completed >= THANK_YOU_WINDOW_DAYS * DAY) return false;
  if (chat.lastOutboundAt && new Date(chat.lastOutboundAt).getTime() > completed) return false;
  return true;
}

/** Shorten to at most `max` characters on a word boundary, with "..." when something was cut. */
export function clip(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t.replace(/[.\s]+$/, '');
  const cut = t.slice(0, max - 3);
  const at = cut.lastIndexOf(' ');
  return `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[,;:.\s]+$/, '')}...`;
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

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * A month in words relative to now: "this month", "last month", "in March", "last September" (within a year),
 * "in September 2024" (older).
 */
export function monthPhrase(iso: string, now: Date, tz?: string): string {
  const k = todayKey(new Date(iso), tz);
  const n = todayKey(now, tz);
  const [y, m] = [Number(k.slice(0, 4)), Number(k.slice(5, 7))];
  const [ny, nm] = [Number(n.slice(0, 4)), Number(n.slice(5, 7))];
  const months = (ny - y) * 12 + (nm - m);
  const name = MONTH_NAMES[m - 1]!;
  if (months <= 0) return 'this month';
  if (months === 1) return 'last month';
  if (y === ny) return `in ${name}`;
  if (months < 12) return `last ${name}`;
  return `in ${name} ${y}`;
}

const TOUCH_WORDS: Record<string, string> = {
  meeting: 'met',
  note: 'met',
  email_in: 'emailed',
  email_out: 'emailed',
  linkedin_in: 'messaged on LinkedIn',
  linkedin_out: 'messaged on LinkedIn',
  linkedin_connected: 'connected on LinkedIn',
  linkedin_engaged: 'engaged on LinkedIn',
  manual_log: 'were in touch',
  email_cc: 'were on the same email thread',
  intro_observed: 'were in touch',
};

/**
 * One plain sentence about the history with a person for their summary: "You have 3 interactions in the last
 * 90 days, most recently 2 days ago." or, when nothing is recent, "You last met last September." Only touches
 * within 90 days are called recent.
 */
export function lastContactPhrase(
  tps: { kind: string; occurredAt: string }[],
  now: Date,
  tz?: string,
): string {
  if (!tps.length) return 'No interactions yet.';
  const sorted = [...tps].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const latest = sorted[0]!;
  const recent = sorted.filter((t) => now.getTime() - new Date(t.occurredAt).getTime() <= 90 * DAY);
  if (recent.length) {
    const when = relTime(latest.occurredAt, now, tz);
    return recent.length === 1
      ? `You were last in touch ${when}.`
      : `You have ${recent.length} interactions in the last 90 days, most recently ${when}.`;
  }
  const verb = TOUCH_WORDS[latest.kind] ?? 'were in touch';
  const when = monthPhrase(latest.occurredAt, now, tz);
  return verb.startsWith('were ') ? `You were last ${verb.slice(5)} ${when}.` : `You last ${verb} ${when}.`;
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
  // following up on an intro the person offered: their offer, so it comes before strangers
  'intro_request',
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

/** Kinds that may still go out on a quiet day: answers inside a live exchange and time-bound items. */
const QUIET_DAY_KINDS: SuggestionKind[] = [
  ...HARD_URGENT,
  'schedule_propose',
  'action_item_reminder',
  'warm_up_engage',
];

export function selectForBrief(
  cands: Candidate[],
  dismissCounts: Map<string, number>,
  max = 7,
  opts: {
    orgOf?: (personId: string) => string | undefined;
    /** a quiet day (see isQuietDay): cold and optional messages wait for the next working day */
    quiet?: boolean;
  } = {},
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
  // promises due today or overdue are never crowded out
  const isHard = (c: Candidate) =>
    HARD_URGENT.includes(c.kind) ||
    c.kind === 'action_item_reminder' ||
    (c.kind === 'new_outreach' && (!!c.signals.warmUpDone || !!c.signals.introducedBy));
  const isMessage = (c: Candidate) => MESSAGE_KINDS.includes(c.kind);
  const take = (c: Candidate & { priorityScore: number }) => {
    if (chosen.length >= max) return;
    if (opts.quiet && !QUIET_DAY_KINDS.includes(c.kind)) return;
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
  // an email intro waiting on the student's reply is an obligation too, though its kind is new_outreach
  const isObligation = (c: Candidate) => OBLIGATION_KINDS.includes(c.kind) || !!c.signals.introducedBy;
  for (const c of scored) if (!chosen.includes(c) && isObligation(c)) take(c);
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

/** Rule-made cards whose kind can also be made by hand (an intro asked from the Reach panel is the student's). */
const RULE_KEY_PREFIXES = ['introfu:'];

/** Whether a suggestion row came from generateCandidates, so the validity pass may retire it. */
export function isRuleSuggestion(s: Pick<Suggestion, 'kind' | 'dedupeKey'>): boolean {
  return RULE_KINDS.includes(s.kind) || RULE_KEY_PREFIXES.some((p) => s.dedupeKey.startsWith(p));
}

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

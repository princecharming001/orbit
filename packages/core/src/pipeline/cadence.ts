import { maxBumpsFor, sectorOf } from '../drafts/sector';
import { addBusinessDays, businessDaysBetween, isBusinessDayKey } from '../suggestions/calendar';
import { bumpDue, thankYouDue } from '../suggestions/rules';
import type { ChatStage, CoffeeChat, Goal, GoalKind, MessageKind, Person, UserSettings } from '../types';
import { todayKey } from '../util/ids';
import { ACTIVE_STAGES, decideTransition } from './transitions';

/**
 * The cadence scan (plan 16 §9.2) as pure functions: given the student's chats, drafts, messages, people and goals at
 * `now`, which follow-ups are due. The browser's daily maintenance and the server's hourly `cadence.user` job read the
 * same list; neither sends anything here. Bump timing, went-quiet, thank-you and stage timers reuse the v1 rules.
 */

const DAY = 86_400_000;

/** Days without an answer after the student's last message before a chat counts as gone quiet. */
export const QUIET_DAYS = 7;
const WAITING_STAGES: ChatStage[] = ['outreach_sent', 'replied', 'scheduling'];

/** True when the student wrote last, at least a week ago, and the chat is still waiting on the other person. */
export function wentQuiet(
  chat: Pick<CoffeeChat, 'stage' | 'lastOutboundAt' | 'lastInboundAt' | 'stageEnteredAt'>,
  now = new Date(),
): boolean {
  if (!WAITING_STAGES.includes(chat.stage) || !chat.lastOutboundAt) return false;
  if (chat.lastInboundAt && chat.lastInboundAt >= chat.lastOutboundAt) return false;
  // moved on since the student last wrote ("They replied", a move on the board): an answer Orbit cannot see came in
  if (chat.stage !== 'outreach_sent' && chat.stageEnteredAt > chat.lastOutboundAt) return false;
  return now.getTime() - new Date(chat.lastOutboundAt).getTime() >= QUIET_DAYS * DAY;
}

/** Goals whose cold outreach gets a second bump, seven business days after the first (§7.1, §9.2). */
export const SECOND_BUMP_GOALS: ReadonlySet<GoalKind> = new Set(['sales', 'fundraising', 'hiring']);
export const SECOND_BUMP_AFTER_BUSINESS_DAYS = 7;
/** Never more than this many messages to one person without an answer, across channels (§7.1, §14.6). */
export const MAX_UNANSWERED = 3;
/** Days without contact before a nurture note is due, by tie band; goal-linked people sooner (§9.2). */
export const NURTURE_DAYS = { close: 60, strong: 90, goal: 30 } as const;
export const NURTURE_PER_WEEK = 3;
/** Someone the student knows this well counts as cold for the second-bump rule below it. */
const COLD_SCORE = 40;

export type CadenceActionKind = 'bump' | 'went_quiet' | 'thank_you' | 'stage_timer' | 'nurture' | 'send_due';

export interface CadenceAction {
  kind: CadenceActionKind;
  chatId?: string;
  personId?: string;
  draftId?: string;
  goalId?: string;
  /** a stage timer's target stage */
  toStage?: ChatStage;
  /** a bump's number (1, 2) */
  bumpNumber?: number;
  /** the draft kind to write for it */
  draftKind?: MessageKind;
  reason: string;
  /** ISO time it is due (now, or the next business morning when today is a weekend or holiday) */
  dueAt: string;
}

/** A message in either direction on either channel, as the scan needs it. */
export interface CadenceMessage {
  personId: string;
  direction: 'in' | 'out';
  at: string;
  channel: 'email' | 'linkedin';
  chatId?: string;
}

/** A draft as the scan needs it (orbit.drafts / OutboundMessage). */
export interface CadenceDraft {
  id: string;
  personId: string;
  chatId?: string;
  kind: MessageKind;
  status: string;
  sendAt?: string;
  createdAt: string;
}

export interface CadencePerson {
  person: Pick<Person, 'id' | 'firstName' | 'currentTitle' | 'currentOrganizationRaw' | 'hiddenAt'> & {
    doNotContact?: boolean;
  };
  /** tie score 0–100 */
  score: number;
  /** last real contact either way (messages, meetings) */
  lastContactAt?: string;
  /** a reason to write now (a new role, their post, a dossier "recently" item, the student's own news) */
  nurtureReason?: string;
  /** their time zone, for weekends and send windows; the student's when unknown */
  timeZone?: string;
}

export interface CadenceSettings extends Pick<UserSettings, 'maxBumps'> {
  timezone?: string;
  /** on vacation: no drafts or sends until then */
  quietUntil?: string;
}

export interface CadenceInput {
  chats: CoffeeChat[];
  drafts: CadenceDraft[];
  messages: CadenceMessage[];
  people: ReadonlyMap<string, CadencePerson>;
  goals: Goal[];
  settings: CadenceSettings;
  now: Date;
  /** nurture notes already suggested or drafted (ISO times), for the weekly cap */
  recentNurtureAt?: string[];
}

/** Messages sent to a person since their last answer, across channels. */
export function unansweredCount(personId: string, messages: CadenceMessage[]): number {
  const mine = messages.filter((m) => m.personId === personId).sort((a, b) => a.at.localeCompare(b.at));
  let n = 0;
  for (const m of mine) n = m.direction === 'in' ? 0 : n + 1;
  return n;
}

/** The send handler's last check (§9.3): an inbound message newer than the draft cancels it with reason `replied`. */
export function cancelIfReplied(
  draft: Pick<CadenceDraft, 'personId' | 'createdAt'>,
  messages: CadenceMessage[],
): { cancel: true; reason: 'replied'; at: string } | { cancel: false } {
  const newer = messages
    .filter((m) => m.personId === draft.personId && m.direction === 'in' && m.at > draft.createdAt)
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  return newer ? { cancel: true, reason: 'replied', at: newer.at } : { cancel: false };
}

/** Weekends and US federal holidays in `tz` are not send days. */
export function isSendDay(d: Date, tz?: string): boolean {
  return isBusinessDayKey(todayKey(d, tz));
}

/** `d` itself when it is a send day, else 9:00 on the next one (in `tz`, approximated by shifting whole days). */
export function nextSendDay(d: Date, tz?: string): Date {
  if (isSendDay(d, tz)) return d;
  const next = addBusinessDays(d, 1, tz);
  const key = todayKey(next, tz);
  const offset = zoneOffsetMs(next, tz);
  return new Date(Date.parse(`${key}T09:00:00Z`) - offset);
}

function zoneOffsetMs(d: Date, tz?: string): number {
  if (!tz) return 0;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

const ACTIVE_GOAL = (g: Goal) => g.status === 'active' && !g.deletedAt;

/** The active goal a chat serves: its own goal, else a goal that names the person. */
function goalOf(chat: CoffeeChat, goals: Goal[]): Goal | undefined {
  const active = goals.filter(ACTIVE_GOAL);
  return (
    (chat.goalId ? active.find((g) => g.id === chat.goalId) : undefined) ??
    active.find((g) => g.targets.people.includes(chat.personId))
  );
}

function sentCount(chat: CoffeeChat): number {
  return (chat.firstOutreachAt ? 1 : 0) + chat.bumpCount;
}

/**
 * Every follow-up due at `now` (§9.2): bumps (the v1 timing, plus a second bump seven business days after the first
 * for cold sales, fundraising and hiring outreach), went-quiet notices, thank-yous, stage timers, nurture notes for
 * close or goal-linked people (with a reason, at most three a week) and approved drafts whose time has come. Nothing
 * is due while the student is on vacation, nobody gets a fourth unanswered message on any channel, and nothing goes
 * to someone marked do-not-contact.
 */
export function cadenceActions(inp: CadenceInput): CadenceAction[] {
  const { now, settings } = inp;
  const tz = settings.timezone;
  if (settings.quietUntil && now.getTime() < new Date(settings.quietUntil).getTime()) return [];
  const out: CadenceAction[] = [];
  const due = (personId?: string) => {
    const ptz = (personId ? inp.people.get(personId)?.timeZone : undefined) ?? tz;
    return nextSendDay(now, ptz).toISOString();
  };
  const blocked = (personId: string) => {
    const p = inp.people.get(personId);
    return !!p?.person.doNotContact || !!p?.person.hiddenAt;
  };
  const room = (personId: string) => unansweredCount(personId, inp.messages) < MAX_UNANSWERED;

  for (const chat of inp.chats) {
    if (chat.archivedAt) continue;
    const pc = inp.people.get(chat.personId);
    const person = pc?.person ?? { id: chat.personId, firstName: 'them' };
    const goal = goalOf(chat, inp.goals);
    const base = { chatId: chat.id, personId: chat.personId, ...(goal ? { goalId: goal.id } : {}) };

    // 1. bumps
    if (!blocked(chat.personId) && room(chat.personId) && sentCount(chat) < MAX_UNANSWERED) {
      const v1 = bumpDue(chat, person, {
        now,
        settings: { ...settings, quietDays: [] } as unknown as UserSettings,
        timezone: tz,
      });
      if (v1) {
        out.push({
          kind: 'bump',
          ...base,
          bumpNumber: chat.bumpCount + 1,
          draftKind: 'bump',
          reason: `No reply in ${v1.bdays} business days${v1.backFromOoo ? ', and they are back from time off' : ''}`,
          dueAt: due(chat.personId),
        });
      } else if (
        goal &&
        SECOND_BUMP_GOALS.has(goal.kind) &&
        chat.stage === 'outreach_sent' &&
        chat.bumpCount === 1 &&
        (pc?.score ?? 0) < COLD_SCORE &&
        chat.lastOutboundAt &&
        !(chat.lastInboundAt && chat.lastInboundAt >= chat.lastOutboundAt) &&
        maxBumpsFor(
          sectorOf({ title: person.currentTitle, org: person.currentOrganizationRaw }),
          settings.maxBumps,
        ) < 2
      ) {
        const bdays = businessDaysBetween(new Date(chat.lastOutboundAt), now, tz);
        if (bdays >= SECOND_BUMP_AFTER_BUSINESS_DAYS)
          out.push({
            kind: 'bump',
            ...base,
            bumpNumber: 2,
            draftKind: 'bump',
            reason: `Second and last bump for ${goal.kind}: ${bdays} business days since the first`,
            dueAt: due(chat.personId),
          });
      }
    }

    // 2. went quiet
    if (wentQuiet(chat, now))
      out.push({
        kind: 'went_quiet',
        ...base,
        reason: `No answer for ${Math.floor((now.getTime() - new Date(chat.lastOutboundAt!).getTime()) / DAY)} days`,
        dueAt: now.toISOString(),
      });

    // 3. thank-you
    if (
      (chat.stage === 'completed' || chat.stage === 'scheduled') &&
      thankYouDue(chat, now) &&
      !blocked(chat.personId)
    )
      out.push({
        kind: 'thank_you',
        ...base,
        draftKind: 'thank_you',
        reason: 'You met in the last three days and have not thanked them yet',
        dueAt: due(chat.personId),
      });

    // 4. stage timers
    const timer = stageTimer(chat, person, settings, now);
    if (timer)
      out.push({
        kind: 'stage_timer',
        ...base,
        toStage: timer.to,
        reason: timer.reason,
        dueAt: now.toISOString(),
      });
  }

  // 5. nurture
  const weekAgo = now.getTime() - 7 * DAY;
  const used = (inp.recentNurtureAt ?? []).filter((t) => new Date(t).getTime() > weekAgo).length;
  const left = Math.max(0, NURTURE_PER_WEEK - used);
  if (left > 0) {
    const goalPeople = new Map<string, Goal>();
    for (const g of inp.goals.filter(ACTIVE_GOAL)) for (const id of g.targets.people) goalPeople.set(id, g);
    for (const c of inp.chats) {
      const g = goalOf(c, inp.goals);
      if (g && !goalPeople.has(c.personId)) goalPeople.set(c.personId, g);
    }
    const busy = new Set(
      inp.chats.filter((c) => !c.archivedAt && WAITING_STAGES.includes(c.stage)).map((c) => c.personId),
    );
    const pending = new Set(
      inp.drafts
        .filter((d) => ['draft', 'approved', 'queued', 'scheduled'].includes(d.status))
        .map((d) => d.personId),
    );
    const candidates: (CadenceAction & { score: number })[] = [];
    for (const [id, p] of inp.people) {
      if (blocked(id) || busy.has(id) || pending.has(id) || !p.nurtureReason || !room(id)) continue;
      const goal = goalPeople.get(id);
      const days = goal
        ? NURTURE_DAYS.goal
        : p.score >= 80
          ? NURTURE_DAYS.close
          : p.score >= 60
            ? NURTURE_DAYS.strong
            : 0;
      if (!days) continue;
      const last = p.lastContactAt ? new Date(p.lastContactAt).getTime() : Number.NEGATIVE_INFINITY;
      if (now.getTime() - last < days * DAY) continue;
      candidates.push({
        kind: 'nurture',
        personId: id,
        ...(goal ? { goalId: goal.id } : {}),
        draftKind: p.score >= 30 && now.getTime() - last >= 180 * DAY ? 'reengage' : 'nurture',
        reason: p.nurtureReason,
        dueAt: due(id),
        score: p.score + (goal ? 100 : 0),
      });
    }
    candidates.sort((a, b) => b.score - a.score || a.personId!.localeCompare(b.personId!));
    for (const { score: _s, ...c } of candidates.slice(0, left)) out.push(c);
  }

  // 6. approved drafts whose time has come (re-checked for a reply and the unanswered limit)
  for (const d of inp.drafts) {
    if (!['approved', 'scheduled', 'queued'].includes(d.status) || !d.sendAt) continue;
    if (new Date(d.sendAt).getTime() > now.getTime() || blocked(d.personId)) continue;
    if (cancelIfReplied(d, inp.messages).cancel || !room(d.personId)) continue;
    const ptz = inp.people.get(d.personId)?.timeZone ?? tz;
    if (!isSendDay(now, ptz)) continue;
    out.push({
      kind: 'send_due',
      draftId: d.id,
      personId: d.personId,
      ...(d.chatId ? { chatId: d.chatId } : {}),
      reason: `Scheduled for ${d.sendAt}`,
      dueAt: d.sendAt,
    });
  }
  return out;
}

/** The v1 stage timers (transitions.ts): no response after the bumps, and nurturing two weeks after a chat ends. */
function stageTimer(
  chat: CoffeeChat,
  person: Pick<Person, 'currentTitle' | 'currentOrganizationRaw'>,
  settings: CadenceSettings,
  now: Date,
): { to: ChatStage; reason: string } | undefined {
  if (!ACTIVE_STAGES.includes(chat.stage)) return undefined;
  const entered = new Date(chat.stageEnteredAt).getTime();
  if (chat.stage === 'followed_up' && now.getTime() - entered >= 14 * DAY)
    return decideTransition('followed_up', { type: 'timer_followed_up_14d' });
  if (chat.stage === 'completed' && now.getTime() - entered >= 14 * DAY)
    return decideTransition('completed', { type: 'timer_completed_14d' });
  if (chat.stage !== 'outreach_sent' || !chat.lastOutboundAt) return undefined;
  if (chat.lastInboundAt && chat.lastInboundAt > chat.lastOutboundAt) return undefined;
  const fromIso =
    chat.bumpNotBefore && chat.bumpNotBefore > chat.lastOutboundAt ? chat.bumpNotBefore : chat.lastOutboundAt;
  const from = new Date(fromIso);
  if (from.getTime() > now.getTime()) return undefined;
  const maxBumps = maxBumpsFor(
    sectorOf({ title: person.currentTitle, org: person.currentOrganizationRaw }),
    settings.maxBumps,
  );
  return decideTransition('outreach_sent', {
    type: 'timer_no_response',
    bumps: chat.bumpCount,
    maxBumps,
    daysSilent: (now.getTime() - from.getTime()) / DAY,
    businessDaysSilent: businessDaysBetween(from, now, settings.timezone),
  });
}

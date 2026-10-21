/**
 * Autopilot: the student approves a set of drafts once, and Orbit sends them itself over the coming days, spaced the
 * way a person writes: weekdays only, inside their sending hours, a different gap each time, never more in a day
 * than their daily limits. Each message is approved like any other (the text is bound and checked), then waits in
 * the outbox with its own time. When its time comes it is checked again (a reply since, a cooldown, a hidden
 * person) and sent, or put back as a draft with the reason. If Orbit was closed, the ones it missed are spread out
 * again instead of going all at once.
 */
import type { OutboundMessage, User } from '@orbit/core';
import { db } from '../db/schema';
import { usesMockConnectors } from '../integrations/connectorsMock';
import { AUTOPILOT_DEFAULT_PER_DAY, planSpread } from './autopilotTime';
import { linkedInSendActive } from './linkedinLive';
import { approveAndSend, googleSendActive } from './send';

/** Autopilot can send this message itself: Gmail with send permission, live LinkedIn, or the demo's simulation. */
export async function autopilotCanSend(user: User, msg: OutboundMessage): Promise<boolean> {
  if (usesMockConnectors(user.id)) return true;
  if (msg.channel === 'gmail') return googleSendActive(user.id);
  if (msg.channel === 'linkedin') {
    const person = await db.people.get(msg.personId);
    return !!person && linkedInSendActive(user, person);
  }
  return false;
}

/** Sends already planned by autopilot, soonest first. */
export async function scheduledSends(userId: string): Promise<OutboundMessage[]> {
  const rows = await db.outbound
    .where('userId')
    .equals(userId)
    .filter((o) => o.status === 'queued' && !!o.autopilot && !!o.sendAt)
    .toArray();
  return rows.sort((a, b) => a.sendAt!.localeCompare(b.sendAt!));
}

export interface SchedulePlanItem {
  id: string;
  personId: string;
  at: Date;
}

/** The plan for these drafts: each gets a time, spread out (or at the times given), around what is already planned. */
export async function planSchedule(
  user: User,
  drafts: OutboundMessage[],
  opts: { perDay?: number; start?: Date; at?: Record<string, Date>; now?: Date } = {},
): Promise<SchedulePlanItem[]> {
  const now = opts.now ?? new Date();
  const settings = await db.settings.get(user.id);
  const cap = Math.min(settings?.dailySendCapGmail ?? 20, settings?.dailySendCapLinkedin ?? 20);
  const perDay = Math.max(1, Math.min(cap, opts.perDay ?? AUTOPILOT_DEFAULT_PER_DAY));
  const fixed = drafts.filter((d) => opts.at?.[d.id]);
  const spread = drafts.filter((d) => !opts.at?.[d.id]);
  const taken = (await scheduledSends(user.id)).map((o) => new Date(o.sendAt!));
  const times = planSpread({
    count: spread.length,
    start: opts.start && opts.start > now ? opts.start : now,
    perDay,
    taken: [...taken, ...fixed.map((d) => opts.at![d.id]!)],
    seed: drafts.length * 31 + Math.floor(now.getTime() / 3_600_000),
  });
  return [
    ...fixed.map((d) => ({ id: d.id, personId: d.personId, at: opts.at![d.id]! })),
    ...spread.map((d, i) => ({ id: d.id, personId: d.personId, at: times[i]! })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
}

export type ScheduleOutcome = { id: string; ok: true; at: string } | { id: string; ok: false; error: string };

/**
 * Approve each draft for autopilot at its planned time. The engine checks each one as if it were sent then (caps
 * count on the day it goes out); one that cannot go is left as a draft with the reason.
 */
export async function scheduleSends(
  user: User,
  plan: SchedulePlanItem[],
  now = new Date(),
): Promise<ScheduleOutcome[]> {
  const out: ScheduleOutcome[] = [];
  for (const p of plan) {
    const msg = await db.outbound.get(p.id);
    if (!msg) {
      out.push({ id: p.id, ok: false, error: 'That draft is gone.' });
      continue;
    }
    if (!(await autopilotCanSend(user, msg))) {
      out.push({
        id: p.id,
        ok: false,
        error:
          msg.channel === 'gmail'
            ? 'Autopilot sends email through Gmail. Connect Google with permission to send, in Settings, Integrations.'
            : 'Autopilot sends LinkedIn messages through live LinkedIn. Connect it in Settings, Integrations.',
      });
      continue;
    }
    const r = await approveAndSend(user, msg.id, msg.bodyFinal ?? msg.bodyDraft, msg.subject, now, {
      scheduleAt: p.at,
    });
    out.push(r.ok ? { id: p.id, ok: true, at: p.at.toISOString() } : { id: p.id, ok: false, error: r.error });
  }
  return out;
}

/** Take a planned send off autopilot: it goes back to a draft, untouched. */
export async function cancelScheduled(userId: string, id: string): Promise<boolean> {
  return db.transaction('rw', db.outbound, async () => {
    const m = await db.outbound.get(id);
    if (!m || m.userId !== userId || m.status !== 'queued' || !m.autopilot) return false;
    await db.outbound.update(id, {
      status: 'draft',
      sendAt: undefined,
      queuedAt: undefined,
      autopilot: undefined,
    });
    return true;
  });
}

export {
  AUTOPILOT_DEFAULT_PER_DAY,
  AUTOPILOT_GAP_MIN,
  AUTOPILOT_WINDOW,
  nextOpen,
  planSpread,
} from './autopilotTime';

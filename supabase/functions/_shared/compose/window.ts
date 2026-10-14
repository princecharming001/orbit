/**
 * The send window (§7.3): the next Tuesday, Wednesday or Thursday (Monday too on LinkedIn), 8:00–10:30 in the
 * recipient's time zone, never on a US federal holiday, with 0–20 minutes of jitter so sends do not land on the
 * minute. Computed with the IANA zone at send time, so DST changes are handled.
 */
import { usHolidays } from '@orbit/core/suggestions/calendar';
import { addDaysKey, localParts, validZone, weekdayOfKey, zonedTime } from '../zones.ts';

export const WINDOW_START = { hour: 8, minute: 0 };
export const WINDOW_END = { hour: 10, minute: 30 };
export const JITTER_MAX_MIN = 20;

export function sendDayAllowed(key: string, channel: 'gmail' | 'linkedin'): boolean {
  const dow = weekdayOfKey(key);
  const ok = dow === 2 || dow === 3 || dow === 4 || (channel === 'linkedin' && dow === 1);
  return ok && !usHolidays(Number(key.slice(0, 4))).has(key);
}

/** The earliest moment in the next send window at or after `now`, plus jitter. */
export function nextSendWindow(
  now: Date,
  tz: string,
  channel: 'gmail' | 'linkedin',
  random: () => number = Math.random,
): { notBefore: string; tz: string } {
  const zone = validZone(tz) ?? 'America/New_York';
  const jitterMs = Math.floor(random() * (JITTER_MAX_MIN + 1)) * 60_000;
  let key = localParts(now, zone).key;
  for (let i = 0; i < 21; i++, key = addDaysKey(key, 1)) {
    if (!sendDayAllowed(key, channel)) continue;
    const start = zonedTime(key, WINDOW_START.hour, WINDOW_START.minute, zone).getTime();
    const end = zonedTime(key, WINDOW_END.hour, WINDOW_END.minute, zone).getTime();
    if (now.getTime() >= end) continue;
    const at = Math.min(Math.max(now.getTime(), start) + jitterMs, end);
    return { notBefore: new Date(at).toISOString(), tz: zone };
  }
  return { notBefore: now.toISOString(), tz: zone };
}

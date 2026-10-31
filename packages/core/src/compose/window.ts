/**
 * The send window (plan 16 §7.3), shared by the browser (plan 23 §4.9: what Orbit sends on its own) and the server:
 * the next Tuesday, Wednesday or Thursday (Monday too on LinkedIn), 8:00 to 10:30 in the recipient's time zone, never
 * on a US federal holiday, with 0 to 20 minutes of jitter so sends do not land on the minute. Computed with the IANA
 * zone at send time, so DST changes are handled. The server's copy (supabase/functions/_shared/compose/window.ts)
 * answers the same; a test holds the two to it.
 */
import { usHolidays } from '../suggestions/calendar';

export const WINDOW_START = { hour: 8, minute: 0 };
export const WINDOW_END = { hour: 10, minute: 30 };
export const JITTER_MAX_MIN = 20;

function validZone(tz: string | null | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

/** The local date and time of an instant in a zone. */
export function zonedParts(
  d: Date,
  tz: string,
): { key: string; hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    key: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
  };
}

function offsetMs(d: Date, tz: string): number {
  const p = zonedParts(d, tz);
  const [y, m, day] = p.key.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, day, p.hour, p.minute) - Math.floor(d.getTime() / 60_000) * 60_000;
}

/** The instant of a local date (YYYY-MM-DD) at hour:minute in a zone. */
export function zonedInstant(key: string, hour: number, minute: number, tz: string): Date {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d, hour, minute);
  let t = naive - offsetMs(new Date(naive), tz);
  t = naive - offsetMs(new Date(t), tz);
  return new Date(t);
}

/** The local date `n` calendar days after `key` (YYYY-MM-DD). */
export const addDaysKey = (key: string, n: number) =>
  new Date(Date.parse(`${key}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function sendDayAllowed(key: string, channel: 'gmail' | 'linkedin'): boolean {
  const dow = new Date(`${key}T00:00:00Z`).getUTCDay();
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
  let key = zonedParts(now, zone).key;
  for (let i = 0; i < 21; i++, key = addDaysKey(key, 1)) {
    if (!sendDayAllowed(key, channel)) continue;
    const start = zonedInstant(key, WINDOW_START.hour, WINDOW_START.minute, zone).getTime();
    const end = zonedInstant(key, WINDOW_END.hour, WINDOW_END.minute, zone).getTime();
    if (now.getTime() >= end) continue;
    const at = Math.min(Math.max(now.getTime(), start) + jitterMs, end);
    return { notBefore: new Date(at).toISOString(), tz: zone };
  }
  return { notBefore: now.toISOString(), tz: zone };
}

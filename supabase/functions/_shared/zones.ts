/**
 * Wall-clock time in IANA zones without a date library: the local date and time of an instant, and the instant of a
 * local date and time (DST-safe: the offset is taken at the target instant, then corrected once).
 */

export interface LocalParts {
  /** YYYY-MM-DD */
  key: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday */
  weekday: number;
}

export function validZone(tz: string | null | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

export function localParts(d: Date, tz: string): LocalParts {
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
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return {
    key: `${get('year')}-${get('month')}-${get('day')}`,
    year,
    month,
    day,
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday,
  };
}

/** Milliseconds the zone is ahead of UTC at instant `d`. */
export function offsetMs(d: Date, tz: string): number {
  const p = localParts(d, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(d.getTime() / 60_000) * 60_000;
}

/** The instant of local `key` (YYYY-MM-DD) at hour:minute in `tz`. */
export function zonedTime(key: string, hour: number, minute: number, tz: string): Date {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d, hour, minute);
  let t = naive - offsetMs(new Date(naive), tz);
  t = naive - offsetMs(new Date(t), tz);
  return new Date(t);
}

/** The key `n` calendar days after `key`. */
export function addDaysKey(key: string, n: number): string {
  const t = Date.parse(`${key}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export const weekdayOfKey = (key: string) => new Date(`${key}T00:00:00Z`).getUTCDay();

/** A short zone name for labels: "ET", "PT" where the runtime knows a generic name, else "EDT", "GMT+2". */
export function zoneAbbrev(d: Date, tz: string): string {
  for (const style of ['shortGeneric', 'short'] as const) {
    try {
      const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: style })
        .formatToParts(d)
        .find((p) => p.type === 'timeZoneName')?.value;
      if (name && style === 'short') return name;
      if (name && name.length <= 4 && !/^GMT/.test(name)) return name;
    } catch {
      // try the next style
    }
  }
  return tz;
}

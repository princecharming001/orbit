/**
 * Time helpers for drafts. Everything is resolved in the student's timezone (`user.timezone`), windows carry the
 * weekday and the date, the zone label is computed for the window's own date (so a November window says EST even
 * when proposed in October), and nothing in the past is ever proposed.
 */

export interface Window {
  startIso: string;
  endIso?: string;
}

function safeTz(tz: string | undefined): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** Wall-clock parts of `d` in `tz`. */
export function partsIn(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTz(tz),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  return { y: +p.year!, m: +p.month!, d: +p.day!, h: +p.hour! % 24, min: +p.minute! };
}
function offsetMs(d: Date, tz: string): number {
  const p = partsIn(d, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - Math.floor(d.getTime() / 60_000) * 60_000;
}
/** The instant at which the wall clock in `tz` reads y-m-d h:min. */
export function zonedTime(y: number, m: number, d: number, h: number, min: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, min);
  let t = guess - offsetMs(new Date(guess), tz);
  t = guess - offsetMs(new Date(t), tz);
  return new Date(t);
}

export function tzAbbr(tz: string, at: Date): string {
  try {
    const v =
      new Intl.DateTimeFormat('en-US', { timeZone: safeTz(tz), timeZoneName: 'short' })
        .formatToParts(at)
        .find((p) => p.type === 'timeZoneName')?.value ?? tz;
    return v.replace(/^GMT([+-]\d+)$/, 'UTC$1').replace(/^GMT$/, 'UTC');
  } catch {
    return tz;
  }
}

export function fmtTime(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: safeTz(tz),
  }).formatToParts(d);
  const h = parts.find((p) => p.type === 'hour')?.value ?? '';
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const ap = (parts.find((p) => p.type === 'dayPeriod')?.value ?? '').toLowerCase();
  return m === '00' ? `${h}${ap}` : `${h}:${m}${ap}`;
}

/** "Thursday, Oct 8 at 10am" (no zone; see fmtWindows). */
export function fmtWindow(w: Window, tz: string): string {
  const d = new Date(w.startIso);
  const day = d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: safeTz(tz),
  });
  return `${day} at ${fmtTime(d, tz)}`;
}

/** "Thursday, Oct 8 at 10am or Monday, Oct 12 at 2pm (EDT)"; the zone is per window when they differ. */
export function fmtWindows(ws: Window[], tz: string): string {
  const labels = ws.map((w) => tzAbbr(tz, new Date(w.startIso)));
  const same = labels.every((l) => l === labels[0]);
  const items = ws.map((w, i) => `${fmtWindow(w, tz)}${same ? '' : ` ${labels[i]}`}`);
  const joined =
    items.length <= 2 ? items.join(' or ') : `${items.slice(0, -1).join(', ')}, or ${items.at(-1)}`;
  return same && labels[0] ? `${joined} (${labels[0]})` : joined;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/**
 * Real free windows for a call: on different weekdays (skipping a day between them), one in the morning and one in
 * the afternoon, at least 12 hours out, with 15 minutes of buffer around anything on the student's calendar.
 */
export function proposeWindows(
  busy: { startIso: string; endIso?: string; status?: string }[],
  now: Date,
  tz: string,
  opts: { count?: number; minutes?: number; seed?: string } = {},
): Required<Window>[] {
  const zone = safeTz(tz);
  const count = opts.count ?? 2;
  const len = (opts.minutes ?? 30) * 60_000;
  const rot = hash(opts.seed ?? '') % 4;
  const rotate = (a: [number, number][]) => [...a.slice(rot), ...a.slice(0, rot)];
  const morning = rotate([
    [10, 0],
    [11, 0],
    [9, 30],
    [10, 30],
  ]);
  const afternoon = rotate([
    [14, 0],
    [15, 30],
    [13, 30],
    [16, 0],
  ]);
  const blocks = busy
    .filter((b) => b.status !== 'cancelled')
    .map((b) => {
      const s = new Date(b.startIso).getTime();
      return [s, b.endIso ? new Date(b.endIso).getTime() : s + 30 * 60_000] as const;
    });
  const today = partsIn(now, zone);
  const out: Required<Window>[] = [];
  const usedMinutes = new Set<number>();
  for (let off = 1; off <= 21 && out.length < count; off++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + off));
    const wd = day.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    // one morning and one afternoon: prefer whichever period the windows so far are missing
    const haveMorning = out.some((o) => partsIn(new Date(o.startIso), zone).h < 12);
    const prefs = out.length === 0 || !haveMorning ? [...morning, ...afternoon] : [...afternoon, ...morning];
    for (const [h, mi] of prefs) {
      if (usedMinutes.has(h * 60 + mi)) continue;
      const s = zonedTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, mi, zone);
      const st = s.getTime();
      if (st < now.getTime() + 12 * 3_600_000) continue;
      const clash = blocks.some(([bs, be]) => bs < st + len + 15 * 60_000 && be > st - 15 * 60_000);
      if (clash) continue;
      out.push({ startIso: s.toISOString(), endIso: new Date(st + len).toISOString() });
      usedMinutes.add(h * 60 + mi);
      off++; // leave a day between the two options
      break;
    }
  }
  return out;
}

/** Calendar days between two instants, as seen on the wall clock in `tz`. */
export function calendarDaysBetween(from: Date, to: Date, tz: string): number {
  const a = partsIn(from, tz);
  const b = partsIn(to, tz);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}

/** Where a past meeting sits relative to now: "this morning", "yesterday", "on Tuesday", "last week", "on September 12". */
export function whenLabel(iso: string | undefined, now: Date, tz: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const days = calendarDaysBetween(d, now, tz);
  const zone = safeTz(tz);
  if (days <= 0) {
    const h = partsIn(d, zone).h;
    return h < 12 ? 'this morning' : h < 17 ? 'this afternoon' : 'this evening';
  }
  if (days === 1) return 'yesterday';
  if (days < 7) return `on ${d.toLocaleDateString('en-US', { weekday: 'long', timeZone: zone })}`;
  if (days < 14) return 'last week';
  return `on ${d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: zone })}`;
}

/** For "since we talked ...": "last week", "a few weeks ago", "in September". */
export function sinceLabel(iso: string | undefined, now: Date, tz: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  const days = calendarDaysBetween(d, now, tz);
  if (days < 2) return undefined;
  if (days < 14) return 'last week';
  if (days < 35) return 'a few weeks ago';
  return `in ${d.toLocaleDateString('en-US', { month: 'long', timeZone: safeTz(tz) })}`;
}

export function overlapsBusy(
  startIso: string,
  minutes: number,
  busy: { startIso: string; endIso?: string; status?: string }[],
): boolean {
  const s = new Date(startIso).getTime();
  const e = s + minutes * 60_000;
  return busy.some((b) => {
    if (b.status === 'cancelled') return false;
    const bs = new Date(b.startIso).getTime();
    const be = b.endIso ? new Date(b.endIso).getTime() : bs + 30 * 60_000;
    return bs < e && be > s;
  });
}

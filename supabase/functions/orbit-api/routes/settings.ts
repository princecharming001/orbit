/**
 * Agent settings (§8.4, §9.3, §14.3):
 *   POST /settings/autonomy {level, goalId?}  → the user's autonomy level, or one goal's override
 *   POST /settings/pause {until}              → users.settings.quiet_until (null resumes)
 *   POST /settings/profile {postalAddress?, schedulingLink?, timezone?, onboardingCompletedAt?, school?, degree?,
 *                          majors?, graduationYear?, currentCity?, about?}
 *        → users.settings.postal_address / scheduling_link (null or '' removes), users.timezone,
 *          users.onboarding.completed_at (set once setup is finished; never cleared), and the student's profile:
 *          users.school, degree, majors, grad_year, current_city (null or '' clears), and the student's own words
 *          about their goals (plan 24) as users.settings.about (the whole set replaces the stored one; null clears),
 *          and readReplyTone (plan 27) as users.settings.read_reply_tone (false only; true removes it), which rescores
 */
import { cleanAnswer, cleanCurrentJob, OWN_WORDS_KEYS, type OwnWords } from '@orbit/core/ownWords';
import type { ProfileSettingsResponse } from '@orbit/core/server/api';
import { badRequest, HttpError, json } from '../../_shared/http.ts';
import { sqlQueue } from '../../_shared/queue.ts';
import { validZone } from '../../_shared/zones.ts';
import type { Ctx, Route } from '../api.ts';
import { body, optUuid } from './body.ts';

async function autonomy(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  const level = Number(b.level);
  if (![0, 1, 2].includes(level)) throw badRequest('level is 0, 1 or 2');
  const goalId = optUuid(b, 'goalId');
  const userId = ctx.userId!;
  if (goalId) {
    const r = await ctx.db.sql`
      update orbit.goals set autonomy_level = ${level}::smallint
       where id = ${goalId}::uuid and user_id = ${userId}::uuid and deleted_at is null returning id`;
    if (!r.length) throw new HttpError(404, 'not_found', 'no such goal');
  } else
    await ctx.db.sql`update orbit.users set autonomy_level = ${level}::smallint where id = ${userId}::uuid`;
  await ctx.db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${userId}::uuid, 'user', 'settings.autonomy', ${goalId ? 'goals' : 'users'}, ${goalId ?? userId},
            ${{ level }}::jsonb)`;
  return json(200, { ok: true, level, goalId: goalId ?? null });
}

async function pause(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  let until: string | null = null;
  if (b.until !== null && b.until !== undefined) {
    const t = new Date(String(b.until));
    if (typeof b.until !== 'string' || Number.isNaN(t.getTime()))
      throw badRequest('until must be an ISO time or null');
    until = t.toISOString();
  }
  const userId = ctx.userId!;
  await ctx.db.sql`
    update orbit.users
       set settings = case when ${until}::text is null then settings - 'quiet_until'
                           else jsonb_set(settings, '{quiet_until}', to_jsonb(${until}::text)) end
     where id = ${userId}::uuid`;
  await ctx.db.sql`
    insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
    values (${userId}::uuid, 'user', 'settings.pause', 'users', ${userId}, ${{ until }}::jsonb)`;
  return json(200, { ok: true, until });
}

export const POSTAL_ADDRESS_MAX = 500;
export const SCHEDULING_LINK_MAX = 500;
export const PROFILE_TEXT_MAX = 200;
/** One written answer as sent (plan 24); the browser keeps 600 after cleaning, so this only refuses a misuse. */
export const ABOUT_TEXT_MAX = 2000;

/** A setting to keep, to remove (null), or to leave alone (undefined). */
function optText(b: Record<string, unknown>, key: string): string | null | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') throw badRequest(`${key} must be text or null`);
  return v.trim() || null;
}

/**
 * The student's own words (plan 24) as kept: only the known answers, each text and at most OWN_WORDS_MAX characters
 * (longer is refused, not cut), a job as a link and a note; null clears, undefined leaves them alone.
 */
export function aboutFrom(b: Record<string, unknown>): OwnWords | null | undefined {
  const v = b.about;
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw badRequest('about must be an object or null');
  const o = v as Record<string, unknown>;
  const out: OwnWords = {};
  for (const k of OWN_WORDS_KEYS) {
    const x = o[k];
    if (x === undefined || x === null) continue;
    if (typeof x !== 'string') throw badRequest(`about.${k} must be text`);
    if (x.length > ABOUT_TEXT_MAX) throw badRequest(`about.${k} is at most ${ABOUT_TEXT_MAX} characters`);
    const t = cleanAnswer(x);
    if (t) out[k] = t;
  }
  if (o.currentJob !== undefined && o.currentJob !== null) {
    if (typeof o.currentJob !== 'object') throw badRequest('about.currentJob must be {url?, text?}');
    const j = o.currentJob as Record<string, unknown>;
    if (
      (j.url !== undefined && typeof j.url !== 'string') ||
      (j.text !== undefined && typeof j.text !== 'string')
    )
      throw badRequest('about.currentJob must be {url?, text?}');
    const job = cleanCurrentJob(j);
    if (job) out.currentJob = job;
  }
  return Object.keys(out).length ? out : null;
}

/** Time zones by IANA name (America/New_York, UTC), known to this runtime; offsets and abbreviations are refused. */
export function ianaZone(tz: string): string | undefined {
  return /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(tz) && tz.length <= 64
    ? validZone(tz)
    : undefined;
}

function isHttpsLink(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && !!u.hostname;
  } catch {
    return false;
  }
}

async function profile(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  const postal = optText(b, 'postalAddress');
  if (postal && postal.length > POSTAL_ADDRESS_MAX)
    throw badRequest(`postalAddress is at most ${POSTAL_ADDRESS_MAX} characters`);
  const link = optText(b, 'schedulingLink');
  if (link && (!isHttpsLink(link) || link.length > SCHEDULING_LINK_MAX))
    throw badRequest('schedulingLink must be an https link');
  let tz: string | undefined;
  if (b.timezone !== undefined) {
    if (typeof b.timezone !== 'string' || !ianaZone(b.timezone.trim()))
      throw badRequest('timezone must be an IANA time zone, like America/New_York');
    tz = b.timezone.trim();
  }
  // the student's own profile: what the drafts and research say about who they are
  const profileText = (key: string, max: number): string | null | undefined => {
    const v = optText(b, key);
    if (v && v.length > max) throw badRequest(`${key} is at most ${max} characters`);
    return v;
  };
  const school = profileText('school', PROFILE_TEXT_MAX);
  const degree = profileText('degree', 100);
  const city = profileText('currentCity', 200);
  let majors: string[] | undefined;
  if (b.majors !== undefined) {
    if (
      !Array.isArray(b.majors) ||
      b.majors.length > 6 ||
      !b.majors.every((m) => typeof m === 'string' && m.trim().length <= 100)
    )
      throw badRequest('majors must be a list of at most 6 names');
    majors = (b.majors as string[]).map((m) => m.trim()).filter(Boolean);
  }
  let gradYear: number | null | undefined;
  if (b.graduationYear !== undefined) {
    if (
      b.graduationYear !== null &&
      (!Number.isInteger(b.graduationYear) ||
        Number(b.graduationYear) < 1950 ||
        Number(b.graduationYear) > 2100)
    )
      throw badRequest('graduationYear must be a year or null');
    gradYear = b.graduationYear as number | null;
  }
  let done: string | undefined;
  if (b.onboardingCompletedAt !== undefined) {
    const t = new Date(String(b.onboardingCompletedAt));
    if (typeof b.onboardingCompletedAt !== 'string' || Number.isNaN(t.getTime()))
      throw badRequest('onboardingCompletedAt must be an ISO time');
    done = t.toISOString();
  }
  const about = aboutFrom(b);
  if (b.readReplyTone !== undefined && typeof b.readReplyTone !== 'boolean')
    throw badRequest('readReplyTone must be true or false');
  const tone = b.readReplyTone as boolean | undefined;
  const userId = ctx.userId!;
  // the keys given are replaced (or removed when null); the rest of settings is kept
  const given: Record<string, string | OwnWords | boolean | null> = {};
  if (postal !== undefined) given.postal_address = postal;
  if (link !== undefined) given.scheduling_link = link;
  if (about !== undefined) given.about = about;
  // on is the default, so only "off" is stored
  if (tone !== undefined) given.read_reply_tone = tone ? null : false;
  const keep = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== null));
  const [after] = await ctx.db.sql<{
    settings: Record<string, unknown>;
    timezone: string;
    school: string | null;
    degree: string | null;
    majors: string[];
    grad_year: number | null;
    current_city: string | null;
  }>`
    update orbit.users
       set settings = (settings - ${Object.keys(given)}::text[]) || ${keep}::jsonb,
           timezone = coalesce(${tz ?? null}::text, timezone),
           onboarding = case when ${done ?? null}::text is null then onboarding
                             else coalesce(onboarding, '{}'::jsonb) || jsonb_build_object('completed_at', ${done ?? null}::text) end,
           school = case when ${school !== undefined} then ${school ?? null}::text else school end,
           degree = case when ${degree !== undefined} then ${degree ?? null}::text else degree end,
           majors = case when ${majors !== undefined} then ${majors ?? []}::text[] else majors end,
           grad_year = case when ${gradYear !== undefined} then ${gradYear ?? null}::int else grad_year end,
           current_city = case when ${city !== undefined} then ${city ?? null}::text else current_city end
     where id = ${userId}::uuid
    returning settings, timezone, school, degree, majors, grad_year, current_city`;
  if (!after) throw new HttpError(404, 'not_found', 'no such user');
  const profileFields = (
    [
      ['school', school],
      ['degree', degree],
      ['majors', majors],
      ['graduationYear', gradYear],
      ['currentCity', city],
    ] as const
  )
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k);
  const changed = [
    ...Object.keys(given),
    ...(tz ? ['timezone'] : []),
    ...(done ? ['onboarding'] : []),
    ...profileFields,
  ];
  if (changed.length)
    await ctx.db.sql`
      insert into orbit.audit_log (user_id, actor, action, target_table, target_id, details)
      values (${userId}::uuid, 'user', 'settings.profile', 'users', ${userId}, ${{ fields: changed }}::jsonb)`;
  // the tone reading on or off changes every score: rescore now rather than tonight
  if (tone !== undefined)
    await sqlQueue(ctx.db).enqueue({
      kind: 'score.user',
      userId,
      payload: { reason: 'reply_tone' },
      dedupeKey: `score.user:${userId}:reply_tone:${Date.now()}`,
    });
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const out: ProfileSettingsResponse = {
    postalAddress: str(after.settings?.postal_address),
    schedulingLink: str(after.settings?.scheduling_link),
    timezone: after.timezone,
    school: after.school,
    degree: after.degree,
    majors: after.majors ?? [],
    graduationYear: after.grad_year,
    currentCity: after.current_city,
    about: (after.settings?.about as OwnWords | undefined) ?? null,
  };
  return json(200, out);
}

export const settingsRoutes: Record<string, Route> = {
  '/settings/autonomy': { method: 'POST', auth: true, run: autonomy },
  '/settings/pause': { method: 'POST', auth: true, run: pause },
  '/settings/profile': { method: 'POST', auth: true, run: profile },
};

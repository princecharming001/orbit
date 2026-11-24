/**
 * Plan 44 §9.3, Roles for you. All POST, the shapes in packages/core/src/roles/types.ts.
 *
 *   /roles/profile  {read: ProfileLines} → {proposed, note?}; {save: RoleProfile} → {profile, proposed?};
 *                   {get: true} → {profile?, proposed?}: `profile` is the one the student confirmed, absent until then
 *   /roles/search   {fresh?} → RolesSearchResponse: filter, rank, list the 60 to read, what is already read
 *   /roles/more     {searchId} → the next 10 read closely; in production the answer comes at once with every row read so
 *                   far and the reading carries on behind it. 404 `search_replaced` when a newer search took its place
 *   /roles/list     {view?: 'matches' | 'saved', rest?} → what is stored, free; Saved keeps closed roles
 *   /roles/score    {url? | text?, title?, company?} → {match} or {problem} (no profile yet is a problem, not an error)
 *   /roles/act      {matchId, status, dismissReason?} → {match} | {watch: {companyName, on}} → {watching}
 *
 * Every route answers 404 `not_offered` while the feature is not offered (the owner's Launch switch or ORBIT_FEATURES)
 * to anyone but the owner, who can always try it.
 */
import type { ProfileLines, RolesProfileResponse } from '../../../../packages/core/src/roles/types.ts';
import { featureOffered } from '../../_shared/features.ts';
import { badRequest, HttpError, json } from '../../_shared/http.ts';
import { loadProfile, readProfile, saveProfile } from '../../_shared/roles/profile.ts';
import type { RolesDeps } from '../../_shared/roles/score.ts';
import { act, list, more, scoreOne, startSearch } from '../../_shared/roles/search.ts';
import { roleSources } from '../../_shared/roles/sources.ts';
import type { Ctx, Route } from '../api.ts';
import { isOwner } from './admin.ts';
import { body, uuid } from './body.ts';

const deps = (ctx: Ctx): RolesDeps => ({
  sources: ctx.roleSources ?? roleSources,
  ...(ctx.waitUntil ? { background: ctx.waitUntil } : {}),
});

/** The feature's gate: offered, or the owner. */
async function offered(ctx: Ctx): Promise<void> {
  if (isOwner(ctx)) return;
  if (!(await featureOffered(ctx.db, 'roles', ctx.env.features ?? [])))
    throw new HttpError(404, 'not_offered', 'Roles is not offered yet.');
}

const gated =
  (run: (ctx: Ctx) => Promise<Response>) =>
  async (ctx: Ctx): Promise<Response> => {
    await offered(ctx);
    return run(ctx);
  };

const isLines = (v: unknown): v is ProfileLines =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  (!('resume' in v) || typeof (v as { resume?: unknown }).resume === 'object') &&
  (!('linkedin' in v) || typeof (v as { linkedin?: unknown }).linkedin === 'object');

/** Fills the arrays a client may leave out, so a short body reads as empty and not as an error. */
function linesOf(v: ProfileLines): ProfileLines {
  const arr = <T>(x: T[] | undefined): T[] => (Array.isArray(x) ? x : []);
  const out: ProfileLines = {};
  if (v.resume)
    out.resume = {
      experience: arr(v.resume.experience).map((e) => ({
        ...e,
        lines: arr(e.lines).filter((l) => typeof l === 'string'),
      })),
      education: arr(v.resume.education).map((e) => ({ ...e, lines: arr(e.lines) })),
      projects: arr(v.resume.projects).map((p) => ({
        ...p,
        lines: arr(p.lines).filter((l) => typeof l === 'string'),
      })),
      skills: arr(v.resume.skills).filter((x) => typeof x === 'string'),
      courses: arr(v.resume.courses).filter((x) => typeof x === 'string'),
    };
  if (v.linkedin)
    out.linkedin = {
      ...(typeof v.linkedin.headline === 'string' ? { headline: v.linkedin.headline } : {}),
      ...(typeof v.linkedin.about === 'string' ? { about: v.linkedin.about } : {}),
      positions: arr(v.linkedin.positions).filter((p) => p && typeof p.title === 'string'),
      schools: arr(v.linkedin.schools).filter((p) => p && typeof p.school === 'string'),
      skills: arr(v.linkedin.skills).filter((x) => typeof x === 'string'),
      projects: arr(v.linkedin.projects).filter((p) => p && typeof p.name === 'string'),
    };
  return out;
}

async function profile(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  if ('read' in b) {
    if (!isLines(b.read)) throw badRequest('read is ProfileLines');
    const out = await readProfile(ctx.services(), ctx.userId!, linesOf(b.read));
    return json(200, out);
  }
  if ('save' in b) {
    const stored = await saveProfile(ctx.db, ctx.userId!, b.save, ctx.now());
    const out: RolesProfileResponse = {
      profile: stored.profile,
      ...(stored.proposed ? { proposed: stored.proposed } : {}),
    };
    return json(200, out);
  }
  if (b.get === true) {
    // `profile` only once the student has confirmed one; before that, what Orbit proposed, so the browser opens the
    // review screen on it again and never a search on a profile nobody checked
    const stored = await loadProfile(ctx.db, ctx.userId!);
    const out: RolesProfileResponse = stored
      ? {
          ...(stored.confirmed ? { profile: stored.profile } : {}),
          ...(stored.proposed ? { proposed: stored.proposed } : {}),
        }
      : {};
    return json(200, out);
  }
  throw badRequest('read, save or get is required');
}

async function search(ctx: Ctx): Promise<Response> {
  const b = await body(ctx, true);
  return json(200, await startSearch(ctx.services(), deps(ctx), ctx.userId!, { fresh: b.fresh === true }));
}

async function moreRoute(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  return json(200, await more(ctx.services(), deps(ctx), ctx.userId!, uuid(b, 'searchId')));
}

async function listRoute(ctx: Ctx): Promise<Response> {
  const b = await body(ctx, true);
  const view = b.view === 'saved' ? 'saved' : 'matches';
  return json(200, await list(ctx.services(), ctx.userId!, view, { rest: b.rest === true }));
}

async function score(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  const str = (k: string, max: number) => {
    const v = b[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') throw badRequest(`${k} must be text`);
    if (v.length > max) throw badRequest(`${k} is too long`);
    return v;
  };
  const req = {
    url: str('url', 2000),
    text: str('text', 40_000),
    title: str('title', 300),
    company: str('company', 300),
  };
  if (!req.url?.trim() && !req.text?.trim()) throw badRequest('url or text is required');
  return json(200, await scoreOne(ctx.services(), deps(ctx), ctx.userId!, req));
}

async function actRoute(ctx: Ctx): Promise<Response> {
  return json(200, await act(ctx.services(), ctx.userId!, await body(ctx)));
}

export const rolesRoutes: Record<string, Route> = {
  '/roles/profile': { method: 'POST', auth: true, run: gated(profile) },
  '/roles/search': { method: 'POST', auth: true, run: gated(search) },
  '/roles/more': { method: 'POST', auth: true, run: gated(moreRoute) },
  '/roles/list': { method: 'POST', auth: true, run: gated(listRoute) },
  '/roles/score': { method: 'POST', auth: true, run: gated(score) },
  '/roles/act': { method: 'POST', auth: true, run: gated(actRoute) },
};

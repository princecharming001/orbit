/**
 * What a Discover card says about someone, beyond their title and company (the logo already says where they work):
 * what you have in common, what makes them stand out, what they actually do, and why now is a good time. Every point
 * comes from what Orbit holds (their work and school history, facts from email and notes, a research brief, who they
 * know that you know, your own resume) and is a short sentence. The strongest come first.
 */
import type {
  Affiliation,
  Dossier,
  Edge,
  Person,
  PersonFact,
  Recommendation,
  ResumeFacet,
  User,
} from '@orbit/core';
import { normalizeCompany } from '@orbit/core';
import { db } from '../db/schema';
import { dossierView } from './research';

export type PointKind = 'common' | 'standout' | 'does' | 'timing';

export interface PersonPoint {
  kind: PointKind;
  text: string;
}

export const POINT_LABELS: Record<PointKind, string> = {
  common: 'In common',
  standout: 'Stands out',
  does: 'Does',
  timing: 'Why now',
};

export interface PointContext {
  user: Pick<User, 'id' | 'school'>;
  /** the student's own experience and interests, from their resume */
  mine: ResumeFacet[];
  people: Map<string, Person>;
  affiliations: Affiliation[];
  facts: PersonFact[];
  edges: Edge[];
  dossier?: Dossier;
  now: Date;
}

const YEAR = 365.25 * 86_400_000;
/** Ties that mean two people actually know each other. */
const REAL_TIES = new Set<Edge['type']>([
  'email_exchange',
  'email_cc',
  'email_cothread',
  'meeting_coattendee',
  'introduced_by',
  'linkedin_mutual',
  'co_tenure',
]);
const year = (iso?: string) => (iso ? new Date(iso).getFullYear() : undefined);
const sentence = (s: string) => {
  const t = s.trim().replace(/\s+/g, ' ');
  return /[.!?]$/.test(t) ? t.slice(0, -1) : t;
};
const listNames = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

/** The points for one person, strongest first, without repeats. */
export function personPoints(person: Person, rec: Recommendation, ctx: PointContext): PersonPoint[] {
  const out: PersonPoint[] = [];
  const add = (kind: PointKind, text: string | undefined) => {
    if (!text) return;
    const t = sentence(text);
    if (t.length < 4 || out.some((p) => p.text.toLowerCase() === t.toLowerCase())) return;
    out.push({ kind, text: t });
  };
  const mineAff = ctx.affiliations.filter((a) => a.personId === person.id);
  const jobs = mineAff
    .filter((a) => a.kind === 'employment')
    .sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''));
  const current = jobs.find((a) => a.isCurrent) ?? jobs[0];
  const past = jobs.filter((a) => a !== current && !a.isCurrent);
  const view =
    ctx.dossier && (ctx.dossier.status === 'ready' || ctx.dossier.status === 'partial')
      ? dossierView(ctx.dossier)
      : undefined;
  const facts = ctx.facts.filter((f) => f.personId === person.id);

  // ---- in common ----
  const myOrgs = new Map(
    ctx.mine
      .filter((f) => f.kind === 'experience' && f.organizationName && !f.excluded)
      .map((f) => [normalizeCompany(f.organizationName), f.organizationName!]),
  );
  const sharedOrg = jobs.map((j) => myOrgs.get(normalizeCompany(j.nameRaw))).find(Boolean);
  if (sharedOrg) add('common', `You both worked at ${sharedOrg}`);
  // people the student knows who know them: the warmest reason to write
  const known = ctx.edges
    // a real tie (they wrote, met, were introduced, are connected or overlapped at work), not just the same employer
    .filter((e) => (e.personAId === person.id || e.personBId === person.id) && REAL_TIES.has(e.type))
    .map((e) => ctx.people.get(e.personAId === person.id ? e.personBId : e.personAId))
    .filter((p): p is Person => !!p && p.strength >= 0.3 && !p.hiddenAt)
    .sort((a, b) => b.strength - a.strength);
  const knownNames = [...new Set(known.map((p) => p.firstName))];
  if (knownNames.length)
    add(
      'common',
      knownNames.length === 1
        ? `Knows ${knownNames[0]}, whom you know well`
        : `Knows ${knownNames[0]} and ${knownNames.length - 1} other${knownNames.length > 2 ? 's' : ''} you know`,
    );
  for (const c of view?.inCommon ?? []) add('common', c.text);
  const myInterests = ctx.mine.filter((f) => f.kind === 'interest' && !f.excluded);
  for (const f of facts.filter((x) => x.type === 'personal')) {
    if (myInterests.some((i) => f.text.toLowerCase().includes(i.text.toLowerCase().slice(0, 12))))
      add('common', f.text);
  }

  // ---- stands out ----
  for (const h of view?.highlights.slice(0, 2) ?? []) {
    const verb =
      h.kind === 'talk'
        ? 'Gave a talk'
        : h.kind === 'podcast'
          ? 'Was on a podcast'
          : h.kind === 'paper'
            ? 'Published'
            : h.kind === 'project'
              ? 'Built'
              : 'Wrote';
    add('standout', `${verb}: “${h.title}”`);
  }
  if (past.length) {
    const names = [...new Set(past.map((a) => a.nameRaw))].slice(0, 2);
    add('standout', `Previously at ${listNames(names)}`);
  }
  for (const f of facts.filter((x) => x.type === 'background' || x.type === 'hook').slice(0, 2))
    add('standout', f.text);
  if (view?.topics.length)
    add('standout', `Works on ${listNames(view.topics.slice(0, 3).map((t) => t.toLowerCase()))}`);

  // ---- does ----
  const title = (person.currentTitle ?? '').toLowerCase();
  const org = (person.currentOrganizationRaw ?? '').toLowerCase();
  if (
    person.headline &&
    !(
      person.headline.toLowerCase().includes(title) &&
      person.headline.toLowerCase().includes(org) &&
      person.headline.length < title.length + org.length + 8
    )
  )
    add('does', person.headline);
  else if (view?.who) add('does', view.who.split(/(?<=\.)\s/)[0]);
  const role = facts.find((f) => f.type === 'role_detail');
  if (role) add('does', role.text);
  const started = current?.startDate ? new Date(current.startDate) : undefined;
  if (started && !Number.isNaN(started.getTime())) {
    const yrs = (ctx.now.getTime() - started.getTime()) / YEAR;
    if (yrs >= 1.5) add('does', `${Math.floor(yrs)} years in the role, since ${year(current!.startDate)}`);
  }

  // ---- why now ----
  if (started && (ctx.now.getTime() - started.getTime()) / YEAR < 1)
    add('timing', `Joined ${current?.nameRaw ?? 'their team'} in the last year`);
  for (const r of rec.reasons) {
    // the school is the logo by their name, and warm or path ties say themselves on the card
    if (r.code === 'function_match') add('timing', r.text);
    if (r.code === 'target_company') add('timing', 'Works at a company on your target list');
    // the reason's own words say what overlaps; a line that would fit anyone is left out
    if (r.code === 'resume_overlap' && r.text && !/^their work overlaps/i.test(r.text)) add('common', r.text);
  }

  const order: PointKind[] = ['common', 'standout', 'does', 'timing'];
  // the best of each kind first, then the rest in the same order
  const firsts = order.map((k) => out.find((p) => p.kind === k)).filter((p): p is PersonPoint => !!p);
  return [...firsts, ...out.filter((p) => !firsts.includes(p))].slice(0, 7);
}

/** Everything the points need for a set of people, read once for the whole page. */
export async function loadPointContext(
  user: Pick<User, 'id' | 'school'>,
  personIds: string[],
  now = new Date(),
): Promise<Omit<PointContext, 'dossier'> & { dossiers: Map<string, Dossier> }> {
  const ids = new Set(personIds);
  const [people, affiliations, facts, edges, dossiers, resumes] = await Promise.all([
    db.people.where('userId').equals(user.id).toArray(),
    db.affiliations
      .where('personId')
      .anyOf([...ids])
      .toArray(),
    db.facts
      .where('personId')
      .anyOf([...ids])
      .toArray(),
    db.edges.where('userId').equals(user.id).toArray(),
    db.dossiers
      .where('personId')
      .anyOf([...ids])
      .toArray(),
    db.resumes.where('userId').equals(user.id).toArray(),
  ]);
  const resume =
    resumes.find((r) => r.isCurrent) ?? resumes.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const mine = resume ? await db.resumeFacets.where('resumeId').equals(resume.id).toArray() : [];
  return {
    user,
    mine,
    people: new Map(people.map((p) => [p.id, p])),
    affiliations,
    facts: facts.filter((f) => !f.deletedAt),
    edges: edges.filter((e) => ids.has(e.personAId) || ids.has(e.personBId)),
    dossiers: new Map(dossiers.map((d) => [d.personId, d])),
    now,
  };
}

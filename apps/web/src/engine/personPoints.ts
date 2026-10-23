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
import { normalizeCompany, tieBand, titleChangedMeaningfully } from '@orbit/core';
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
  /**
   * Pairs of people on one small email thread (three people or fewer, the student included), as "idA|idB" with
   * idA < idB: being copied together on a big thread does not mean two people know each other
   */
  smallThreads?: Set<string>;
  dossier?: Dossier;
  now: Date;
}

const YEAR = 365.25 * 86_400_000;
const EMAIL_TIES = new Set<Edge['type']>(['email_exchange', 'email_cc', 'email_cothread']);

/**
 * A tie that shows two people really know each other: an introduction, overlapping years at one employer (dates on
 * record), or a small email thread with both on it. Not the same employer with unknown dates, a big thread, or a
 * LinkedIn connection.
 */
function realTie(e: Edge, ctx: Pick<PointContext, 'smallThreads'>): boolean {
  if (e.type === 'introduced_by') return true;
  if (e.type === 'co_tenure')
    return (
      !e.evidence.datesUnknown && typeof e.evidence.overlapMonths === 'number' && e.evidence.overlapMonths > 0
    );
  if (EMAIL_TIES.has(e.type)) {
    const [a, b] = e.personAId < e.personBId ? [e.personAId, e.personBId] : [e.personBId, e.personAId];
    return !!ctx.smallThreads?.has(`${a}|${b}`);
  }
  return false;
}

/** Warm or closer to the student: "whom you know well" is only said of them. */
function knownWell(p: Person): boolean {
  const band = p.tieBand ?? tieBand(p.tieScore ?? p.strength * 100);
  return band === 'warm' || band === 'strong' || band === 'close';
}
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
  // earlier employers, not an earlier title at the same one
  const past = jobs.filter(
    (a) =>
      a !== current && !a.isCurrent && normalizeCompany(a.nameRaw) !== normalizeCompany(current?.nameRaw),
  );
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
    // a real tie (introduced, overlapping years at one employer, a small thread together), and someone the student
    // knows well (Warm or closer), not just the same employer or a big thread
    .filter((e) => (e.personAId === person.id || e.personBId === person.id) && realTie(e, ctx))
    .map((e) => ctx.people.get(e.personAId === person.id ? e.personBId : e.personAId))
    .filter((p): p is Person => !!p && !p.hiddenAt && knownWell(p))
    .sort((a, b) => b.strength - a.strength);
  const knownNames = [...new Set(known.map((p) => p.firstName))];
  if (knownNames.length)
    add(
      'common',
      knownNames.length === 1
        ? `Knows ${knownNames[0]}, whom you know well`
        : `Knows ${knownNames[0]} and ${knownNames.length - 1} other${knownNames.length > 2 ? 's' : ''} you know well`,
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
  // a LinkedIn re-import dates a role by when Orbit saw it, not when it began: no "since" or "joined" from that date
  const observed = current?.source === 'linkedin_csv';
  if (started && !observed && !Number.isNaN(started.getTime())) {
    const yrs = (ctx.now.getTime() - started.getTime()) / YEAR;
    if (yrs >= 1.5) add('does', `${Math.floor(yrs)} years in the role, since ${year(current!.startDate)}`);
  }

  // ---- why now ----
  if (started && (ctx.now.getTime() - started.getTime()) / YEAR < 1) {
    if (!observed) add('timing', `Joined ${current?.nameRaw ?? 'their team'} in the last year`);
    else {
      // what a re-import saw: a new company, or a title that changed in earnest
      const replaced = jobs.find(
        (a) => !a.isCurrent && a.endDate?.slice(0, 10) === current!.startDate!.slice(0, 10),
      );
      if (replaced && normalizeCompany(replaced.nameRaw) !== normalizeCompany(current!.nameRaw))
        add('timing', `Moved from ${replaced.nameRaw} to ${current!.nameRaw}`);
      else if (replaced && current!.title && titleChangedMeaningfully(replaced.title, current!.title))
        add('timing', `New role: ${current!.title}`);
    }
  }
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
  const [people, affiliations, facts, edges, dossiers, resumes, threads] = await Promise.all([
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
    db.threads.where('userId').equals(user.id).toArray(),
  ]);
  // small threads with one of these people on them: who was on a thread of three or fewer with whom
  const smallThreads = new Set<string>();
  for (const t of threads) {
    const on = [...new Set(t.participantPersonIds)];
    // three people at most, the student included: the two of them and the student (whose address is among them)
    if (on.length !== 2 || t.participantEmails.length > 3 || !on.some((id) => ids.has(id))) continue;
    for (const a of on) for (const b of on) if (a < b) smallThreads.add(`${a}|${b}`);
  }
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
    smallThreads,
    dossiers: new Map(dossiers.map((d) => [d.personId, d])),
    now,
  };
}

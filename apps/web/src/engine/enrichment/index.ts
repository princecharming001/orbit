/**
 * The enrichment waterfall (plan 17 E): one pipeline that fills in the people the student knows, cheapest and most
 * certain first, and stops for a person as soon as nothing more is needed for them.
 *
 *   0. What Orbit already has (signatures, calendar, notes, imports): the hints a profile has to agree with, and the
 *      provenance of the fields already filled.
 *   1. Gravatar by email hash (free): a photo for someone with none and no LinkedIn.
 *   2. Their LinkedIn profile, for people with a LinkedIn id or public name: current position (the truth, rule 1),
 *      company id and logo (rule 2), experience and education (alumni evidence), place, photo, and for 1st-degree
 *      connections the address and number that join their mail and texts exactly.
 *   3. A LinkedIn search for every Gmail or iMessage person without a LinkedIn profile, photo or not (rule 3), joined
 *      only on a confident match (match.ts); the match's profile is then read as in step 2.
 *   4. The web (Exa), when Orbit's server has a key: bios and personal pages, kept only when surely theirs.
 *   5. Paid people-data APIs (Apollo, People Data Labs): only with the student's own keys; not wired yet.
 *
 * Who first: people in the pipeline, then Discover's picks, then close ties, then everyone; the queue is kept in
 * Dexie so a closed tab picks up where it stopped. Every kind of call has a daily budget (store.ts), LinkedIn calls
 * are spaced out at random, and when LinkedIn holds sections back or says to slow down, LinkedIn calls stop for the
 * day. Every field it fills records its source and confidence, and nothing overwrites what the student set.
 *
 * It runs in the background after a LinkedIn sync and when the app opens, and for one person when the student opens
 * their page. The demo student runs it on the mock connector. Account mode (Orbit's server) is left to the server.
 */
import type { Person, PersonField, User } from '@orbit/core';
import { hasRealName, isKnownContact, linkedInSlug, newId, roleFromHeadline } from '@orbit/core';
import { db } from '../../db/schema';
import { automationOverride } from '../../integrations/connectorOutcome';
import { usesMockConnectors } from '../../integrations/connectorsMock';
import {
  type EnrichFailure,
  FULL_SECTIONS,
  type LinkedInProfile,
  PREVIEW_SECTIONS,
  webLookup,
} from '../../integrations/enrichmentProxy';
import { isServerUser } from '../../integrations/orbitApi';
import type { LinkedInFound } from '../../integrations/unipile';
import { endActivity, progressActivity, startActivity } from '../activity';
import { mayOverwrite, mergePeople } from '../people';
import { freshPhoto, isLinkedInPhoto, linkedInImageExpired } from '../photos';
import { type SchoolAlias, schoolAlias } from './education';
import { findGravatar, type ImageProbe, probeImage } from './gravatar';
import { refreshLogos } from './logos';
import {
  confidenceOf,
  type Evidence,
  evidenceFromHit,
  evidenceFromProfile,
  type Hints,
  hintsFor,
  pickConfident,
  sameName,
} from './match';
import { applyLinkedInProfile } from './profile';
import { keepWebResults } from './providers';
import { cachedProviders, type LinkedInSource, linkedInSourceFor, serverProviders } from './sources';
import {
  allRecords,
  type Budget,
  type BudgetKind,
  budgetLeft,
  DAILY,
  deleteRecord,
  type EnrichmentRecord,
  linkedInPaused,
  newRecord,
  noteField,
  pauseLinkedIn,
  readBudget,
  readLastRun,
  readQueue,
  readRecord,
  spend,
  writeLastRun,
  writeQueue,
  writeRecord,
} from './store';

export { type EducationEvidence, studiedAt, studiedAtFrom } from './education';
export type { EnrichmentRecord } from './store';
export { readRecord as enrichmentRecord } from './store';

const DAY = 86_400_000;
/** A profile is read again after this long: positions change. */
export const PROFILE_EVERY_MS = 45 * DAY;
/** Someone LinkedIn search did not find is looked for again after this long. */
export const SEARCH_EVERY_MS = 30 * DAY;
export const GRAVATAR_EVERY_MS = 90 * DAY;
export const WEB_EVERY_MS = 90 * DAY;
/** The queue is rebuilt after this long, so new people and new priorities get in. */
const QUEUE_TTL_MS = 6 * 3_600_000;

type Need = 'profile' | 'photo_refresh' | 'linkedin' | 'photo' | 'bio';

export interface RunOptions {
  now?: Date;
  signal?: AbortSignal;
  /** just these people (the one whose page the student opened), ahead of the queue */
  only?: string[];
  /** at most this many people */
  limit?: number;
  /** 'view' spends the allowance kept for people the student opens */
  reason?: 'background' | 'view';
  /** the random wait between LinkedIn calls, [min, max] ms; [0, 0] in tests */
  pauseMs?: [number, number];
  /** how a Gravatar is checked (an <img> load in the browser) */
  probe?: ImageProbe;
  limits?: Record<BudgetKind, number>;
}

export interface RunResult {
  looked: number;
  profiles: number;
  searched: number;
  matched: number;
  gravatars: number;
  logos: number;
  web: number;
  /** why LinkedIn calls stopped early, if they did */
  stopped?: string;
}

const EMPTY: RunResult = { looked: 0, profiles: 0, searched: 0, matched: 0, gravatars: 0, logos: 0, web: 0 };

interface Ctx {
  user: User;
  now: Date;
  linkedin?: LinkedInSource;
  linkedinStopped?: string;
  gravatarOn: boolean;
  webOn: boolean;
  probe: ImageProbe;
  alias: SchoolAlias;
  schoolByDomain: (domain: string) => string | undefined;
  tiers: Map<string, number>;
  /** people with a chat (in any stage) */
  chats: Set<string>;
  reason: 'background' | 'view';
  limits: Record<BudgetKind, number>;
  pause: () => Promise<void>;
  out: RunResult;
}

const hasLinkedIn = (p: Pick<Person, 'linkedinMemberId' | 'linkedinSlug' | 'linkedinUrl'>) =>
  !!(p.linkedinMemberId || p.linkedinSlug || p.linkedinUrl);

const age = (iso: string | undefined, now: Date) =>
  iso ? now.getTime() - Date.parse(iso) : Number.POSITIVE_INFINITY;

/** Someone Orbit knows from mail or texts, with a real name: worth one LinkedIn search (rule 3). */
function searchable(p: Person, hasChat: boolean): boolean {
  if (!hasRealName(p) || p.hiddenAt || !p.isHuman) return false;
  return isKnownContact(p, { hasChat }) || p.sources.includes('imessage') || !!p.phones?.length;
}

function needsOf(ctx: Ctx, p: Person, rec: EnrichmentRecord, hasChat: boolean): Set<Need> {
  const n = new Set<Need>();
  const li = !!ctx.linkedin && !ctx.linkedinStopped;
  if (hasLinkedIn(p)) {
    // an opened page shows their whole work history: one read with the full sections if only previews were read
    const wantsFull = ctx.reason === 'view' && !rec.fullAt;
    if (li && (age(rec.profileAt, ctx.now) > PROFILE_EVERY_MS || wantsFull)) n.add('profile');
    else if (li && isLinkedInPhoto(p.photoUrl) && linkedInImageExpired(p.photoUrl, ctx.now))
      n.add('photo_refresh');
  } else {
    if (li && searchable(p, hasChat) && age(rec.searchedAt, ctx.now) > SEARCH_EVERY_MS) n.add('linkedin');
    if (
      ctx.gravatarOn &&
      !p.photoUrl &&
      (p.primaryEmail || p.emails.length) &&
      age(rec.gravatarAt, ctx.now) > GRAVATAR_EVERY_MS
    )
      n.add('photo');
  }
  if (ctx.webOn && (ctx.tiers.get(p.id) ?? 3) <= 1 && !rec.about && age(rec.webAt, ctx.now) > WEB_EVERY_MS)
    n.add('bio');
  return n;
}

/** Who matters now: 0 in the pipeline, 1 a Discover pick, 2 a close tie, 3 everyone else. */
async function priorityTiers(userId: string): Promise<{ tiers: Map<string, number>; chats: Set<string> }> {
  const tiers = new Map<string, number>();
  const chats = new Set<string>();
  const set = (id: string, t: number) => tiers.set(id, Math.min(t, tiers.get(id) ?? 3));
  for (const c of await db.chats.where('userId').equals(userId).toArray()) {
    chats.add(c.personId);
    if (c.stage !== 'archived' && c.stage !== 'declined') set(c.personId, 0);
  }
  for (const r of await db.recommendations.where('userId').equals(userId).toArray())
    if (r.status === 'new' || r.status === 'saved') set(r.personId, 1);
  for (const p of await db.people.where('userId').equals(userId).toArray())
    if ((p.tieScore ?? 0) >= 50 || p.strength >= 0.5) set(p.id, 2);
  return { tiers, chats };
}

// ---------- the steps ----------

type StepResult = { personId?: string; stop?: string };

/** A LinkedIn answer that means "no more today": pause LinkedIn calls until tomorrow. */
async function stopIfLimited(ctx: Ctx, reason: EnrichFailure, message: string): Promise<string | undefined> {
  if (reason !== 'throttled' && reason !== 'limit') {
    if (reason === 'unconfigured') ctx.linkedin = undefined;
    return undefined;
  }
  await pauseLinkedIn(ctx.user.id, ctx.now, message);
  ctx.linkedinStopped = message;
  return message;
}

/** The profile allowance this run spends: the one kept for opened pages first, when that is why it runs. */
async function profileKind(ctx: Ctx): Promise<BudgetKind | undefined> {
  const b = await readBudget(ctx.user.id, ctx.now);
  if (ctx.reason === 'view' && budgetLeft(b, 'view', ctx.limits) > 0) return 'view';
  return budgetLeft(b, 'profile', ctx.limits) > 0 ? 'profile' : undefined;
}

async function readProfile(
  ctx: Ctx,
  identifier: string,
  sections: string[],
): Promise<{ profile?: LinkedInProfile; stop?: string; notFound?: boolean }> {
  const kind = await profileKind(ctx);
  if (!kind || !ctx.linkedin) return {};
  await ctx.pause();
  await spend(ctx.user.id, kind, ctx.now);
  const r = await ctx.linkedin.profile(identifier, sections);
  if (!r.ok)
    return { stop: await stopIfLimited(ctx, r.reason, r.message), notFound: r.reason === 'not_found' };
  ctx.out.profiles++;
  return { profile: r.value };
}

/**
 * Full sections for people who matter now and for anyone whose page the student opened (About shows their whole work
 * history); the lighter previews (enough for the current role) for everyone else.
 */
const sectionsFor = (ctx: Ctx, personId: string) =>
  ctx.reason === 'view' || (ctx.tiers.get(personId) ?? 3) <= 2 ? FULL_SECTIONS : PREVIEW_SECTIONS;

/** Step 2: their own LinkedIn profile, by their LinkedIn id. */
async function profileStep(
  ctx: Ctx,
  p: Person,
  rec: EnrichmentRecord,
  needs: Set<Need>,
): Promise<StepResult> {
  const identifier = p.linkedinMemberId ?? p.linkedinSlug ?? linkedInSlug(p.linkedinUrl);
  if (!identifier) return {};
  // only the photo has expired: the plain profile (no sections) carries a fresh link
  const sections = needs.has('profile') ? sectionsFor(ctx, p.id) : [];
  const r = await readProfile(ctx, identifier, sections);
  if (r.notFound) rec.profileAt = ctx.now.toISOString();
  if (!r.profile) return { stop: r.stop };
  const applied = await applyLinkedInProfile(ctx.user, p.id, r.profile, {
    now: ctx.now,
    confidence: 1,
    rec,
    alias: ctx.alias,
  });
  if (sections.length) settleThrottle(ctx, rec, r.profile);
  if (sections === FULL_SECTIONS && !r.profile.throttled.some((t) => t.startsWith('experience')))
    rec.fullAt = ctx.now.toISOString();
  const stop = r.profile.throttled.length
    ? await stopIfLimited(
        ctx,
        'throttled',
        'LinkedIn held back parts of profiles. Orbit carries on tomorrow.',
      )
    : undefined;
  return { personId: applied?.personId, stop };
}

/** A read whose experience LinkedIn held back is not a read: it is tried again later. */
function settleThrottle(ctx: Ctx, rec: EnrichmentRecord, profile: LinkedInProfile) {
  if (profile.throttled.some((t) => t.startsWith('experience'))) rec.throttledAt = ctx.now.toISOString();
  else rec.profileAt = ctx.now.toISOString();
}

/** Step 1: a Gravatar for someone with no photo. */
async function gravatarStep(ctx: Ctx, p: Person, rec: EnrichmentRecord): Promise<StepResult> {
  await spend(ctx.user.id, 'gravatar', ctx.now);
  const url = await findGravatar([p.primaryEmailAsWritten, p.primaryEmail, ...p.emails], ctx.probe);
  rec.gravatarAt = ctx.now.toISOString();
  if (!url) return {};
  const fresh = await db.people.get(p.id);
  if (fresh && !fresh.photoUrl) {
    await db.people.update(p.id, { photoUrl: url, updatedAt: ctx.now.toISOString() });
    noteField(rec, 'photoUrl', { source: 'gravatar', confidence: 0.9 }, ctx.now);
    ctx.out.gravatars++;
  }
  return {};
}

/** The company or school to narrow a name search with, as written. */
function qualifier(p: Person, hints: Hints): string | undefined {
  return p.currentOrganizationRaw?.trim() || hints.companies[0] || p.school?.trim() || undefined;
}

/** Step 3: find a Gmail or iMessage person on LinkedIn; join only a confident match. */
async function searchStep(ctx: Ctx, p: Person, rec: EnrichmentRecord, hints: Hints): Promise<StepResult> {
  if (!ctx.linkedin) return {};
  const name = `${p.firstName} ${p.lastName}`.trim();
  const search = async (keywords: string) => {
    await ctx.pause();
    await spend(ctx.user.id, 'search', ctx.now);
    ctx.out.searched++;
    return ctx.linkedin!.search(keywords);
  };
  const q = qualifier(p, hints);
  let r = await search(q ? `${name} ${q}` : name);
  if (!r.ok) return { stop: await stopIfLimited(ctx, r.reason, r.message) };
  let hits = r.value.filter((h) => h.memberId && sameName(p, h.name));
  // narrowed by a company they may have left: once more by name alone
  const b = await readBudget(ctx.user.id, ctx.now);
  if (!hits.length && q && budgetLeft(b, 'search', ctx.limits) > 0 && !linkedInPaused(b, ctx.now)) {
    r = await search(name);
    if (!r.ok) return { stop: await stopIfLimited(ctx, r.reason, r.message) };
    hits = r.value.filter((h) => h.memberId && sameName(p, h.name));
  }
  rec.searchedAt = ctx.now.toISOString();
  if (!hits.length) {
    rec.searchResult = 'none';
    return {};
  }
  // their headline and place first; when they say nothing, the full profiles of the ones it could be
  let pick = pickConfident(hits.slice(0, 6).map((h) => ({ item: h, evidence: evidenceFromHit(hints, h) })));
  let profile: LinkedInProfile | undefined;
  if (pick === 'ambiguous') {
    rec.searchResult = 'ambiguous';
    return {};
  }
  if (!pick) {
    const verify = hits.filter((h) => h.distance === 1).slice(0, 2);
    if (!verify.length && hits.length === 1) verify.push(hits[0]!);
    const checked: { item: LinkedInFound; evidence: Evidence[]; profile: LinkedInProfile }[] = [];
    for (const h of verify) {
      const pr = await readProfile(ctx, h.memberId, FULL_SECTIONS);
      if (pr.stop) return { stop: pr.stop };
      if (pr.profile)
        checked.push({
          item: h,
          evidence: evidenceFromProfile(hints, pr.profile, ctx.alias),
          profile: pr.profile,
        });
    }
    const found = pickConfident(checked);
    if (!found || found === 'ambiguous') {
      rec.searchResult = found === 'ambiguous' ? 'ambiguous' : 'none';
      return {};
    }
    pick = found;
    profile = checked.find((c) => c.item === found.item)?.profile;
  }
  const hit = pick.item;
  if (!profile) {
    const pr = await readProfile(ctx, hit.memberId, sectionsFor(ctx, p.id));
    profile = pr.profile;
  }
  const evidence = profile
    ? [...pick.evidence, ...evidenceFromProfile(hints, profile, ctx.alias)]
    : pick.evidence;
  const confidence = confidenceOf(evidence);
  return joinMatch(ctx, p, rec, hit, profile, evidence, confidence);
}

/** Join a confident match: onto this person, or with the Orbit record that already holds that LinkedIn profile. */
async function joinMatch(
  ctx: Ctx,
  p: Person,
  rec: EnrichmentRecord,
  hit: LinkedInFound,
  profile: LinkedInProfile | undefined,
  evidence: Evidence[],
  confidence: number,
): Promise<StepResult> {
  const slug = profile?.publicIdentifier ?? linkedInSlug(hit.profileUrl);
  const people = await db.people.where('userId').equals(ctx.user.id).toArray();
  const holder = people.find(
    (x) =>
      x.id !== p.id &&
      ((profile?.providerId && x.linkedinMemberId === profile.providerId) ||
        x.linkedinMemberId === hit.memberId ||
        (!!slug && x.linkedinSlug === slug)),
  );
  let target = p;
  if (holder) {
    const exact = evidence.some((e) => e.kind === 'email' || e.kind === 'phone');
    const decided = await db.merges
      .where('userId')
      .equals(ctx.user.id)
      .filter(
        (m) =>
          (m.personAId === p.id && m.personBId === holder.id) ||
          (m.personAId === holder.id && m.personBId === p.id),
      )
      .first();
    if (decided?.status === 'rejected') {
      rec.searchResult = 'none';
      return {};
    }
    if (!exact) {
      // the same name and company is a strong hint, not proof: the student decides (plan 17 A)
      if (!decided)
        await db.merges.add({
          id: newId('mrg'),
          userId: ctx.user.id,
          personAId: holder.createdAt <= p.createdAt ? holder.id : p.id,
          personBId: holder.createdAt <= p.createdAt ? p.id : holder.id,
          score: confidence,
          features: { linkedin_search: confidence },
          status: 'pending',
          createdAt: ctx.now.toISOString(),
        });
      rec.searchResult = 'suggested';
      return {};
    }
    const [survivor, gone] = holder.createdAt <= p.createdAt ? [holder, p] : [p, holder];
    await mergePeople(ctx.user.id, survivor.id, gone.id);
    await deleteRecord(gone.id);
    target = (await db.people.get(survivor.id)) ?? survivor;
    rec.personId = target.id;
  }
  const at = ctx.now.toISOString();
  const patch: Partial<Person> = {};
  if (!target.linkedinMemberId) patch.linkedinMemberId = profile?.providerId ?? hit.memberId;
  if (slug && !target.linkedinSlug) {
    patch.linkedinSlug = slug;
    if (!target.linkedinUrl) patch.linkedinUrl = `https://www.linkedin.com/in/${slug}`;
  }
  if (!profile) {
    // no profile read today: what the search result itself says, without taking over the position
    const photo = freshPhoto(target.photoUrl, hit.pictureUrl);
    if (photo !== target.photoUrl) patch.photoUrl = photo;
    const fields: Partial<Record<PersonField, string>> = {};
    if (hit.headline && mayOverwrite(target, 'headline', 'linkedin_profile', target.headline)) {
      patch.headline = hit.headline;
      fields.headline = 'linkedin_profile';
    }
    const { title, org } = roleFromHeadline(hit.headline);
    if (title && org && !target.currentTitle) patch.currentTitle = title;
    if (hit.location && !target.location) patch.location = hit.location;
    if (fields.headline)
      patch.fieldSources = { ...(target.fieldSources ?? {}), headline: 'linkedin_profile' };
  }
  if (!target.sources.includes('enrichment')) patch.sources = [...target.sources, 'enrichment'];
  if (Object.keys(patch).length) await db.people.update(target.id, { ...patch, updatedAt: at });
  rec.searchedAt = at;
  rec.searchResult = 'matched';
  noteField(
    rec,
    'linkedin',
    { source: 'linkedin_search', confidence, value: evidence.map((e) => `${e.kind}:${e.detail}`).join(', ') },
    ctx.now,
    true,
  );
  ctx.out.matched++;
  if (profile) {
    await applyLinkedInProfile(ctx.user, target.id, profile, {
      now: ctx.now,
      confidence,
      rec,
      alias: ctx.alias,
    });
    settleThrottle(ctx, rec, profile);
  }
  return { personId: rec.personId };
}

/** Step 4: the web, for people who matter now, when Orbit's server can search it. */
async function webStep(ctx: Ctx, p: Person, rec: EnrichmentRecord, hints: Hints): Promise<StepResult> {
  await spend(ctx.user.id, 'web', ctx.now);
  const r = await webLookup({
    name: `${p.firstName} ${p.lastName}`,
    company: p.currentOrganizationRaw,
    school: hints.schools[0],
  });
  if (!r.ok) {
    if (r.reason === 'unconfigured' || r.reason === 'limit') ctx.webOn = false;
    return {};
  }
  rec.webAt = ctx.now.toISOString();
  const kept = keepWebResults(p, hints, r.value);
  if (kept.length) {
    rec.web = kept;
    noteField(rec, 'web', { source: 'exa', confidence: Math.max(...kept.map((k) => k.confidence)) }, ctx.now);
    ctx.out.web++;
  }
  return {};
}

const LINKEDIN_STEPS = new Set(['linkedin_profile', 'linkedin_search']);

interface Step {
  name: string;
  wants: (n: Set<Need>) => boolean;
  budget: BudgetKind | 'profile_any';
  run: (ctx: Ctx, p: Person, rec: EnrichmentRecord, hints: Hints, needs: Set<Need>) => Promise<StepResult>;
}

/** The waterfall, cheapest and most certain first. Step 0 (what Orbit has) runs before it for every person. */
const STEPS: Step[] = [
  {
    name: 'gravatar',
    wants: (n) => n.has('photo'),
    budget: 'gravatar',
    run: (c, p, r) => gravatarStep(c, p, r),
  },
  {
    name: 'linkedin_profile',
    wants: (n) => n.has('profile') || n.has('photo_refresh'),
    budget: 'profile_any',
    run: (c, p, r, _h, n) => profileStep(c, p, r, n),
  },
  { name: 'linkedin_search', wants: (n) => n.has('linkedin'), budget: 'search', run: searchStep },
  { name: 'web', wants: (n) => n.has('bio'), budget: 'web', run: webStep },
  // step 5, paid people-data (Apollo, People Data Labs): only with the student's own keys; nothing is wired yet
];

/** Step 0: the provenance of what Orbit already had, from the source that wrote each field. */
function noteOrbitFields(rec: EnrichmentRecord, p: Person, now: Date) {
  const conf: Record<string, number> = {
    manual: 1,
    linkedin_profile: 1,
    enrichment: 0.8,
    linkedin_csv: 0.75,
    imessage: 0.7,
    tracker_import: 0.6,
    note: 0.5,
    gmail: 0.5,
    calendar: 0.4,
  };
  for (const f of ['currentTitle', 'currentOrganizationId', 'headline', 'location'] as const) {
    if (rec.fields[f] || !p[f]) continue;
    const src = p.fieldSources?.[f];
    noteField(
      rec,
      f,
      { source: 'orbit', confidence: src ? (conf[src] ?? 0.5) : 0.5, value: String(p[f]) },
      now,
    );
  }
}

async function canSpend(ctx: Ctx, step: Step): Promise<boolean> {
  const b = await readBudget(ctx.user.id, ctx.now);
  if (LINKEDIN_STEPS.has(step.name) && (linkedInPaused(b, ctx.now) || !ctx.linkedin || ctx.linkedinStopped))
    return false;
  if (step.budget === 'profile_any')
    return (
      budgetLeft(b, 'profile', ctx.limits) > 0 ||
      (ctx.reason === 'view' && budgetLeft(b, 'view', ctx.limits) > 0)
    );
  // a search also reads the match's profile
  return budgetLeft(b, step.budget, ctx.limits) > 0;
}

/** One person through the waterfall. Returns the id they ended up under (a merge keeps the older record). */
async function enrichOne(ctx: Ctx, personId: string, chats: Set<string>): Promise<string | undefined> {
  let p = await db.people.get(personId);
  if (!p || p.userId !== ctx.user.id || p.hiddenAt || !p.isHuman) return undefined;
  const rec = (await readRecord(p.id)) ?? newRecord(ctx.user.id, p.id);
  const affs = await db.affiliations.where('personId').equals(p.id).toArray();
  const hints = hintsFor(p, affs, { schoolByDomain: ctx.schoolByDomain });
  noteOrbitFields(rec, p, ctx.now);
  let needs = needsOf(ctx, p, rec, chats.has(p.id));
  if (needs.size) ctx.out.looked++;
  for (const step of STEPS) {
    if (!needs.size) break;
    if (!step.wants(needs) || !(await canSpend(ctx, step))) continue;
    const r = await step.run(ctx, p, rec, hints, needs);
    if (r.stop) ctx.out.stopped ??= r.stop;
    // merged into an older record: this record goes with them
    const id = r.personId ?? rec.personId;
    rec.personId = id;
    const next = await db.people.get(id);
    if (!next) break;
    p = next;
    needs = needsOf(ctx, p, rec, chats.has(p.id));
  }
  await writeRecord(rec);
  return p.id;
}

/** The people to look at, most important first, kept in Dexie between runs. */
async function queueFor(ctx: Ctx, chats: Set<string>): Promise<string[]> {
  const q = await readQueue(ctx.user.id);
  if (q?.ids.length && age(q.builtAt, ctx.now) < QUEUE_TTL_MS) return q.ids;
  const [people, recs] = await Promise.all([
    db.people.where('userId').equals(ctx.user.id).toArray(),
    allRecords(ctx.user.id),
  ]);
  const ids = people
    .filter((p) => !p.hiddenAt && p.isHuman)
    .filter((p) => needsOf(ctx, p, recs.get(p.id) ?? newRecord(ctx.user.id, p.id), chats.has(p.id)).size > 0)
    .sort(
      (a, b) =>
        (ctx.tiers.get(a.id) ?? 3) - (ctx.tiers.get(b.id) ?? 3) ||
        (b.tieScore ?? b.strength * 100) - (a.tieScore ?? a.strength * 100),
    )
    .map((p) => p.id);
  await writeQueue(ctx.user.id, { builtAt: ctx.now.toISOString(), ids });
  return ids;
}

const running = new Map<string, Promise<RunResult>>();
const urgent = new Map<string, string[]>();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function makeContext(user: User, opts: RunOptions): Promise<Ctx | undefined> {
  const now = opts.now ?? new Date();
  const linkedin = await linkedInSourceFor(user);
  const mock = usesMockConnectors(user.id);
  // free lookups that leave the browser: never for the demo or a browser under automation
  const realBrowser = !mock && automationOverride() === 'live';
  const providers = realBrowser ? await serverProviders(user, now).catch(() => undefined) : undefined;
  // nothing to look anything up with: done before loading the school list
  if (!linkedin && !opts.probe && !realBrowser) return undefined;
  const alias = await schoolAlias();
  const byDomain = await schoolsByDomain();
  const [min, max] =
    opts.pauseMs ?? (linkedin?.kind === 'live' && opts.reason !== 'view' ? [1500, 4000] : [0, 0]);
  const { tiers, chats } = await priorityTiers(user.id);
  return {
    user,
    now,
    linkedin,
    gravatarOn: !!opts.probe || realBrowser,
    webOn: !!providers?.exa,
    probe: opts.probe ?? probeImage,
    alias,
    schoolByDomain: byDomain,
    tiers,
    chats,
    reason: opts.reason ?? 'background',
    limits: opts.limits ?? DAILY,
    pause: async () => {
      if (max > 0) await sleep(min + Math.random() * (max - min));
    },
    out: { ...EMPTY },
  };
}

let domainMap: Promise<(d: string) => string | undefined> | undefined;
/** "berkeley.edu" -> "University of California, Berkeley", from the school list. */
function schoolsByDomain(): Promise<(d: string) => string | undefined> {
  domainMap ??= import('../../data/schools')
    .then((m) => m.loadSchools())
    .then((schools) => {
      const map = new Map(schools.map((s) => [s.domain.toLowerCase(), s.name]));
      return (d: string) => map.get(d.toLowerCase());
    })
    .catch(() => () => undefined);
  return domainMap;
}

/**
 * Run the waterfall over today's share of the queue (or just `only`). One run per student at a time: a page opened
 * while a run is going is looked at next.
 */
export async function runEnrichment(user: User, opts: RunOptions = {}): Promise<RunResult> {
  if (isServerUser(user.id)) return { ...EMPTY };
  const active = running.get(user.id);
  if (active) {
    if (opts.only?.length) urgent.set(user.id, [...(urgent.get(user.id) ?? []), ...opts.only]);
    return { ...EMPTY };
  }
  const job = runOnce(user, opts);
  running.set(user.id, job);
  try {
    return await job;
  } finally {
    running.delete(user.id);
    endActivity('enrich');
    endActivity('enrich-logos');
  }
}

async function runOnce(user: User, opts: RunOptions): Promise<RunResult> {
  const ctx = await makeContext(user, opts);
  if (!ctx || (!ctx.linkedin && !ctx.gravatarOn && !ctx.webOn)) return { ...EMPTY };
  const b = await readBudget(user.id, ctx.now);
  if (linkedInPaused(b, ctx.now)) ctx.linkedinStopped = b.pauseReason ?? 'LinkedIn asked Orbit to slow down.';
  const chats = ctx.chats;
  const queue = opts.only ? [...opts.only] : await queueFor(ctx, chats);
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  const touched: string[] = [];
  let done = 0;
  // the status line: a background run says how far it is through today's share; a look at one person stays quiet
  const total = Math.min(queue.length, limit);
  if (!opts.only && total > 0)
    startActivity('enrich', ctx.linkedin ? 'Reading LinkedIn profiles' : 'Filling in profiles', { total });
  while (done < limit) {
    if (opts.signal?.aborted) break;
    const id = urgent.get(user.id)?.shift() ?? queue.shift();
    if (!id) break;
    if (!opts.only)
      await writeQueue(user.id, {
        builtAt: (await readQueue(user.id))?.builtAt ?? ctx.now.toISOString(),
        ids: queue,
      });
    const landed = await enrichOne(ctx, id, chats).catch(() => undefined);
    if (landed) touched.push(landed);
    done++;
    if (!opts.only) progressActivity('enrich', Math.min(done, total));
    if (!opts.only && (await exhausted(ctx))) break;
  }
  // logos: the current companies of the people looked at, then everyone's, missing or expired ones fetched again
  if (ctx.linkedin && !ctx.linkedinStopped) {
    const left = budgetLeft(await readBudget(user.id, ctx.now), 'company', ctx.limits);
    if (left > 0) {
      const people = await db.people.bulkGet(touched);
      const all = opts.only ? [] : await db.people.where('userId').equals(user.id).toArray();
      const orgIds = [...people, ...all].map((p) => p?.currentOrganizationId).filter((x): x is string => !!x);
      endActivity('enrich');
      if (orgIds.length) startActivity('enrich-logos', 'Fetching company logos');
      ctx.out.logos = await refreshLogos(
        orgIds,
        async (identifier) => {
          const r = await ctx.linkedin!.company(identifier);
          if (!r.ok) await stopIfLimited(ctx, r.reason, r.message);
          return r.ok ? r : { ok: false as const };
        },
        {
          now: ctx.now,
          limit: left,
          onCall: async () => {
            await ctx.pause();
            await spend(user.id, 'company', ctx.now);
          },
        },
      );
    }
  }
  await writeLastRun(user.id, {
    at: ctx.now.toISOString(),
    looked: ctx.out.looked,
    profiles: ctx.out.profiles,
    matched: ctx.out.matched,
    stopped: ctx.out.stopped,
  });
  return ctx.out;
}

/** Nothing left to spend today on anything this run could do. */
async function exhausted(ctx: Ctx): Promise<boolean> {
  const b = await readBudget(ctx.user.id, ctx.now);
  const linkedin =
    !!ctx.linkedin &&
    !ctx.linkedinStopped &&
    !linkedInPaused(b, ctx.now) &&
    (budgetLeft(b, 'profile', ctx.limits) > 0 || budgetLeft(b, 'search', ctx.limits) > 0);
  const gravatar = ctx.gravatarOn && budgetLeft(b, 'gravatar', ctx.limits) > 0;
  const web = ctx.webOn && budgetLeft(b, 'web', ctx.limits) > 0;
  return !linkedin && !gravatar && !web;
}

/** The student opened someone's page: look at them now, if they are due and today's allowance has room. */
export function enrichOnView(user: User, personId: string): Promise<RunResult> {
  return runEnrichment(user, { only: [personId], reason: 'view' }).catch(() => ({ ...EMPTY }));
}

let autoRun = import.meta.env.MODE !== 'test';
/** Unit-test hook: background runs are off under vitest unless a test turns them on. */
export function setEnrichmentAutoRunForTests(on: boolean): void {
  autoRun = on;
}

/** Start a background run soon (after a LinkedIn sync, when the app opens). Quiet: failures are dropped. */
export function scheduleEnrichment(user: User, delayMs = 1500): void {
  if (!autoRun || isServerUser(user.id)) return;
  setTimeout(() => void runEnrichment(user).catch(() => undefined), delayMs);
}

export interface EnrichmentStatus {
  /** live LinkedIn is connected, so profiles can be read */
  linkedin: boolean;
  demo: boolean;
  /** people whose LinkedIn profile Orbit has read */
  profiles: number;
  /** Gmail or iMessage people Orbit found on LinkedIn */
  matched: number;
  /** people still waiting in the queue */
  waiting: number;
  lastRunAt?: string;
  pausedUntil?: string;
  pauseReason?: string;
  left: { profiles: number; searches: number };
  /** the web step: on, or not set up on Orbit's server */
  web: 'on' | 'not_set_up';
}

/** Where enrichment stands, for Settings. */
export async function enrichmentStatus(user: Pick<User, 'id'>, now = new Date()): Promise<EnrichmentStatus> {
  const [source, recs, budget, queue, last, providers] = await Promise.all([
    linkedInSourceFor(user),
    allRecords(user.id),
    readBudget(user.id, now),
    readQueue(user.id),
    readLastRun(user.id),
    cachedProviders(),
  ]);
  const paused = linkedInPaused(budget, now);
  return {
    linkedin: !!source,
    demo: usesMockConnectors(user.id),
    profiles: [...recs.values()].filter((r) => r.profileAt && r.fields.linkedin).length,
    matched: [...recs.values()].filter((r) => r.searchResult === 'matched').length,
    waiting: queue?.ids.length ?? 0,
    lastRunAt: last?.at,
    pausedUntil: paused ? budget.pausedUntil : undefined,
    pauseReason: paused ? budget.pauseReason : undefined,
    left: {
      profiles: budgetLeft(budget, 'profile') + budgetLeft(budget, 'view'),
      searches: budgetLeft(budget, 'search'),
    },
    web: providers?.exa ? 'on' : 'not_set_up',
  };
}

export type { Budget };

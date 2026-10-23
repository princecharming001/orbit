/**
 * Deep research on one person from the browser (docs/plan/20-deep-research.md). Research starts in exactly one place:
 * the student pressing Deep research on the person's About tab (and Go deeper on the finished brief). Nothing in
 * Orbit calls startResearch on its own: not the chat, not Write to, not opening a page, not a schedule.
 *
 * Who can use it:
 *   - a student whose LinkedIn is connected live through Orbit: the brief comes from orbit-research
 *     (integrations/researchProxy.ts), counted against the LinkedIn account's 15 a month on the server;
 *   - the sample student: sample briefs, made here with no network call, counted 15 a month in this browser;
 *   - account mode keeps the server's own dossier queue (engine/research.ts).
 *
 * The browser sends the person, the LinkedIn profile the enrichment step already read (no extra LinkedIn views) and a
 * short digest of the student's history with them, and keeps the brief in Dexie (db.dossiers) for 90 days. Only
 * claims the support check called fully supported become facts (tagged with the brief, so deleting the brief deletes
 * them); "careful" never does. Someone marked do-not-contact is never researched.
 */
import type { Dossier, DossierResearch, Person, PersonFact, User } from '@orbit/core';
import { newId } from '@orbit/core';
import { db } from '../db/schema';
import { usesMockConnectors } from '../integrations/connectorsMock';
import { isServerUser } from '../integrations/orbitApi';
import {
  type Allowance,
  type BriefBody,
  deeperBrief,
  quickBrief,
  type ResearchAnswer,
  type ResearchFailureReason,
  researchStatus,
  researchUrl,
} from '../integrations/researchProxy';
import { demoBriefFor } from './demoDossiers';
import { readRecord } from './enrichment/store';
import { liveLinkedInAccount } from './linkedinLive';
import { localDossier } from './research';

export const BRIEF_KEEP_DAYS = 90;
export const MONTHLY_BRIEFS = 15;
export const RESEARCH_FOOTER = 'Public professional sources only, every line cited, kept 90 days.';
const DAY = 86_400_000;

export type ResearchMode =
  | { kind: 'demo' }
  | { kind: 'live'; accountId: string; token?: string }
  | { kind: 'server' }
  | { kind: 'off'; reason: 'connect_linkedin' | 'unconfigured' };

/** How this student can research people, if at all. */
export async function researchMode(user: Pick<User, 'id'>): Promise<ResearchMode> {
  if (usesMockConnectors(user.id)) return { kind: 'demo' };
  if (isServerUser(user.id)) return { kind: 'server' };
  if (!researchUrl()) return { kind: 'off', reason: 'unconfigured' };
  const row = await liveLinkedInAccount(user.id);
  if (!row || row.status === 'revoked' || !row.externalAccountId)
    return { kind: 'off', reason: 'connect_linkedin' };
  return { kind: 'live', accountId: row.externalAccountId, token: row.accessToken };
}

export const monthOf = (now: Date) => now.toISOString().slice(0, 7);
const allowanceKey = (userId: string) => `research:allowance:${userId}`;

/** This month's briefs, as the server last said (live) or as counted here (the demo). */
export async function readAllowance(user: Pick<User, 'id'>, now = new Date()): Promise<Allowance> {
  const month = monthOf(now);
  const mode = await researchMode(user);
  if (mode.kind !== 'live') return localAllowance(user.id, month);
  const kept = (await db.kv.get(allowanceKey(user.id)))?.value as (Allowance & { at?: number }) | undefined;
  if (kept && kept.month === month && Date.now() - (kept.at ?? 0) < 10 * 60_000) return kept;
  const r = await researchStatus(mode.accountId, mode.token);
  if (r.ok) {
    await keepAllowance(user.id, r.value.allowance);
    return r.value.allowance;
  }
  if (kept && kept.month === month) return kept;
  return { used: 0, limit: MONTHLY_BRIEFS, left: MONTHLY_BRIEFS, month };
}

async function keepAllowance(userId: string, a: Allowance): Promise<void> {
  await db.kv.put({ key: allowanceKey(userId), value: { ...a, at: Date.now() } });
}

/** Different people researched this month, from this browser's own log (the demo, and Settings). */
async function localAllowance(userId: string, month: string): Promise<Allowance> {
  const runs = await db.researchRuns
    .where('month')
    .equals(month)
    .filter(
      (r) => r.userId === userId && r.kind === 'quick' && (r.status === 'ready' || r.status === 'partial'),
    )
    .toArray();
  const used = new Set(runs.map((r) => r.personId)).size;
  return { used, limit: MONTHLY_BRIEFS, left: Math.max(0, MONTHLY_BRIEFS - used), month };
}

/** "Research · 12 left this month": the count students see; dollars only in Settings. */
export function allowanceLine(a: Pick<Allowance, 'left'>): string {
  return `Research · ${a.left} left this month`;
}

/** What research has cost this month, for Settings. */
export async function researchSpend(
  userId: string,
  now = new Date(),
): Promise<{ briefs: number; usd: number; runs: number }> {
  const runs = await db.researchRuns
    .where('month')
    .equals(monthOf(now))
    .filter((r) => r.userId === userId)
    .toArray();
  return {
    briefs: new Set(runs.filter((r) => r.kind === 'quick' && r.status !== 'failed').map((r) => r.personId))
      .size,
    usd: Math.round(runs.reduce((s, r) => s + r.costUsd, 0) * 100) / 100,
    runs: runs.length,
  };
}

export type StartResult =
  | { ok: true; status: 'ready' | 'partial' | 'needs_disambiguation'; dossier: Dossier }
  | { ok: true; status: 'queued' }
  | {
      ok: false;
      reason: ResearchFailureReason | 'needs_anchor' | 'minor' | 'not_found' | 'connect_linkedin';
      message: string;
    };

const briefId = (personId: string) => `brief_${personId}`;

/** The student's history with them, short: a few messages and notes, for "in common" and openers. Never stored. */
export async function historyDigest(user: Pick<User, 'id'>, personId: string): Promise<string> {
  const inbound = await db.messages.where('fromPersonId').equals(personId).toArray();
  const threads = [...new Set(inbound.map((m) => m.threadId))];
  const outbound = threads.length
    ? (await db.messages.where('threadId').anyOf(threads).toArray()).filter((m) => m.direction === 'outbound')
    : [];
  const sent = (await db.outbound.where('personId').equals(personId).toArray()).filter(
    (o) => o.status === 'sent',
  );
  const msgs = [
    ...inbound.map((m) => ({
      at: m.sentAt,
      line: `them → student${m.subject ? ` · ${m.subject}` : ''}: ${m.bodyText}`,
    })),
    ...outbound.map((m) => ({
      at: m.sentAt,
      line: `student → them${m.subject ? ` · ${m.subject}` : ''}: ${m.bodyText}`,
    })),
    ...sent.map((o) => ({
      at: o.sentAt ?? o.createdAt,
      line: `student → them: ${o.bodyFinal ?? o.bodyDraft}`,
    })),
  ]
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-5);
  const notes = (
    await db.notes
      .where('userId')
      .equals(user.id)
      .filter((n) => n.personIds.includes(personId))
      .toArray()
  )
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    .slice(-3);
  const lines = [
    ...msgs.map((m) => `${m.at.slice(0, 10)} ${m.line.replace(/\s+/g, ' ').slice(0, 320)}`),
    ...notes.map(
      (n) =>
        `note ${n.occurredAt.slice(0, 10)}: ${(n.rawSummary ?? n.rawText).replace(/\s+/g, ' ').slice(0, 400)}`,
    ),
  ];
  return lines.join('\n').slice(0, 3000);
}

/** The LinkedIn profile as Orbit holds it after enrichment, for the brief's first source (no new LinkedIn call). */
export async function profileFor(person: Person): Promise<BriefBody['profile']> {
  const affs = await db.affiliations.where('personId').equals(person.id).toArray();
  const fromLinkedIn =
    !!person.linkedinSlug ||
    !!person.linkedinUrl ||
    Object.values(person.fieldSources ?? {}).includes('linkedin_profile') ||
    affs.some((a) => String(a.source).startsWith('linkedin'));
  if (!fromLinkedIn) return null;
  const rec = await readRecord(person.id);
  const jobs = affs
    .filter((a) => a.kind === 'employment' && a.nameRaw)
    .sort((a, b) =>
      a.isCurrent !== b.isCurrent
        ? a.isCurrent
          ? -1
          : 1
        : (b.endDate ?? b.startDate ?? '').localeCompare(a.endDate ?? a.startDate ?? ''),
    );
  const schools = affs.filter((a) => a.kind === 'education' && a.nameRaw);
  const experience = jobs.slice(0, 12).map((a) => ({
    title: a.title,
    company: a.nameRaw,
    current: a.isCurrent,
    start: a.startDate?.slice(0, 7),
    end: a.endDate?.slice(0, 7),
  }));
  if (!experience.some((e) => e.current) && person.currentOrganizationRaw)
    experience.unshift({
      title: person.currentTitle,
      company: person.currentOrganizationRaw,
      current: true,
      start: undefined,
      end: undefined,
    });
  return {
    headline: person.headline,
    location: person.location,
    about: rec?.about,
    publicIdentifier: person.linkedinSlug,
    experience,
    education: schools.slice(0, 6).map((a) => ({
      school: a.nameRaw,
      degree: a.degree,
      field: a.field,
      start: a.startDate?.slice(0, 4),
      end: a.endDate?.slice(0, 4),
    })),
  };
}

async function studentFor(user: User) {
  const goals = await db.goals.get(user.id);
  const fn = goals?.targetFunctions?.length ? goals.targetFunctions.slice(0, 2).join(' or ') : undefined;
  const goalSentence = fn
    ? `find a ${fn} role${goals?.cycleLabel ? ` (${goals.cycleLabel})` : ''}`
    : 'build relationships with people who matter to their work';
  const context = [
    `${user.fullName}${user.school ? `, ${user.school}` : ''}${user.graduationYear ? ` ${user.graduationYear}` : ''}`,
    user.majors?.length ? `studying ${user.majors.join(' and ')}` : '',
    goals?.targetRoles?.length ? `looking for ${goals.targetRoles.slice(0, 3).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('; ');
  return { firstName: user.firstName, context, goalSentence, goalKind: 'recruiting' };
}

function snapshotOf(person: Person): DossierResearch['snapshot'] {
  return { headline: person.headline, title: person.currentTitle, org: person.currentOrganizationRaw };
}

/**
 * Research one person, because the student pressed Deep research (kind 'quick') or Go deeper (kind 'deeper') on
 * their About tab. The only way a brief is ever made.
 */
export async function startResearch(
  user: User,
  personId: string,
  opts: { kind?: 'quick' | 'deeper'; candidateIndex?: number; now?: Date } = {},
): Promise<StartResult> {
  const kind = opts.kind ?? 'quick';
  const now = opts.now ?? new Date();
  const person = await db.people.get(personId);
  if (!person || person.userId !== user.id)
    return { ok: false, reason: 'not_found', message: 'That person is not in Orbit.' };
  // never research someone the student marked do-not-contact
  if (person.doNotContact)
    return {
      ok: false,
      reason: 'do_not_contact',
      message: `You marked ${person.firstName || 'them'} do-not-contact, so Orbit does not research them.`,
    };
  const mode = await researchMode(user);
  if (mode.kind === 'off')
    return mode.reason === 'connect_linkedin'
      ? {
          ok: false,
          reason: 'connect_linkedin',
          message: 'Connect your LinkedIn in Settings to research people.',
        }
      : { ok: false, reason: 'unconfigured', message: 'Deep research is not set up in this copy of Orbit.' };
  if (mode.kind === 'server') return { ok: true, status: 'queued' };
  const prior = await localDossier(personId);
  if (kind === 'deeper' && !(prior && (prior.status === 'ready' || prior.status === 'partial')))
    return { ok: false, reason: 'needs_quick', message: 'Run Deep research first, then Go deeper.' };
  const chosen =
    opts.candidateIndex !== undefined && prior?.status === 'needs_disambiguation'
      ? candidateChoice(prior, opts.candidateIndex)
      : prior?.research?.chosen;

  if (mode.kind === 'demo') return demoResearch(user, person, kind, now, prior);

  const profile = await profileFor(person);
  const body: BriefBody = {
    accountId: mode.accountId,
    token: mode.token,
    person: {
      name: person.displayName,
      firstName: person.firstName,
      lastName: person.lastName,
      title: person.currentTitle,
      org: person.currentOrganizationRaw,
      location: person.location,
      school: person.school,
      linkedinUrl: person.linkedinUrl,
      // a work address tells namesakes apart; the server keeps only its domain for matching
      emails: [person.primaryEmail, ...(person.emails ?? [])].filter((e): e is string => !!e).slice(0, 3),
    },
    profile,
    posts: [],
    history: await historyDigest(user, person.id),
    student: await studentFor(user),
    chosen,
    doNotContact: !!person.doNotContact,
  };
  const r = kind === 'quick' ? await quickBrief(body) : await deeperBrief(body);
  if (!r.ok) {
    if (r.allowance) await keepAllowance(user.id, r.allowance);
    return { ok: false, reason: r.reason, message: r.message };
  }
  return keepAnswer(user, person, kind, r.value, prior, chosen, now);
}

function candidateChoice(d: Dossier, index: number): DossierResearch['chosen'] {
  const c = (d.candidates ?? [])[index] as { org?: string; url?: string } | undefined;
  return c ? { org: c.org, url: c.url } : undefined;
}

async function logRun(
  user: Pick<User, 'id'>,
  personId: string,
  kind: 'quick' | 'deeper',
  status: string,
  costUsd: number,
  now: Date,
) {
  await db.researchRuns.put({
    id: newId('rrun'),
    userId: user.id,
    personId,
    kind,
    month: monthOf(now),
    status,
    costUsd,
    createdAt: now.toISOString(),
  });
}

async function keepAnswer(
  user: User,
  person: Person,
  kind: 'quick' | 'deeper',
  a: ResearchAnswer,
  prior: Dossier | undefined,
  chosen: DossierResearch['chosen'],
  now: Date,
): Promise<StartResult> {
  if (a.allowance) await keepAllowance(user.id, a.allowance);
  await logRun(user, person.id, kind, a.status, a.costUsd ?? 0, now);
  const at = now.toISOString();
  if (a.status === 'needs_anchor' || a.status === 'failed')
    return {
      ok: false,
      reason: a.status === 'failed' ? 'minor' : 'needs_anchor',
      message: a.message,
    };
  if (a.status === 'needs_disambiguation') {
    const d: Dossier = {
      id: briefId(person.id),
      userId: user.id,
      personId: person.id,
      status: 'needs_disambiguation',
      sources: [],
      candidates: a.candidates,
      costUsd: (prior?.costUsd ?? 0) + a.costUsd,
      createdAt: prior?.createdAt ?? at,
      updatedAt: at,
      expiresAt: new Date(now.getTime() + BRIEF_KEEP_DAYS * DAY).toISOString(),
      research: { kind: 'quick', snapshot: snapshotOf(person) },
    };
    await db.dossiers.put(d);
    return { ok: true, status: 'needs_disambiguation', dossier: d };
  }
  if (a.status !== 'ready' && a.status !== 'partial')
    return { ok: false, reason: 'error', message: 'Research did not work this time.' };
  const b = a.brief;
  const d: Dossier = {
    id: briefId(person.id),
    userId: user.id,
    personId: person.id,
    status: a.status,
    content: b.content,
    sources: b.sources.map((s) => ({ ...s, url: s.url || undefined })),
    costUsd: Math.round(((kind === 'deeper' ? (prior?.costUsd ?? 0) : 0) + b.costUsd) * 10_000) / 10_000,
    model: b.model ?? undefined,
    createdAt: kind === 'deeper' && prior ? prior.createdAt : at,
    updatedAt: at,
    expiresAt: new Date(now.getTime() + BRIEF_KEEP_DAYS * DAY).toISOString(),
    research: {
      kind,
      snapshot: snapshotOf(person),
      notes: b.notes,
      checked: b.checked,
      strongPages: b.strongPages,
      provider: b.provider,
      chosen,
      ...(kind === 'deeper' ? { deeperAt: at } : {}),
    },
  };
  await db.dossiers.put(d);
  await writeResearchFacts(user.id, d, now);
  return { ok: true, status: a.status, dossier: d };
}

/** The demo: a sample brief for the person, after a short pause, with no network call. */
async function demoResearch(
  user: User,
  person: Person,
  kind: 'quick' | 'deeper',
  now: Date,
  prior: Dossier | undefined,
): Promise<StartResult> {
  if (kind === 'quick') {
    const a = await localAllowance(user.id, monthOf(now));
    const counted = (await db.researchRuns.where('personId').equals(person.id).toArray()).some(
      (r) => r.month === monthOf(now) && r.kind === 'quick' && r.status !== 'failed',
    );
    if (a.left <= 0 && !counted)
      return {
        ok: false,
        reason: 'limit',
        message: `You have used this month's ${MONTHLY_BRIEFS} research briefs. They come back on the 1st.`,
      };
  }
  await new Promise((r) => setTimeout(r, demoDelayMs));
  const user2 = await db.users.get(user.id);
  const d = await demoBriefFor(user.id, person, kind, now, user2?.school ?? user.school);
  if (kind === 'deeper' && prior) d.createdAt = prior.createdAt;
  d.research = { ...d.research!, snapshot: snapshotOf(person) };
  await db.dossiers.put(d);
  await logRun(user, person.id, kind, d.status, 0, now);
  await writeResearchFacts(user.id, d, now);
  return { ok: true, status: d.status as 'ready', dossier: d };
}

let demoDelayMs = 900;
/** Test hook: how long the demo pretends to research. */
export function setDemoResearchDelayForTests(ms: number | undefined): void {
  demoDelayMs = ms ?? 900;
}

// ---- facts from a brief --------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const arr = (v: unknown): Obj[] =>
  Array.isArray(v) ? v.filter((x): x is Obj => !!x && typeof x === 'object') : [];
const full = (o: Obj | undefined) => o?.support === 'full';

/** The page a claim's first source is, for a fact's evidence. */
function evidenceOf(d: Dossier, o: Obj): string | undefined {
  const ids = Array.isArray(o.source_ids) ? (o.source_ids as string[]) : [];
  const s = d.sources.find((x) => x.id === ids[0]);
  return s?.url ? `${s.title ?? 'source'}: ${s.url}` : undefined;
}

/**
 * The facts a brief writes (docs/plan/20 §6): fully supported claims only. Their current role becomes a role detail,
 * openers become hooks, recent items background, what they share with the student a connection. "Careful" and
 * company context never become facts. Each fact is tagged with the brief, so deleting it deletes them.
 */
export async function writeResearchFacts(userId: string, d: Dossier, now = new Date()): Promise<number> {
  await deleteFactsOf(d.id);
  if (d.status !== 'ready' && d.status !== 'partial') return 0;
  // without the support check nothing is known to be supported (a sample brief in the demo is its own source)
  if (!d.research?.checked && !d.research?.sample) return 0;
  const c = (d.content ?? {}) as Obj;
  const at = now.toISOString();
  const facts: PersonFact[] = [];
  const add = (type: PersonFact['type'], text: string, o: Obj, occurredAt?: string) => {
    const t = text.trim();
    if (!t) return;
    facts.push({
      id: newId('fact'),
      userId,
      personId: d.personId,
      type,
      text: t.slice(0, 300),
      sourceTable: 'dossiers',
      sourceId: d.id,
      occurredAt,
      confidence: 0.9,
      evidence: evidenceOf(d, o),
      createdAt: at,
    });
  };
  const nowClaim = c.now as Obj | undefined;
  if (full(nowClaim) && typeof nowClaim?.role === 'string' && nowClaim.role) {
    const org = typeof nowClaim.org === 'string' && nowClaim.org ? ` at ${nowClaim.org}` : '';
    add('role_detail', `${nowClaim.role}${org}`, nowClaim);
  }
  for (const o of arr(c.openers).filter(full)) add('hook', String(o.text ?? ''), o);
  for (const o of arr(c.recently).filter(full))
    add(
      'background',
      String(o.text ?? ''),
      o,
      typeof o.date === 'string' && /^\d{4}/.test(o.date) ? o.date : undefined,
    );
  for (const o of arr(c.in_common).filter(full)) add('connection', String(o.text ?? ''), o);
  if (facts.length) await db.facts.bulkPut(facts);
  return facts.length;
}

async function deleteFactsOf(dossierId: string): Promise<void> {
  await db.facts.where('[sourceTable+sourceId]').equals(['dossiers', dossierId]).delete();
}

/** Delete a brief and every fact it wrote. */
export async function deleteBrief(dossierId: string): Promise<void> {
  await deleteFactsOf(dossierId);
  await db.dossiers.delete(dossierId);
}

/** Delete everything research made about a person: their briefs and the facts the briefs wrote. */
export async function deletePersonResearch(personId: string): Promise<void> {
  const rows = await db.dossiers.where('personId').equals(personId).toArray();
  for (const d of rows) await deleteBrief(d.id);
}

/** Briefs past their 90 days go, with their facts (run when the app opens). */
export async function expireBriefs(userId: string, now = new Date()): Promise<number> {
  const old = await db.dossiers
    .where('userId')
    .equals(userId)
    .filter((d) => !!d.research && d.expiresAt < now.toISOString())
    .toArray();
  for (const d of old) await deleteBrief(d.id);
  return old.length;
}

/**
 * A brief is worth refreshing only when their LinkedIn changed: the enrichment step's regular re-check saw a new job
 * or headline after the brief was made. Opening the page never re-reads LinkedIn for this.
 */
export async function briefStale(person: Person, d: Dossier): Promise<boolean> {
  if (!d.research || d.research.sample) return false;
  const rec = await readRecord(person.id);
  if (rec?.jobChange && rec.jobChange.observedAt > d.createdAt) return true;
  const s = d.research.snapshot;
  if (!s) return false;
  const changed = (a?: string, b?: string) => !!a && !!b && a.trim().toLowerCase() !== b.trim().toLowerCase();
  return changed(s.headline, person.headline) || changed(s.org, person.currentOrganizationRaw);
}

export interface ResearchOpener {
  dossierId: string;
  text: string;
  /** the source's number in the brief ("from research [1]") */
  ref: number;
  url?: string;
}

/**
 * The openers a first message may use, best first: from the brief, fully supported by the check, never a partly
 * supported one. The first goes into the draft as its "one thing only true of them" line, shown as a chip.
 */
export async function researchOpeners(personId: string): Promise<ResearchOpener[]> {
  const d = await localDossier(personId);
  if (!d || (d.status !== 'ready' && d.status !== 'partial')) return [];
  if (!d.research?.checked && !d.research?.sample) return [];
  const c = (d.content ?? {}) as Obj;
  return arr(c.openers)
    .filter(full)
    .map((o) => {
      const ids = Array.isArray(o.source_ids) ? (o.source_ids as string[]) : [];
      const i = d.sources.findIndex((s) => s.id === ids[0]);
      const s = i >= 0 ? d.sources[i] : undefined;
      return {
        dossierId: d.id,
        text: String(o.text ?? '').trim(),
        ref: i + 1,
        url: s?.url && !s.demo ? s.url : undefined,
      };
    })
    .filter((o) => o.text && o.ref > 0);
}

/** Can this student research this person now, and if not, why (for the About tab's card). */
export async function researchBlocker(user: Pick<User, 'id'>, person: Person): Promise<string | undefined> {
  if (person.doNotContact)
    return `You marked ${person.firstName || 'them'} do-not-contact, so Orbit does not research them.`;
  const m = await researchMode(user);
  if (m.kind === 'off')
    return m.reason === 'connect_linkedin'
      ? 'Connect your LinkedIn to Orbit in Settings, and you can research people here.'
      : 'Deep research is not set up in this copy of Orbit.';
  return undefined;
}

export type { Allowance };

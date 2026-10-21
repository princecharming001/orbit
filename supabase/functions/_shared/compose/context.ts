/**
 * The inputs compose (§7.3), research (§5.6) and replies (§8.3) share: the user context (≤ 1,200 tokens, from the
 * user row, active goals, the current resume facets and the top memories), the recipient, the dossier as numbered
 * research, and the voice: the style card plus three of the user's own sent messages most like the situation
 * (pgvector cosine on messages.embedding; outbound, ≥ 25 words, never to the same recipient, names replaced by
 * [name]).
 */
import { defaultStyleCard } from '@orbit/core/style/card';
import { stripQuotedReply } from '@orbit/core/text/email';
import type { StyleCard } from '@orbit/core/types';
import type { Db } from '../db.ts';
import { HttpError } from '../http.ts';
import { firstNameOf, iso, vec } from '../rows.ts';
import type { Services } from '../services.ts';

/** ≈ 1,200 tokens at four characters a token. */
export const USER_CONTEXT_MAX_CHARS = 4800;

export type UserRow = {
  id: string;
  email: string;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  school: string | null;
  grad_year: number | null;
  degree: string | null;
  majors: string[];
  current_title: string | null;
  current_org: string | null;
  current_city: string | null;
  timezone: string;
  autonomy_level: number;
  settings: Record<string, unknown>;
};

export async function loadUserRow(db: Db, userId: string): Promise<UserRow> {
  const [u] = await db.sql<UserRow>`
    select id, email, full_name, first_name, last_name, school, grad_year, degree, majors, current_title,
           current_org, current_city, timezone, autonomy_level, settings
      from orbit.users where id = ${userId}::uuid and deleted_at is null`;
  if (!u) throw new HttpError(401, 'unauthorized', 'sign in again');
  return { ...u, settings: u.settings ?? {}, majors: u.majors ?? [] };
}

export const userFirstName = (u: Pick<UserRow, 'first_name' | 'full_name' | 'email'>): string =>
  u.first_name?.trim() || u.full_name?.trim().split(/\s+/)[0] || u.email.split('@')[0]!;

export type PersonRow = {
  id: string;
  user_id: string;
  is_self: boolean;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  primary_email: string | null;
  headline: string | null;
  title: string | null;
  org_raw: string | null;
  org_name: string | null;
  location: string | null;
  timezone: string | null;
  school: string | null;
  is_alumni: boolean;
  linkedin_url: string | null;
  linkedin_slug: string | null;
  linkedin_member_id: string | null;
  do_not_contact: boolean;
  hidden_at: Date | null;
  last_interaction_at: Date | null;
  score: number | null;
  emails: string[];
};

export async function loadPerson(db: Db, userId: string, personId: unknown): Promise<PersonRow> {
  if (typeof personId !== 'string' || !/^[0-9a-f-]{36}$/i.test(personId))
    throw new HttpError(400, 'bad_request', 'personId is required');
  const [p] = await db.sql<PersonRow>`
    select p.id, p.user_id, p.is_self, p.display_name, p.first_name, p.last_name, p.primary_email, p.headline,
           p.title, p.org_raw, o.name as org_name, p.location, p.timezone, p.school, p.is_alumni, p.linkedin_url,
           p.linkedin_slug, p.linkedin_member_id, p.do_not_contact, p.hidden_at, p.last_interaction_at,
           ts.score::int as score,
           coalesce((select array_agg(i.value_norm order by i.created_at) from orbit.person_identities i
                      where i.person_id = p.id and i.kind = 'email'), '{}') as emails
      from orbit.people p
      left join orbit.organizations o on o.id = p.org_id
      left join orbit.tie_scores ts on ts.user_id = p.user_id and ts.person_id = p.id
     where p.id = ${personId}::uuid and p.user_id = ${userId}::uuid and p.deleted_at is null`;
  if (!p) throw new HttpError(404, 'not_found', 'no such person');
  const emails = [...new Set([p.primary_email, ...(p.emails ?? [])].filter((e): e is string => !!e))];
  return { ...p, emails };
}

export const personOrg = (p: Pick<PersonRow, 'org_name' | 'org_raw'>) => p.org_name ?? p.org_raw ?? undefined;

/** Who the user is, what they are working toward, their resume and what Orbit remembers: ≤ 1,200 tokens. */
export async function buildUserContext(db: Db, u: UserRow): Promise<string> {
  const lines: string[] = [];
  const name = u.full_name ?? userFirstName(u);
  const role = [u.current_title, u.current_org].filter(Boolean).join(' at ');
  const school = u.school
    ? `${[u.degree, u.majors.join(', ')].filter(Boolean).join(' in ') || 'Student'} at ${u.school}${u.grad_year ? `, class of ${u.grad_year}` : ''}`
    : '';
  lines.push(
    [name, role, school, u.current_city ? `based in ${u.current_city}` : ''].filter(Boolean).join('; '),
  );
  const s = u.settings;
  for (const [k, label] of [
    ['company', 'Company'],
    ['pitch', 'What it does'],
    ['traction', 'Traction'],
    ['bio', 'About'],
  ] as const)
    if (typeof s[k] === 'string' && (s[k] as string).trim())
      lines.push(`${label}: ${(s[k] as string).trim()}`);

  const goals = await db.sql<{ kind: string; title: string; description: string | null; targets: unknown }>`
    select kind, title, description, targets from orbit.goals
     where user_id = ${u.id}::uuid and status = 'active' and deleted_at is null
     order by priority, created_at limit 5`;
  for (const g of goals) {
    const t = (g.targets ?? {}) as Record<string, string[]>;
    const targets = [...(t.organizations ?? []), ...(t.roles ?? [])].slice(0, 6).join(', ');
    lines.push(
      `Goal (${g.kind}): ${g.title}${g.description ? `. ${g.description}` : ''}${targets ? ` (targets: ${targets})` : ''}`,
    );
  }

  const [resume] = await db.sql<{ parsed: Record<string, unknown> | null; text: string }>`
    select parsed, text from orbit.uploads
     where user_id = ${u.id}::uuid and kind = 'resume' and is_current
     order by created_at desc limit 1`;
  if (resume) {
    const facets = facetLines(resume.parsed);
    lines.push(
      `Resume: ${facets.length ? facets.join('; ') : resume.text.replace(/\s+/g, ' ').slice(0, 800)}`,
    );
  }

  const memories = await db.sql<{ text: string }>`
    select text from orbit.memories
     where user_id = ${u.id}::uuid and deleted_at is null and person_id is null
     order by importance desc, last_seen_at desc limit 10`;
  if (memories.length) lines.push(`Remembered: ${memories.map((m) => m.text).join(' | ')}`);

  const text = lines.join('\n');
  return text.length > USER_CONTEXT_MAX_CHARS ? `${text.slice(0, USER_CONTEXT_MAX_CHARS - 1)}…` : text;
}

/** Resume facets (parsed.experiences / education / skills / facets) as short lines. */
function facetLines(parsed: Record<string, unknown> | null): string[] {
  if (!parsed) return [];
  const out: string[] = [];
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  for (const f of list(parsed.facets)) {
    const o = f as Record<string, unknown>;
    const t = [o.title ?? o.role, o.org ?? o.organization, o.text].filter((x) => typeof x === 'string');
    if (t.length) out.push(t.join(', '));
  }
  for (const e of list(parsed.experiences ?? parsed.experience)) {
    const o = e as Record<string, unknown>;
    const t = [o.title, o.org ?? o.company].filter((x) => typeof x === 'string');
    if (t.length) out.push(t.join(' at '));
  }
  for (const e of list(parsed.education)) {
    const o = e as Record<string, unknown>;
    const t = [o.degree, o.school].filter((x) => typeof x === 'string');
    if (t.length) out.push(t.join(', '));
  }
  const skills = list(parsed.skills).filter((x) => typeof x === 'string');
  if (skills.length) out.push(`Skills: ${skills.slice(0, 12).join(', ')}`);
  return out.slice(0, 12);
}

// ---- voice ----------------------------------------------------------------------------------------------------

/** The user's style card when it was built from ≥ 5 sent messages, else the tone preset (§7.7). */
export function styleCardOf(u: UserRow): StyleCard {
  const card = u.settings.style_card as Partial<StyleCard> | undefined;
  if (card && typeof card === 'object' && ((card.builtFromCount ?? 0) >= 3 || card.custom))
    return card as StyleCard;
  const preset = u.settings.tone_preset;
  return defaultStyleCard(preset === 'direct' || preset === 'formal' ? preset : 'warm', userFirstName(u));
}

export function voiceText(c: StyleCard): string {
  return [
    `greetings: ${c.greetingPatterns.join(' | ')}`,
    `sign-offs: ${c.signoffs.map((x) => x.replace(/\n/g, ' ')).join(' | ')}`,
    `average sentence: ${Math.round(c.avgSentenceWords)} words; average message: ${Math.round(c.avgMessageWords)} words`,
    `contractions: ${c.contractions ? 'yes' : 'no'}; exclamation marks: ${c.exclamationsPerMessage > 0 ? 'sometimes' : 'never'}; emoji: ${c.emoji ? 'yes' : 'no'}`,
    c.characteristicPhrases.length ? `phrases they use: ${c.characteristicPhrases.join(' | ')}` : '',
    c.avoid.length ? `never: ${c.avoid.join(' | ')}` : '',
    c.notes ? `notes: ${c.notes}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Three of the user's sent messages most like the situation (§7.3): outbound, ≥ 25 words, not to this recipient,
 * recipients' names replaced by [name]. `replies` prefers their own replies (§8.3). Empty without embeddings.
 */
export async function exemplars(
  s: Pick<Services, 'db' | 'embed'>,
  userId: string,
  personId: string,
  situation: string,
  opts: { replies?: boolean; limit?: number } = {},
): Promise<string[]> {
  let q: number[] | null = null;
  try {
    q = await s.embed(situation);
  } catch {
    q = null;
  }
  if (!q?.length) return [];
  const limit = opts.limit ?? 3;
  const pick = (onlyReplies: boolean) => s.db.sql<{ id: string; body_text: string; to_person_ids: string[] }>`
    select m.id, m.body_text, m.to_person_ids from orbit.messages m
     where m.user_id = ${userId}::uuid and m.direction = 'out' and m.embedding is not null
       and m.body_text is not null and not (${personId}::uuid = any(m.to_person_ids))
       and coalesce(array_length(regexp_split_to_array(btrim(m.body_text), '\\s+'), 1), 0) >= 25
       and (${onlyReplies}::boolean = false or m.in_reply_to is not null)
     order by m.embedding <=> ${vec(q)}::vector
     limit ${limit}::int`;
  let rows = await pick(!!opts.replies);
  if (opts.replies && rows.length < limit) {
    const more = await pick(false);
    rows = [...rows, ...more.filter((m) => !rows.some((r) => r.id === m.id))].slice(0, limit);
  }
  const ids = [...new Set(rows.flatMap((r) => r.to_person_ids ?? []))];
  const names = ids.length
    ? await s.db.sql<{ first_name: string | null; last_name: string | null; display_name: string }>`
        select first_name, last_name, display_name from orbit.people
         where user_id = ${userId}::uuid and id = any(${ids}::uuid[])`
    : [];
  const words = [
    ...new Set(
      names
        .flatMap((n) => [n.display_name, n.first_name, n.last_name])
        .filter((x): x is string => !!x?.trim()),
    ),
  ].sort((a, b) => b.length - a.length);
  return rows.map((r) => {
    let text = stripQuotedReply(r.body_text).trim().slice(0, 1200);
    for (const w of words) text = text.replace(new RegExp(`\\b${escapeRe(w)}\\b`, 'g'), '[name]');
    return text.replace(/^(hi|hey|hello|dear)\s+[A-Z][a-z]+/i, (m) => `${m.split(/\s+/)[0]} [name]`);
  });
}

// ---- research --------------------------------------------------------------------------------------------------

export interface ResearchItem {
  id: string;
  text: string;
  kind: 'opener' | 'recently' | 'in_common' | 'now' | 'fact';
}

export interface Research {
  text: string;
  /** source ids a hook may cite */
  ids: string[];
  /** the openers, best first (template hooks) */
  openers: ResearchItem[];
  /** what the dossier says they did recently (nurture reasons) */
  recently: { text: string; date: string | null }[];
  /** the dossier's `now`, as "role at org" */
  now?: string;
}

interface DossierContent {
  who?: string;
  now?: { role?: string; org?: string; since?: string | null; source_ids?: string[] };
  recently?: { date?: string | null; text: string; source_ids?: string[] }[];
  in_common?: { text: string; kind?: string; source_ids?: string[] }[];
  openers?: { text: string; source_ids?: string[] }[];
  careful?: string[];
}

/** The dossier (ready or partial) and the person's facts as numbered research for the prompt. */
export async function loadResearch(db: Db, userId: string, personId: string): Promise<Research> {
  const [d] = await db.sql<{ content: DossierContent | null; status: string }>`
    select content, status from orbit.dossiers
     where user_id = ${userId}::uuid and person_id = ${personId}::uuid and status in ('ready', 'partial')`;
  const facts = await db.sql<{ id: string; text: string; type: string }>`
    select id, text, type from orbit.facts
     where user_id = ${userId}::uuid and person_id = ${personId}::uuid and deleted_at is null
     order by confidence desc, created_at desc limit 8`;
  const c = d?.content ?? {};
  const lines: string[] = [];
  const ids = new Set<string>();
  const openers: ResearchItem[] = [];
  const cite = (xs: string[] | undefined) => {
    for (const x of xs ?? []) ids.add(x);
    return xs?.length ? ` [${xs.join(', ')}]` : '';
  };
  if (c.who) lines.push(`who: ${c.who}`);
  let now: string | undefined;
  if (c.now?.role || c.now?.org) {
    now = [c.now.role, c.now.org].filter(Boolean).join(' at ');
    lines.push(`now: ${now}${c.now.since ? ` since ${c.now.since}` : ''}${cite(c.now.source_ids)}`);
  }
  for (const r of c.recently ?? [])
    lines.push(`recently: ${r.date ? `${r.date}: ` : ''}${r.text}${cite(r.source_ids)}`);
  for (const r of c.in_common ?? []) lines.push(`in common: ${r.text}${cite(r.source_ids)}`);
  for (const o of c.openers ?? []) {
    lines.push(`opener: ${o.text}${cite(o.source_ids)}`);
    if (o.source_ids?.[0]) openers.push({ id: o.source_ids[0], text: o.text, kind: 'opener' });
  }
  for (const x of c.careful ?? []) lines.push(`careful: ${x}`);
  facts.forEach((f, i) => {
    const id = `F${i + 1}`;
    ids.add(id);
    lines.push(`fact [${id}] (${f.type}): ${f.text}`);
    openers.push({ id, text: f.text, kind: 'fact' });
  });
  return {
    text: lines.join('\n'),
    ids: [...ids],
    openers,
    recently: (c.recently ?? []).map((r) => ({ text: r.text, date: r.date ?? null })),
    now,
  };
}

export function recipientText(p: PersonRow): string {
  return [
    `name: ${p.display_name}`,
    p.title ? `title: ${p.title}` : '',
    personOrg(p) ? `organization: ${personOrg(p)}` : '',
    p.headline ? `headline: ${p.headline}` : '',
    p.location ? `location: ${p.location}` : '',
    p.school ? `school: ${p.school}${p.is_alumni ? ' (same school as the user)' : ''}` : '',
    p.score !== null && p.score !== undefined ? `relationship score: ${p.score}/100` : '',
    p.last_interaction_at ? `last contact: ${iso(p.last_interaction_at)!.slice(0, 10)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export { firstNameOf };

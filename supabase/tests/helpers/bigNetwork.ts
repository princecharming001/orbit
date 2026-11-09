/**
 * A synthetic network the size of the owner's (plan 35 §1.3: 7,721 people, about 13.5k ties), written straight to
 * PGlite for the scoring CPU bench and the nightly-run equivalence test. Deterministic: the same seed gives the same
 * rows. Shape: most people are LinkedIn connections with a current company drawn from a long-tailed list (a few big
 * employers, many small ones), some with a city, a school or past jobs; a few hundred are email contacts with threads
 * and meetings between them.
 */
import type { Db } from '../../functions/_shared/db.ts';

export interface BigNetworkShape {
  people: number;
  orgs: number;
  cities: number;
  schools: number;
  /** share of people with a current company, a city, a school, past jobs, an email address */
  withOrg: number;
  withCity: number;
  withSchool: number;
  withHistory: number;
  withEmail: number;
  threads: number;
  events: number;
}

export const OWNER_SHAPE: BigNetworkShape = {
  people: 7721,
  orgs: 8000,
  cities: 900,
  schools: 3000,
  withOrg: 0.45,
  withCity: 0.2,
  withSchool: 0.06,
  withHistory: 0.12,
  withEmail: 0.08,
  threads: 900,
  events: 250,
};

/** mulberry32 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** index in [0, n) with a long tail: a few values very common, most rare */
function zipf(r: () => number, n: number): number {
  return Math.min(n - 1, Math.max(0, Math.floor(n ** (r() ** 0.6)) - 1));
}

const SIZES = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001-10000', '10001+'];
const TITLES = [
  'Software Engineer',
  'Senior Software Engineer',
  'Product Manager',
  'Founder',
  'Analyst',
  'Associate',
  'Director of Engineering',
  'Designer',
  'Data Scientist',
  'Investor',
];

async function bulk(db: Db, sql: string, rows: unknown[]) {
  for (let i = 0; i < rows.length; i += 1000) await db.query(sql, [JSON.stringify(rows.slice(i, i + 1000))]);
}

export interface BigNetwork {
  personIds: string[];
  emailed: string[];
}

export async function seedBigNetwork(
  db: Db,
  userId: string,
  shape: BigNetworkShape = OWNER_SHAPE,
  seed = 7,
): Promise<BigNetwork> {
  const r = rng(seed);
  const orgs = Array.from({ length: shape.orgs }, (_, i) => ({
    name: `Company ${i}`,
    norm: `company ${i}`,
    size: SIZES[i < 20 ? 7 - (i % 3) : Math.floor(r() * 5)]!,
  }));
  await bulk(
    db,
    `insert into orbit.organizations (user_id, name, name_norm, size_bucket)
     select '${userId}'::uuid, x->>'name', x->>'norm', x->>'size' from jsonb_array_elements($1::jsonb) x`,
    orgs,
  );
  const people = Array.from({ length: shape.people }, (_, i) => {
    const org = r() < shape.withOrg ? orgs[zipf(r, shape.orgs)]!.name : null;
    const city = r() < shape.withCity ? `City ${zipf(r, shape.cities)}, ST` : null;
    const school = r() < shape.withSchool ? `School ${zipf(r, shape.schools)}` : null;
    const email = r() < shape.withEmail ? `p${i}@example.org` : null;
    return {
      name: `Person ${i} Test`,
      first: `Person${i}`,
      org,
      title: TITLES[Math.floor(r() * TITLES.length)],
      city,
      school,
      email,
      member: `ACo${seed}x${i}`,
      strength: Math.round(r() * 40) / 100,
    };
  });
  await bulk(
    db,
    `insert into orbit.people (user_id, display_name, first_name, last_name, name_norm, title, org_raw, location, school,
                               primary_email, linkedin_member_id, strength, sources, created_at)
     select '${userId}'::uuid, x->>'name', x->>'first', 'Test', lower(x->>'name'), x->>'title', x->>'org',
            x->>'city', x->>'school', x->>'email', x->>'member', (x->>'strength')::real, '{linkedin}',
            now() - interval '30 days'
       from jsonb_array_elements($1::jsonb) x`,
    people,
  );
  const ids = await db.sql<{ id: string; primary_email: string | null; org_raw: string | null }>`
    select id, primary_email, org_raw from orbit.people where user_id = ${userId}::uuid and not is_self
     order by display_name`;
  const personIds = ids.map((p) => p.id);
  const emailedRows = ids.filter((p) => p.primary_email);
  const emailed = emailedRows.map((p) => p.id);
  await bulk(
    db,
    `insert into orbit.person_identities (user_id, person_id, kind, value_norm, source)
     select '${userId}'::uuid, (x->>'id')::uuid, 'email', x->>'email', 'gmail' from jsonb_array_elements($1::jsonb) x`,
    emailedRows.map((p) => ({ id: p.id, email: p.primary_email })),
  );
  // past jobs and schools for a share of people
  const affs: Record<string, unknown>[] = [];
  for (const p of ids) {
    if (r() >= shape.withHistory) continue;
    if (p.org_raw)
      affs.push({
        id: p.id,
        kind: 'employment',
        org: p.org_raw,
        start: `${2015 + Math.floor(r() * 9)}-0${1 + Math.floor(r() * 9)}-01`,
        current: true,
      });
    const jobs = 1 + Math.floor(r() * 3);
    let year = 2008 + Math.floor(r() * 8);
    for (let j = 0; j < jobs; j++) {
      const len = 1 + Math.floor(r() * 4);
      affs.push({
        id: p.id,
        kind: 'employment',
        org: orgs[zipf(r, shape.orgs)]!.name,
        start: `${year}-0${1 + Math.floor(r() * 9)}-01`,
        end: `${year + len}-0${1 + Math.floor(r() * 9)}-01`,
        current: false,
      });
      year += len;
    }
    if (r() < 0.6)
      affs.push({
        id: p.id,
        kind: 'education',
        org: `School ${zipf(r, shape.schools)}`,
        start: `${2004 + Math.floor(r() * 10)}-09-01`,
        end: `${2008 + Math.floor(r() * 10)}-06-01`,
        current: false,
      });
  }
  await bulk(
    db,
    `insert into orbit.affiliations (user_id, person_id, kind, org_raw, start_date, end_date, is_current, source)
     select '${userId}'::uuid, (x->>'id')::uuid, x->>'kind', x->>'org', (x->>'start')::date, (x->>'end')::date,
            (x->>'current')::boolean, 'linkedin'
       from jsonb_array_elements($1::jsonb) x`,
    affs,
  );
  // small threads and meetings among the email contacts
  const pick = (n: number) => {
    const out = new Set<string>();
    while (out.size < n) out.add(emailed[Math.floor(r() * emailed.length)]!);
    return [...out];
  };
  const emailOf = new Map(emailedRows.map((p) => [p.id, p.primary_email!]));
  const threads: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];
  const day = 86_400_000;
  for (let i = 0; i < shape.threads && emailed.length >= 4; i++) {
    const parts = pick(2 + Math.floor(r() * 3));
    const at = Date.now() - Math.floor(r() * 900) * day;
    threads.push({
      ext: `t${i}`,
      parts,
      first: new Date(at).toISOString(),
      last: new Date(at + 2 * day).toISOString(),
    });
    for (let m = 0; m < 3; m++) {
      const from = m === 0 ? null : parts[Math.floor(r() * parts.length)]!;
      messages.push({
        thread: `t${i}`,
        ext: `t${i}m${m}`,
        dir: from ? 'in' : 'out',
        from,
        fromAddr: from ? emailOf.get(from) : 'me@example.com',
        to: parts.filter((x) => x !== from).map((x) => emailOf.get(x)),
        toIds: from ? [] : parts,
        at: new Date(at + m * 3_600_000).toISOString(),
      });
    }
  }
  await bulk(
    db,
    `insert into orbit.threads (user_id, provider, external_id, participant_person_ids, participant_count, first_at,
                                last_at, message_count, is_networking)
     select '${userId}'::uuid, 'gmail', x->>'ext', array(select jsonb_array_elements_text(x->'parts'))::uuid[],
            jsonb_array_length(x->'parts'), (x->>'first')::timestamptz, (x->>'last')::timestamptz, 3, true
       from jsonb_array_elements($1::jsonb) x`,
    threads,
  );
  await bulk(
    db,
    `insert into orbit.messages (user_id, thread_id, provider, external_id, direction, from_person_id, from_addr,
                                 to_addrs, to_person_ids, sent_at, body_text)
     select '${userId}'::uuid, t.id, 'gmail', x->>'ext', x->>'dir', (x->>'from')::uuid, x->>'fromAddr',
            array(select jsonb_array_elements_text(x->'to')), array(select jsonb_array_elements_text(x->'toIds'))::uuid[],
            (x->>'at')::timestamptz, 'hello'
       from jsonb_array_elements($1::jsonb) x
       join orbit.threads t on t.user_id = '${userId}'::uuid and t.external_id = x->>'thread'`,
    messages,
  );
  const events: Record<string, unknown>[] = [];
  for (let i = 0; i < shape.events && emailed.length >= 4; i++) {
    const parts = pick(2 + Math.floor(r() * 3));
    events.push({
      ext: `e${i}`,
      parts,
      emails: parts.map((x) => ({ email: emailOf.get(x), responseStatus: 'accepted' })),
      at: new Date(Date.now() - Math.floor(r() * 700) * day).toISOString(),
    });
  }
  await bulk(
    db,
    `insert into orbit.calendar_events (user_id, external_id, title, start_at, end_at, status, attendees,
                                        attendee_person_ids, attendee_count)
     select '${userId}'::uuid, x->>'ext', 'Coffee', (x->>'at')::timestamptz,
            (x->>'at')::timestamptz + interval '30 minutes', 'confirmed', x->'emails',
            array(select jsonb_array_elements_text(x->'parts'))::uuid[], jsonb_array_length(x->'parts')
       from jsonb_array_elements($1::jsonb) x`,
    events,
  );
  return { personIds, emailed };
}

/**
 * The email finding sequence, end to end against the database (an audit of 2026-11-24): who an added person becomes,
 * what a contact's address may teach about a company, what is said when a source could not be asked, how a wrong
 * address gives way to a better one, a connection's own LinkedIn address before anything built, and the caps under
 * lookups that run together. Every provider is a fake; nothing here reaches a real API.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reserveUsage } from '../../functions/_shared/budget.ts';
import { type AgentEnv, makeServices } from '../../functions/_shared/services.ts';
import {
  checkBuiltAddress,
  domainsFor,
  EMAIL_LOOKUP_DEADLINE_MS,
  findEmailFor,
  keepEmail,
  keepRealEmail,
  lookupPersonEmail,
  lookupWithin,
} from '../../functions/_shared/sourcing/ondemand.ts';
import { addSourced } from '../../functions/_shared/sourcing/run.ts';
import type { Candidate } from '../../functions/_shared/sourcing/search.ts';
import { pull } from '../../functions/orbit-api/sync.ts';
import { PULL_BY_NAME } from '../../functions/orbit-api/tables.ts';
import {
  addPerson,
  agentConfig,
  api,
  fakeNet,
  jsonRes,
  type NetCall,
  signedInUser,
  UNIPILE,
} from '../helpers/agents.ts';
import { freshDb, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});

const ENROW = 'https://api.enrow.io';
const REOON = 'https://emailverifier.reoon.com/api/v1/verify';

const services = (net: ReturnType<typeof fakeNet>, env: AgentEnv = {}) =>
  makeServices(agentConfig(net, env), { db: t.db });

const cand = (c: Partial<Candidate> & { name: string }): Candidate => ({
  key: `web:${c.name}`,
  entity: 'person',
  sources: ['web'],
  externalIds: {},
  ...c,
});

async function recommend(userId: string, c: Candidate): Promise<string> {
  const [r] = await t.db.sql<{ id: string }>`
    insert into orbit.recommendations (user_id, candidate, source, rank, batch_id)
    values (${userId}::uuid, ${c}::jsonb, 'web', 1, gen_random_uuid()) returning id`;
  return r!.id;
}

const personRow = async (id: string) =>
  (
    await t.db.sql<{
      primary_email: string | null;
      email_confidence: string | null;
      email_checked_at: Date | null;
    }>`select primary_email, email_confidence, email_checked_at from orbit.people where id = ${id}::uuid`
  )[0]!;

const setFound = (id: string, email: string, confidence: string) =>
  t.db
    .sql`update orbit.people set primary_email = ${email}, email_confidence = ${confidence} where id = ${id}::uuid`;

describe('1. adding a sourced person never joins a namesake', () => {
  it('a classmate David Kim does not get the investor David Kim’s address, chat or facts', async () => {
    const { userId } = await signedInUser(t);
    const classmate = await addPerson(t, userId, { name: 'David Kim', org: 'UC Berkeley' });
    const rec = await recommend(
      userId,
      cand({
        name: 'David Kim',
        org: 'Sequoia Capital',
        title: 'Partner',
        email: 'dkim@sequoiacap.com',
        emailConfidence: 'page',
        evidence: ['Invests in seed stage developer tools'],
      }),
    );
    const added = await addSourced(services(fakeNet()), userId, [rec]);
    const investor = added.people[0]!.id;
    expect(investor).not.toBe(classmate);
    expect(await personRow(classmate)).toMatchObject({ primary_email: null, email_confidence: null });
    expect(await personRow(investor)).toMatchObject({
      primary_email: 'dkim@sequoiacap.com',
      email_confidence: 'page',
    });
    const chats = await t.db.sql`select 1 from orbit.chats where person_id = ${classmate}::uuid`;
    const facts = await t.db.sql`select 1 from orbit.facts where person_id = ${classmate}::uuid`;
    expect(chats).toHaveLength(0);
    expect(facts).toHaveLength(0);
  });

  it('the same name at the same company, or the same LinkedIn profile, is still the person they have', async () => {
    const { userId } = await signedInUser(t);
    const dana = await addPerson(t, userId, { name: 'Dana Wu', org: 'Sequoia Capital' });
    const byOrg = await recommend(
      userId,
      cand({ name: 'Dana Wu', org: 'Sequoia Capital', title: 'Partner' }),
    );
    const lee = await addPerson(t, userId, {
      name: 'Lee Chan',
      linkedinUrl: 'https://www.linkedin.com/in/lee-chan-7',
    });
    const byProfile = await recommend(
      userId,
      cand({ name: 'Lee C.', org: 'Elsewhere', linkedinUrl: 'https://www.linkedin.com/in/lee-chan-7' }),
    );
    const added = await addSourced(services(fakeNet()), userId, [byOrg, byProfile]);
    expect(added.people.map((p) => p.id)).toEqual([dana, lee]);
  });
});

describe('2. a guess is shown as a guess', () => {
  it('the pull sends how a person’s address was found', async () => {
    const { userId } = await signedInUser(t);
    const jo = await addPerson(t, userId, { name: 'Jo Park', email: 'jo.park@beta.io' });
    await setFound(jo, 'jo.park@beta.io', 'guess');
    const own = await addPerson(t, userId, { name: 'Kim Roe', email: 'kim@beta.io' });
    const out = await pull(t.db, userId, {
      cursor: {},
      tables: [PULL_BY_NAME.get('people')!],
      limit: 100,
      upTo: new Date(Date.now() + 60_000),
    });
    const rows = (out.changes.people ?? []) as { id: string; emailConfidence?: string | null }[];
    expect(rows.find((r) => r.id === jo)?.emailConfidence).toBe('guess');
    expect(rows.find((r) => r.id === own)?.emailConfidence ?? null).toBeNull();
  });

  it('before a send, a guess the verifier cannot confirm is unconfirmed, never ok', async () => {
    const { userId } = await signedInUser(t);
    const reoon = (c: NetCall) => {
      if (!c.url.startsWith(REOON)) return undefined;
      const email = new URL(c.url).searchParams.get('email') ?? '';
      return jsonRes(200, { email, status: email.startsWith('good') ? 'safe' : 'catch_all' });
    };
    const check = async (
      email: string,
      confidence: string | null,
      env: AgentEnv = { reoonKey: 'reoon-placeholder' },
      checked = false,
    ) => {
      const id = await addPerson(t, userId, { name: `Al ${email.split('@')[0]}`, email });
      const out = await checkBuiltAddress(services(fakeNet(reoon), env), userId, {
        id,
        email,
        confidence,
        checkedAt: checked ? new Date() : null,
      });
      return { out, row: await personRow(id) };
    };
    // a server that takes any address: the message is not held, but the address is still a guess
    const catchAll = await check('al.one@catchall.example', 'guess');
    expect(catchAll.out).toBe('unconfirmed');
    expect(catchAll.row.email_checked_at).toBeTruthy();
    // no verifier at all
    expect((await check('al.two@nokey.example', 'pattern', {})).out).toBe('unconfirmed');
    // checked once before and never confirmed
    expect((await check('al.three@catchall.example', 'pattern', undefined, true)).out).toBe('unconfirmed');
    // confirmed, or not Orbit's guess in the first place
    expect((await check('good.one@beta.example', 'guess')).out).toBe('ok');
    expect((await check('al.four@own.example', null)).out).toBe('ok');
    expect((await check('al.five@bad.example', 'invalid')).out).toBe('invalid');
  });
});

describe('4 and 6. what a contact’s address teaches', () => {
  it('a contact’s university or personal domain is not their company’s', async () => {
    const { userId } = await signedInUser(t);
    // an intern at Stripe who writes from school, and a founder who writes from their own site
    await addPerson(t, userId, { name: 'Ana Ruiz', org: 'Stripe', email: 'ana.ruiz@berkeley.edu' });
    await addPerson(t, userId, { name: 'Bo Liu', org: 'Stripe', email: 'bo@boliu.dev' });
    const target = cand({ name: 'Maya Chen', org: 'Stripe' });
    expect(await domainsFor(t.db, userId, target)).toEqual([]);
    // a colleague's address at the company's own domain does teach it
    await addPerson(t, userId, { name: 'Cy Park', org: 'Stripe', email: 'cy.park@stripe.com' });
    expect(await domainsFor(t.db, userId, target)).toEqual(['stripe.com']);
  });

  it('a page that is not their company’s own site is left out, even on a row stored before the rule', async () => {
    const { userId } = await signedInUser(t);
    const inNews = cand({
      name: 'Maya Chen',
      org: 'Acme',
      url: 'https://techcrunch.com/2026/11/acme-raises',
      domains: ['techcrunch.com'],
    });
    expect(await domainsFor(t.db, userId, inNews)).toEqual([]);
    const onOwnSite = cand({ name: 'Maya Chen', org: 'Acme', url: 'https://www.acme.ai/team' });
    expect(await domainsFor(t.db, userId, onOwnSite)).toEqual(['acme.ai']);
  });

  it('addresses Orbit guessed do not become the pattern for the next person', async () => {
    const { userId } = await signedInUser(t);
    const s = services(fakeNet());
    const target = cand({ name: 'Maya Chen', org: 'Northwind', domains: ['northwind.example'] });
    for (const [name, email] of [
      ['Sam Lee', 'sam.lee@northwind.example'],
      ['Ana Ruiz', 'ana.ruiz@northwind.example'],
    ] as const) {
      const id = await addPerson(t, userId, { name, org: 'Northwind', email });
      await setFound(id, email, 'guess');
    }
    expect(await findEmailFor(s, userId, target, { freeOnly: true })).toBeUndefined();
    // the same two addresses from the student's own mail are evidence
    await t.db.sql`update orbit.people set email_confidence = null where user_id = ${userId}::uuid`;
    expect(await findEmailFor(s, userId, target, { freeOnly: true })).toEqual({
      email: 'maya.chen@northwind.example',
      confidence: 'pattern',
    });
  });
});

describe('5. a source that could not be asked is not a miss', () => {
  it('out of credits: "could not check", nothing remembered, and the next ask finds the address', async () => {
    let credits = false;
    const net = fakeNet((c) => {
      if (!c.url.startsWith(ENROW)) return undefined;
      if (!credits) return jsonRes(402, { message: 'no credits' });
      if (c.method === 'POST') return jsonRes(200, { id: 'enr_9' });
      return jsonRes(200, { email: 'tpatel@northwind.example', qualification: 'valid', credits_used: 1 });
    });
    const call = api(t, net, { env: { enrowKey: 'enrow-placeholder' } });
    const { userId, token } = await signedInUser(t);
    const tara = await addPerson(t, userId, { name: 'Tara Patel', org: 'Northwind' });
    await addPerson(t, userId, { name: 'Lee Chan', org: 'Northwind', email: 'lchan@northwind.example' });
    await addPerson(t, userId, { name: 'Ida Moss', org: 'Northwind', email: 'ida@northwind.example' });
    const first = await call<{ emailStatus: string }>('/source/email', token, { personId: tara });
    expect(first.body).toEqual({ emailStatus: 'could not check' });
    const cached = await t.db.sql`
      select 1 from orbit.research_cache where key like 'email:%tara.patel@northwind.example'`;
    expect(cached).toHaveLength(0);
    // a fresh function instance (the provider adapter remembers "out of credits" for the life of one)
    credits = true;
    const again = api(t, net, { env: { enrowKey: 'enrow-placeholder' } });
    const second = await again<{ email?: string; emailStatus: string }>('/source/email', token, {
      personId: tara,
    });
    expect(second.body).toMatchObject({ email: 'tpatel@northwind.example', emailStatus: 'found' });
  });

  it('a recommendation that could not be checked stays "not looked up" for a later try', async () => {
    const net = fakeNet((c) =>
      c.url.startsWith(ENROW) ? jsonRes(402, { message: 'no credits' }) : undefined,
    );
    const call = api(t, net, { env: { enrowKey: 'enrow-placeholder' } });
    const { userId, token } = await signedInUser(t);
    const rec = await recommend(
      userId,
      cand({ name: 'Uma Reyes', org: 'Globex', domains: ['globex.example'] }),
    );
    const r = await call<{ emailStatus: string }>('/source/email', token, { recommendationId: rec });
    expect(r.body).toEqual({ emailStatus: 'could not check' });
    const [row] = await t.db.sql<{ candidate: Candidate }>`
      select candidate from orbit.recommendations where id = ${rec}::uuid`;
    expect(row!.candidate.emailLookedUp).toBeUndefined();
  });
});

describe('8. a wrong address is not a dead end', () => {
  it('a verified address replaces a guess; any other address replaces one that failed; the student’s own stays', async () => {
    const { userId } = await signedInUser(t);
    const guessed = await addPerson(t, userId, { name: 'Jo Park', email: 'jo.park@beta.example' });
    await setFound(guessed, 'jo.park@beta.example', 'guess');
    // another guess does not replace a guess
    await keepEmail(t.db, userId, guessed, { email: 'jpark@beta.example', confidence: 'pattern' });
    expect((await personRow(guessed)).primary_email).toBe('jo.park@beta.example');
    await keepEmail(t.db, userId, guessed, { email: 'jo@beta.example', confidence: 'verified' });
    expect(await personRow(guessed)).toMatchObject({
      primary_email: 'jo@beta.example',
      email_confidence: 'verified',
    });

    const failed = await addPerson(t, userId, { name: 'Al Kim', email: 'al.kim@beta.example' });
    await t.db.sql`
      update orbit.people set email_confidence = 'invalid', email_checked_at = now() where id = ${failed}::uuid`;
    await keepEmail(t.db, userId, failed, { email: 'akim@beta.example', confidence: 'pattern' });
    expect(await personRow(failed)).toEqual({
      primary_email: 'akim@beta.example',
      email_confidence: 'pattern',
      email_checked_at: null,
    });

    const own = await addPerson(t, userId, { name: 'Kim Roe', email: 'kim@beta.example' });
    await keepEmail(t.db, userId, own, { email: 'kim.roe@beta.example', confidence: 'verified' });
    expect(await personRow(own)).toMatchObject({ primary_email: 'kim@beta.example', email_confidence: null });
  });

  it('an address from the student or the person replaces a guessed or failed one and is no longer marked a guess', async () => {
    const { userId } = await signedInUser(t);
    const jo = await addPerson(t, userId, { name: 'Jo Park', email: 'jo.park@beta.example' });
    await t.db.sql`
      update orbit.people set email_confidence = 'invalid', email_checked_at = now() where id = ${jo}::uuid`;
    expect(await keepRealEmail(t.db, userId, jo, 'Jo@Beta.example')).toBe(true);
    expect(await personRow(jo)).toEqual({
      primary_email: 'jo@beta.example',
      email_confidence: null,
      email_checked_at: null,
    });
    const al = await addPerson(t, userId, { name: 'Al Kim', email: 'al.kim@beta.example' });
    await setFound(al, 'al.kim@beta.example', 'guess');
    expect(await keepRealEmail(t.db, userId, al, 'al@beta.example')).toBe(true);
    expect(await personRow(al)).toMatchObject({ primary_email: 'al@beta.example', email_confidence: null });
    // an address from the student's own mail, or a verified one, is never overwritten this way
    const own = await addPerson(t, userId, { name: 'Kim Roe', email: 'kim@beta.example' });
    expect(await keepRealEmail(t.db, userId, own, 'other@beta.example')).toBe(false);
    expect((await personRow(own)).primary_email).toBe('kim@beta.example');
    await setFound(own, 'kim@beta.example', 'verified');
    expect(await keepRealEmail(t.db, userId, own, 'other@beta.example')).toBe(false);
    expect(await keepRealEmail(t.db, userId, jo, 'not an address')).toBe(false);
  });

  it('asking again for someone whose address failed looks again, and never hands the failed one back', async () => {
    const net = fakeNet((c) => {
      if (!c.url.startsWith(ENROW)) return undefined;
      if (c.method === 'POST') return jsonRes(200, { id: 'enr_3' });
      return jsonRes(200, { email: 'vera@initech.example', qualification: 'valid', credits_used: 1 });
    });
    const { userId } = await signedInUser(t);
    const s = services(net, { enrowKey: 'enrow-placeholder' });
    await addPerson(t, userId, { name: 'Lee Chan', org: 'Initech', email: 'lee.chan@initech.example' });
    await addPerson(t, userId, { name: 'Ida Moss', org: 'Initech', email: 'ida.moss@initech.example' });
    const vera = await addPerson(t, userId, { name: 'Vera Stone', org: 'Initech' });
    // the pattern-built address bounced
    await setFound(vera, 'vera.stone@initech.example', 'invalid');
    const r = await lookupPersonEmail(s, userId, vera);
    expect(r).toEqual({ email: 'vera@initech.example', emailConfidence: 'verified', emailStatus: 'found' });
    expect(await personRow(vera)).toMatchObject({
      primary_email: 'vera@initech.example',
      email_confidence: 'verified',
    });
  });
});

describe('9. a connection’s own LinkedIn address comes before anything built', () => {
  it('someone the student is connected to: the contact email from their profile, not the pattern', async () => {
    const views: string[] = [];
    const net = fakeNet((c) => {
      if (!c.url.startsWith(`${UNIPILE}/api/v1/users/`)) return undefined;
      views.push(c.url);
      return jsonRes(200, {
        provider_id: 'ACoAAB1',
        contact_info: { emails: ['hello@hooli.example', 'gia@giamoreno.example'] },
      });
    });
    const { userId } = await signedInUser(t);
    await t.db.sql`insert into orbit.integration_accounts (user_id, provider, external_account_id, status)
      values (${userId}::uuid, 'linkedin', 'acc-li', 'active')`;
    const s = services(net, { unipileKey: 'unipile-placeholder', unipileBase: UNIPILE });
    // two colleagues teach the pattern, so without LinkedIn the answer would be a built gia.moreno@
    await addPerson(t, userId, { name: 'Lee Chan', org: 'Hooli', email: 'lee.chan@hooli.example' });
    await addPerson(t, userId, { name: 'Ida Moss', org: 'Hooli', email: 'ida.moss@hooli.example' });
    const gia = await addPerson(t, userId, {
      name: 'Gia Moreno',
      org: 'Hooli',
      linkedinUrl: 'https://www.linkedin.com/in/gia-moreno',
    });
    await t.db.sql`update orbit.people set linkedin_connected_on = now() where id = ${gia}::uuid`;
    const r = await lookupPersonEmail(s, userId, gia);
    // the shared inbox on her profile is skipped: her own address is the one she shows
    expect(r).toEqual({
      email: 'gia@giamoreno.example',
      emailConfidence: 'verified',
      emailStatus: 'found',
    });
    expect(views).toHaveLength(1);

    // not a connection: the profile is never viewed, and the pattern answers
    const ned = await addPerson(t, userId, {
      name: 'Ned Vale',
      org: 'Hooli',
      linkedinUrl: 'https://www.linkedin.com/in/ned-vale',
    });
    expect(await lookupPersonEmail(s, userId, ned)).toMatchObject({
      email: 'ned.vale@hooli.example',
      emailConfidence: 'pattern',
    });
    expect(views).toHaveLength(1);
  });
});

describe('11. lookups that run together', () => {
  it('twelve reservations at once against a cap of ten: ten pass', async () => {
    const { userId } = await signedInUser(t);
    const entry = { userId, provider: 'enrow', operation: 'find', units: 1, costUsd: 0.017 };
    const all = await Promise.all(Array.from({ length: 12 }, () => reserveUsage(t.db, entry)));
    expect(all.filter((r) => r.ok)).toHaveLength(10);
    const [sum] = await t.db.sql<{ units: string }>`
      select coalesce(sum(units), 0)::text as units from orbit.usage_ledger
       where user_id = ${userId}::uuid and provider = 'enrow'`;
    expect(Number(sum!.units)).toBe(10);
    // a settled miss gives its credit back for the next call
    const one = all.find((r) => r.ok);
    if (one?.ok) await one.settle({ units: 0, operation: 'find:attempt' });
    expect((await reserveUsage(t.db, entry)).ok).toBe(true);
    expect((await reserveUsage(t.db, entry)).ok).toBe(false);
  });

  it('POST /source/email answers before the browser stops waiting', async () => {
    // the browser waits 25 s for any reply (apps/web orbitApi.ts REQUEST_TIMEOUT_MS)
    expect(EMAIL_LOOKUP_DEADLINE_MS).toBeLessThan(25_000);
    const never = new Promise<{ emailStatus: 'found' }>(() => undefined);
    expect(await lookupWithin(never, 20)).toEqual({ emailStatus: 'could not check' });
    const quick = Promise.resolve({ email: 'a@b.example', emailStatus: 'found' as const });
    expect(await lookupWithin(quick, 20)).toEqual({ email: 'a@b.example', emailStatus: 'found' });
    // a failure in time is still the caller's to answer (404, do not contact)
    await expect(lookupWithin(Promise.reject(new Error('no such person')), 20)).rejects.toThrow(
      'no such person',
    );
  });
});

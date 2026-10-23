import type { Person, User } from '@orbit/core';
import { newId } from '@orbit/core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../db/schema';
import { setConnectorsMockForTests } from '../integrations/connectorsMock';
import { setResearchUrlForTests } from '../integrations/researchProxy';
import { buildDraftContext } from './brief';
import {
  allowanceLine,
  briefStale,
  deleteBrief,
  expireBriefs,
  readAllowance,
  researchOpeners,
  researchSpend,
  setDemoResearchDelayForTests,
  startResearch,
} from './deepResearch';
import { loadDemo } from './demo';
import { writeRecord } from './enrichment/store';
import { mergePeople } from './people';

let user: User;
const URL = 'https://ref.supabase.co/functions/v1/orbit-research';

beforeAll(async () => {
  user = await loadDemo({ reset: true });
  setDemoResearchDelayForTests(0);
}, 90_000);

afterEach(() => {
  vi.restoreAllMocks();
  setConnectorsMockForTests(undefined);
  setResearchUrlForTests(undefined);
});

const factsOf = (dossierId: string) =>
  db.facts.where('[sourceTable+sourceId]').equals(['dossiers', dossierId]).toArray();

async function freshPerson(over: Partial<Person> = {}): Promise<Person> {
  const now = new Date().toISOString();
  const p: Person = {
    id: newId('p'),
    userId: user.id,
    displayName: 'Dana Liu',
    firstName: 'Dana',
    lastName: 'Liu',
    nameNormalized: 'dana liu',
    emails: [],
    currentTitle: 'Product Manager',
    currentOrganizationRaw: 'Ramp',
    linkedinUrl: 'https://www.linkedin.com/in/dana-liu-4b2',
    linkedinSlug: 'dana-liu-4b2',
    headline: 'Product Manager at Ramp',
    relationshipType: 'unknown',
    strength: 0.1,
    tags: [],
    sources: ['linkedin_csv'],
    createdAt: now,
    updatedAt: now,
    ...over,
  } as Person;
  await db.people.put(p);
  return p;
}

describe('deep research in the demo (sample briefs, no network)', () => {
  it('makes no brief until the student presses Deep research', async () => {
    expect(await db.dossiers.where('userId').equals(user.id).count()).toBe(0);
  });

  it('writes a sample brief for the person, counts it, and writes facts only from supported claims', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const before = await readAllowance(user);
    expect(before).toMatchObject({ used: 0, left: 15 });
    expect(allowanceLine(before)).toBe('Research · 15 left this month');
    const r = await startResearch(user, 'p1');
    expect(r).toMatchObject({ ok: true, status: 'ready' });
    if (!r.ok || r.status === 'queued') return;
    expect(r.dossier.research).toMatchObject({ kind: 'quick', sample: true, checked: true });
    expect(new Date(r.dossier.expiresAt).getTime() - Date.now()).toBeGreaterThan(89 * 86_400_000);
    expect(fetch).not.toHaveBeenCalled();
    expect((await readAllowance(user)).left).toBe(14);
    const facts = await factsOf(r.dossier.id);
    expect(facts.map((f) => f.type).sort()).toEqual([
      'background',
      'connection',
      'hook',
      'hook',
      'role_detail',
    ]);
    expect(facts.every((f) => f.personId === 'p1' && f.sourceTable === 'dossiers')).toBe(true);
    // asking again about the same person this month is not another brief
    await startResearch(user, 'p1');
    expect((await readAllowance(user)).left).toBe(14);
    expect(await factsOf(r.dossier.id)).toHaveLength(5);
  });

  it('Go deeper adds their company context, after the quick brief only', async () => {
    const early = await startResearch(user, 'p5', { kind: 'deeper' });
    expect(early).toMatchObject({ ok: false, reason: 'needs_quick' });
    await startResearch(user, 'p5');
    const r = await startResearch(user, 'p5', { kind: 'deeper' });
    if (!r.ok || r.status === 'queued') throw new Error('no brief');
    expect(r.dossier.research?.kind).toBe('deeper');
    const c = r.dossier.content as { company?: { text: string }[]; deeper?: string };
    expect(c.deeper).toBe('company');
    expect(c.company?.[0]?.text).toMatch(/Ramp/);
  });

  it('someone with little online gets the honest LinkedIn-only brief', async () => {
    const people = await db.people.where('userId').equals(user.id).toArray();
    const plain = people.find(
      (p) => !['p1', 'p5', 'p9'].includes(p.id) && p.currentOrganizationRaw && !p.doNotContact,
    )!;
    const r = await startResearch(user, plain.id);
    if (!r.ok || r.status === 'queued') throw new Error('no brief');
    expect((r.dossier.content as { who: string }).who).toMatch(/Not much is public about .+ beyond LinkedIn/);
  });

  it('never researches someone marked do-not-contact, and stores nothing', async () => {
    const p = await freshPerson({ doNotContact: true });
    const r = await startResearch(user, p.id);
    expect(r).toMatchObject({ ok: false, reason: 'do_not_contact' });
    expect(await db.dossiers.where('personId').equals(p.id).count()).toBe(0);
  });

  it('deleting a brief deletes the facts it wrote', async () => {
    const r = await startResearch(user, 'p9');
    if (!r.ok || r.status === 'queued') throw new Error('no brief');
    expect((await factsOf(r.dossier.id)).length).toBeGreaterThan(0);
    await deleteBrief(r.dossier.id);
    expect(await db.dossiers.get(r.dossier.id)).toBeUndefined();
    expect(await factsOf(r.dossier.id)).toEqual([]);
  });

  it('a brief past its 90 days goes, with its facts', async () => {
    const r = await startResearch(user, 'p9');
    if (!r.ok || r.status === 'queued') throw new Error('no brief');
    expect(await expireBriefs(user.id, new Date(Date.now() + 30 * 86_400_000))).toBe(0);
    expect(await expireBriefs(user.id, new Date(Date.now() + 91 * 86_400_000))).toBeGreaterThan(0);
    expect(await factsOf(r.dossier.id)).toEqual([]);
  });

  it('merging two researched people drops the merged one’s brief and its facts', async () => {
    const a = await freshPerson({ displayName: 'Dana Liu', linkedinSlug: undefined, linkedinUrl: undefined });
    const b = await freshPerson({ displayName: 'Dana Liu', linkedinSlug: undefined, linkedinUrl: undefined });
    const ra = await startResearch(user, a.id);
    const rb = await startResearch(user, b.id);
    if (!ra.ok || ra.status === 'queued' || !rb.ok || rb.status === 'queued') throw new Error('no brief');
    await mergePeople(user.id, a.id, b.id);
    expect(await db.dossiers.get(rb.dossier.id)).toBeUndefined();
    expect(await factsOf(rb.dossier.id)).toEqual([]);
    expect(await db.dossiers.get(ra.dossier.id)).toBeDefined();
  });

  it('only fully supported openers reach a first message, as its opening line', async () => {
    const p = await freshPerson();
    const r = await startResearch(user, 'p1');
    if (!r.ok || r.status === 'queued') throw new Error('no brief');
    const openers = await researchOpeners('p1');
    expect(openers.map((o) => o.ref)).toEqual([2, 3]);
    // a partly supported one is never offered
    const content = r.dossier.content as { openers: { support: string }[] };
    content.openers[0]!.support = 'partial';
    await db.dossiers.put({ ...r.dossier, content });
    expect((await researchOpeners('p1')).map((o) => o.ref)).toEqual([3]);
    const person = (await db.people.get('p1'))!;
    const ctx = await buildDraftContext(user, person, 'outreach', 'gmail');
    expect(ctx.researchOpener).toBe(
      content.openers[1] && (content.openers[1] as unknown as { text: string }).text,
    );
    // research facts never reach the template's own fact picking
    expect(ctx.facts.some((f) => f.sourceTable === 'dossiers')).toBe(false);
    expect(await researchOpeners(p.id)).toEqual([]);
  });

  it('Settings sees what it cost; the About tab only the count', async () => {
    const s = await researchSpend(user.id);
    expect(s.briefs).toBeGreaterThan(0);
    expect(s.usd).toBe(0);
  });
});

describe('deep research with LinkedIn connected (orbit-research)', () => {
  async function live() {
    setConnectorsMockForTests(false);
    setResearchUrlForTests(URL);
    await db.integrations.put({
      id: 'int_li_live',
      userId: user.id,
      provider: 'linkedin_live',
      externalAccountId: 'acc_9',
      accessToken: 'tok_9',
      status: 'active',
      scopes: [],
      syncState: {},
      connectedAt: new Date().toISOString(),
    });
  }

  const serverBrief = (checked: boolean) => ({
    ok: true,
    status: 'ready',
    costUsd: 0.19,
    allowance: { used: 3, limit: 15, left: 12, month: new Date().toISOString().slice(0, 7) },
    brief: {
      kind: 'quick',
      content: {
        who: 'Dana Liu is a PM at Ramp.',
        now: { role: 'Product Manager', org: 'Ramp', since: null, source_ids: ['S1'], support: 'full' },
        recently: [{ date: '2026', text: 'Wrote about spend limits.', source_ids: ['S2'], support: 'full' }],
        in_common: [],
        history: { first_contact: null, last_contact: null, summary: null },
        openers: [{ text: 'Your spend limits post stuck with me.', source_ids: ['S2'], support: 'full' }],
        careful: [],
        confidence: 'high',
      },
      sources: [
        {
          id: 'S1',
          kind: 'linkedin_profile',
          url: 'https://www.linkedin.com/in/dana-liu-4b2',
          title: 'LinkedIn profile',
        },
        { id: 'S2', kind: 'web', url: 'https://ramp.com/blog/x', title: 'Spend limits' },
      ],
      model: 'claude-opus-5-5',
      promptVersion: 'dossier-v2',
      notes: [],
      checked,
      strongPages: 1,
      provider: 'claude',
      costUsd: 0.19,
    },
  });

  it('sends the person, the profile Orbit already has and a short history, and keeps the brief here', async () => {
    await live();
    const p = await freshPerson();
    await db.affiliations.bulkPut([
      {
        id: newId('aff'),
        userId: user.id,
        personId: p.id,
        kind: 'employment',
        nameRaw: 'Ramp',
        title: 'Product Manager',
        isCurrent: true,
        startDate: '2024-01-01',
        source: 'linkedin_profile',
      },
      {
        id: newId('aff'),
        userId: user.id,
        personId: p.id,
        kind: 'employment',
        nameRaw: 'Capital One',
        title: 'APM',
        isCurrent: false,
        startDate: '2021-06-01',
        endDate: '2023-12-01',
        source: 'linkedin_profile',
      },
      {
        id: newId('aff'),
        userId: user.id,
        personId: p.id,
        kind: 'education',
        nameRaw: 'University of Michigan',
        isCurrent: false,
        source: 'linkedin_profile',
      },
    ] as never);
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(serverBrief(true)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const r = await startResearch(user, p.id);
    expect(r).toMatchObject({ ok: true, status: 'ready' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${URL}/quick`);
    const body = calls[0]!.body as {
      accountId: string;
      token: string;
      person: { name: string; org: string };
      profile: {
        experience: { company: string; current: boolean }[];
        education: { school: string }[];
        publicIdentifier: string;
      };
      student: { firstName: string };
      posts: unknown[];
    };
    expect(body).toMatchObject({
      accountId: 'acc_9',
      token: 'tok_9',
      person: { name: 'Dana Liu', org: 'Ramp' },
    });
    expect(body.profile.experience.map((e) => [e.company, e.current])).toEqual([
      ['Ramp', true],
      ['Capital One', false],
    ]);
    expect(body.profile.education.map((e) => e.school)).toEqual(['University of Michigan']);
    expect(body.profile.publicIdentifier).toBe('dana-liu-4b2');
    expect(body.student.firstName).toBe(user.firstName);
    if (!r.ok || r.status === 'queued') return;
    expect(r.dossier.research).toMatchObject({ kind: 'quick', checked: true, strongPages: 1 });
    expect(r.dossier.costUsd).toBe(0.19);
    // the server's count is what the About tab shows
    expect((await readAllowance(user)).left).toBe(12);
    expect((await factsOf(r.dossier.id)).map((f) => f.type).sort()).toEqual([
      'background',
      'hook',
      'role_detail',
    ]);
    expect((await researchSpend(user.id)).usd).toBeGreaterThanOrEqual(0.19);
  });

  it('a brief whose support check did not run writes no facts and offers no opener', async () => {
    await live();
    const p = await freshPerson();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(serverBrief(false)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const r = await startResearch(user, p.id);
    if (!r.ok || r.status === 'queued') throw new Error('no brief');
    expect(await factsOf(r.dossier.id)).toEqual([]);
    expect(await researchOpeners(p.id)).toEqual([]);
  });

  it('"which one?" is kept with its candidates, and the pick goes back as the anchor', async () => {
    await live();
    const p = await freshPerson({ linkedinUrl: undefined, linkedinSlug: undefined, headline: undefined });
    const bodies: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const b = JSON.parse(String(init?.body));
      bodies.push(b);
      const answer = b.chosen
        ? serverBrief(true)
        : {
            ok: true,
            status: 'needs_disambiguation',
            costUsd: 0.03,
            candidates: [
              { name: 'Dana Liu', org: 'Ramp', url: 'https://a.example' },
              { name: 'Dana Liu', org: 'Granite Law', url: 'https://b.example' },
            ],
          };
      return new Response(JSON.stringify(answer), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const first = await startResearch(user, p.id);
    expect(first).toMatchObject({ ok: true, status: 'needs_disambiguation' });
    // the profile is not sent for someone Orbit has no LinkedIn for
    expect(bodies[0]!.profile).toBeNull();
    const second = await startResearch(user, p.id, { candidateIndex: 1 });
    expect(bodies[1]!.chosen).toEqual({ org: 'Granite Law', url: 'https://b.example' });
    expect(second).toMatchObject({ ok: true, status: 'ready' });
  });

  it('says why when the server refuses, and keeps the month’s count it gave', async () => {
    await live();
    const p = await freshPerson();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          reason: 'limit',
          message: "You have used this month's 15 research briefs.",
          allowance: { used: 15, limit: 15, left: 0, month: new Date().toISOString().slice(0, 7) },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const r = await startResearch(user, p.id);
    expect(r).toMatchObject({ ok: false, reason: 'limit' });
    expect((await readAllowance(user)).left).toBe(0);
  });

  it('without LinkedIn connected, research is off and says how to turn it on', async () => {
    setConnectorsMockForTests(false);
    setResearchUrlForTests(URL);
    await db.integrations.delete('int_li_live');
    const p = await freshPerson();
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect(await startResearch(user, p.id)).toMatchObject({ ok: false, reason: 'connect_linkedin' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a brief is stale only once their LinkedIn shows a new job or headline', async () => {
    await live();
    const p = await freshPerson();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(serverBrief(true)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const r = await startResearch(user, p.id);
    if (!r.ok || r.status === 'queued') throw new Error('no brief');
    expect(await briefStale(p, r.dossier)).toBe(false);
    expect(await briefStale({ ...p, headline: 'Group PM at Stripe' }, r.dossier)).toBe(true);
    await writeRecord({
      userId: user.id,
      personId: p.id,
      fields: {},
      jobChange: {
        from: { company: 'Ramp' },
        to: { company: 'Stripe' },
        observedAt: new Date(Date.now() + 1000).toISOString(),
      },
    });
    expect(await briefStale(p, r.dossier)).toBe(true);
  });
});

/**
 * orbit-research (docs/plan/20) under Node with every upstream mocked: origins, the account token, the allowance per
 * LinkedIn account, do-not-contact, the removal list, the anchor rule, the caps, Go deeper and the cost log. The
 * Anthropic API is answered by request shape: the web search call, the page fetch call, the brief (the writing model) and
 * the support check (the fast model).
 */
import { describe, expect, it } from 'vitest';
import { memorySharedCache } from '../../functions/_shared/research/web';
import {
  accountToken,
  makeHandler,
  memoryStore,
  memoryTake,
  type ResearchDeps,
  suppressionKeys,
} from '../../functions/orbit-research/research.ts';
import { anthropicMessage, fakeNet, jsonRes, type NetCall } from '../helpers/agents.ts';

const KEY = 'service-role-key-for-tests';
const ORIGIN = 'https://tryorbit.today';
const NOW = new Date('2026-10-23T12:00:00Z');

type Req = {
  model: string;
  system: string | { text: string }[];
  messages: { role: string; content: string | unknown[] }[];
  tools?: { type: string; name: string; max_uses?: number }[];
  output_config?: { format?: unknown; effort?: string };
};
const sys = (r: Req) => (typeof r.system === 'string' ? r.system : r.system.map((s) => s.text).join('\n'));
const user = (r: Req) => String(r.messages[0]!.content);

/** Claude answering each of the four calls a brief makes; counts what was asked of it. */
function claude(opts: { webPages?: boolean } = {}) {
  const seen: { search: number; fetch: number; write: number; support: number; models: string[] } = {
    search: 0,
    fetch: 0,
    write: 0,
    support: 0,
    models: [],
  };
  const answer = (c: NetCall) => {
    if (!c.url.startsWith('https://api.anthropic.com/')) return undefined;
    const r = c.body as Req;
    seen.models.push(r.model);
    const tool = r.tools?.[0];
    if (tool?.name === 'web_search') {
      seen.search++;
      const queries = [...user(r).matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]!);
      return jsonRes(200, {
        ...anthropicMessage(null, { input_tokens: 25_000, output_tokens: 300 }),
        model: r.model,
        usage: {
          input_tokens: 25_000,
          output_tokens: 300,
          server_tool_use: { web_search_requests: queries.length },
        },
        content: [
          ...queries.map((q, i) => ({
            type: 'server_tool_use',
            id: `s${i}`,
            name: 'web_search',
            input: { query: q },
          })),
          ...queries.map((_q, i) => ({
            type: 'web_search_tool_result',
            tool_use_id: `s${i}`,
            content:
              opts.webPages === false
                ? []
                : [
                    {
                      type: 'web_search_result',
                      url: 'https://ramp.com/blog/card-controls',
                      title: 'How we built card controls at Ramp, by Dana Liu',
                      encrypted_content: 'x',
                    },
                    {
                      type: 'web_search_result',
                      url: 'https://www.spokeo.com/Dana-Liu',
                      title: 'Dana Liu',
                      encrypted_content: 'x',
                    },
                  ],
          })),
          { type: 'text', text: 'done' },
        ],
      });
    }
    if (tool?.name === 'web_fetch') {
      seen.fetch++;
      return jsonRes(200, {
        ...anthropicMessage(null),
        model: r.model,
        usage: { input_tokens: 8000, output_tokens: 200 },
        content: [
          {
            type: 'web_fetch_tool_result',
            tool_use_id: 'f1',
            content: {
              type: 'web_fetch_result',
              url: 'https://ramp.com/blog/card-controls',
              content: {
                type: 'document',
                title: 'How we built card controls at Ramp',
                source: {
                  type: 'text',
                  media_type: 'text/plain',
                  data: 'By Dana Liu, product manager at Ramp. We shipped spend limits in six weeks.',
                },
              },
            },
          },
          { type: 'text', text: 'done' },
        ],
      });
    }
    if (/You check a research brief/.test(sys(r))) {
      seen.support++;
      const ids = [...user(r).matchAll(/^(C\d+)\. /gm)].map((m) => m[1]!);
      return jsonRes(200, {
        ...anthropicMessage(
          { verdicts: ids.map((id) => ({ id, verdict: 'supported' })) },
          { input_tokens: 6000, output_tokens: 200 },
        ),
        model: r.model,
      });
    }
    seen.write++;
    const ids = [...user(r).matchAll(/\[(S\d+)\]|<source id="(S\d+)"/g)].map((m) => (m[1] ?? m[2])!);
    const web = ids.find((i) => i !== 'S1');
    return jsonRes(200, {
      ...anthropicMessage(
        {
          who: 'Dana Liu is a product manager at Ramp.',
          now: { role: 'Product Manager', org: 'Ramp', since: '', source_ids: ['S1'] },
          recently: web
            ? [{ date: '2026', text: 'Shipped spend limits in six weeks.', source_ids: [web] }]
            : [],
          in_common: [],
          history: { first_contact: '', last_contact: '', summary: '' },
          openers: web
            ? [{ text: 'Shipping spend limits in six weeks is a story I want to hear.', source_ids: [web] }]
            : [],
          careful: [],
          confidence: 'high',
          career: [],
          education: [],
          profiles: [],
          highlights: [],
          topics: [],
          company: [],
        },
        { input_tokens: 15_000, output_tokens: 2500 },
      ),
      model: r.model,
    });
  };
  return { answer, seen };
}

async function setup(over: Partial<ResearchDeps> = {}, opts: { webPages?: boolean } = {}) {
  const c = claude(opts);
  const net = fakeNet(c.answer);
  const store = memoryStore(() => NOW.getTime());
  const deps: ResearchDeps = {
    origins: (o) => o === ORIGIN,
    signingKey: KEY,
    salt: 'test',
    take: memoryTake(() => NOW.getTime()),
    store,
    cache: memorySharedCache(() => NOW.getTime()),
    anthropicKey: 'sk-ant-test',
    fetch: net.fetch,
    now: () => NOW,
    ...over,
  };
  const handler = makeHandler(deps);
  const token = await accountToken('acc_1', KEY);
  const post = async (path: string, body: Record<string, unknown>, origin = ORIGIN) => {
    const res = await handler(
      new Request(`https://ref.supabase.co/functions/v1/orbit-research${path}`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown> };
  };
  return { handler, post, store, net, seen: c.seen, token };
}

const person = (over: Record<string, unknown> = {}) => ({
  name: 'Dana Liu',
  firstName: 'Dana',
  lastName: 'Liu',
  title: 'Product Manager',
  org: 'Ramp',
  linkedinUrl: 'https://www.linkedin.com/in/dana-liu-4b2',
  ...over,
});
const body = (token: string, over: Record<string, unknown> = {}) => ({
  accountId: 'acc_1',
  token,
  person: person(),
  profile: {
    headline: 'Product Manager at Ramp',
    publicIdentifier: 'dana-liu-4b2',
    experience: [{ title: 'Product Manager', company: 'Ramp', current: true }],
  },
  history: 'student → them: hello',
  student: { firstName: 'Sam', context: 'Sam, Michigan', goalSentence: 'find a PM internship' },
  ...over,
});

describe('orbit-research', () => {
  it('only Orbit origins, only POST, only its routes; unconfigured without the service key', async () => {
    const s = await setup();
    expect((await s.post('/quick', body(s.token), 'https://evil.example')).status).toBe(403);
    const pre = await s.handler(
      new Request('https://ref.supabase.co/functions/v1/orbit-research/quick', {
        method: 'OPTIONS',
        headers: { origin: ORIGIN },
      }),
    );
    expect(pre.status).toBe(204);
    expect((await s.post('/nope', {})).status).toBe(404);
    const bare = await setup({ signingKey: undefined });
    const r = await bare.post('/quick', body(bare.token));
    expect(r.status).toBe(503);
    expect(r.headers.get('x-orbit-connector')).toBe('unconfigured');
  });

  it('refuses a browser without the LinkedIn account token orbit-connectors handed out', async () => {
    const s = await setup();
    const r = await s.post('/quick', body('forged-token'));
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe('not_linked');
    expect(s.net.calls).toHaveLength(0);
  });

  it('writes a quick brief: the fast model searches and reads, the writing model writes and the fast model checks; one of 15 counted, cost logged', async () => {
    const s = await setup();
    const r = await s.post('/quick', body(s.token));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      status: 'ready',
      allowance: { used: 1, limit: 15, left: 14, month: '2026-10' },
    });
    const brief = r.body.brief as {
      sources: { url: string }[];
      content: { openers: { support: string }[]; now: { since: unknown } };
      costUsd: number;
      checked: boolean;
    };
    expect(brief.sources.map((x) => x.url)).toEqual([
      'https://www.linkedin.com/in/dana-liu-4b2',
      'https://ramp.com/blog/card-controls',
    ]);
    expect(brief.checked).toBe(true);
    expect(brief.content.openers[0]!.support).toBe('full');
    // the model's blank "since" is stored as none
    expect(brief.content.now.since).toBeNull();
    expect(s.seen).toMatchObject({ search: 1, fetch: 1, write: 1, support: 1 });
    expect(s.seen.models).toEqual([
      'claude-haiku-5-5',
      'claude-haiku-5-5',
      'claude-opus-5-5',
      'claude-haiku-5-5',
    ]);
    // the fetch never asked for the blocked people-search page
    const fetchCall = s.net.calls.find((c) => (c.body as Req).tools?.[0]?.name === 'web_fetch')!;
    expect(user(fetchCall.body as Req)).not.toContain('spokeo');
    expect(brief.costUsd).toBeGreaterThan(0.1);
    expect(brief.costUsd).toBeLessThanOrEqual(0.3);
    // the cost log has hashes and numbers only: no names, no brief
    expect(s.store.runs).toHaveLength(1);
    const run = s.store.runs[0]!;
    expect(run).toMatchObject({ kind: 'quick', status: 'ready' });
    expect(JSON.stringify(run)).not.toMatch(/Dana|Ramp|acc_1/);
    expect(run.cost_usd).toBe(brief.costUsd);
  });

  it('asking again about the same person this month is not counted again, and the cache makes it nearly free', async () => {
    const s = await setup();
    await s.post('/quick', body(s.token));
    const again = await s.post('/quick', body(s.token));
    expect(again.body.allowance).toMatchObject({ used: 1, left: 14 });
    // the searches and the page came from the shared cache: only writing and checking were paid again
    expect(s.seen).toMatchObject({ search: 1, fetch: 1, write: 2, support: 2 });
  });

  it('stops at 15 different people a month', async () => {
    const s = await setup({ perMonth: 2 });
    const one = (n: number) =>
      body(s.token, {
        person: person({ name: `Dana Liu${n}`, linkedinUrl: `https://www.linkedin.com/in/d-${n}` }),
        profile: null,
      });
    expect((await s.post('/quick', one(1))).body.allowance).toMatchObject({ used: 1 });
    expect((await s.post('/quick', one(2))).body.allowance).toMatchObject({ used: 2, left: 0 });
    const third = await s.post('/quick', one(3));
    expect(third.body).toMatchObject({ ok: false, reason: 'limit', allowance: { used: 2, left: 0 } });
  });

  it('never researches someone marked do-not-contact, and makes no call', async () => {
    const s = await setup();
    const r = await s.post('/quick', body(s.token, { doNotContact: true }));
    expect(r.body).toMatchObject({ ok: false, reason: 'do_not_contact' });
    expect(s.net.calls).toHaveLength(0);
    expect(s.store.uses.size).toBe(0);
  });

  it('the public remove-me request puts them on the removal list; research refuses them after that', async () => {
    const s = await setup();
    const bad = await s.post('/remove', { name: 'Dana Liu' });
    expect(bad.status).toBe(400);
    const ok = await s.post('/remove', {
      name: 'Dana Liu',
      linkedinUrl: 'https://www.linkedin.com/in/dana-liu-4b2',
    });
    expect(ok.body).toMatchObject({ ok: true });
    // kept as hashes only
    expect([...s.store.suppressions].every((k) => /^[0-9a-f]{64}$/.test(k))).toBe(true);
    const r = await s.post('/quick', body(s.token));
    expect(r.body).toMatchObject({ ok: false, reason: 'suppressed' });
    expect(s.net.calls).toHaveLength(0);
    // a namesake with another LinkedIn profile is not affected
    const other = await s.post(
      '/quick',
      body(s.token, {
        person: person({ linkedinUrl: 'https://www.linkedin.com/in/another-dana' }),
        profile: null,
      }),
    );
    expect(other.body.status).toBe('ready');
    expect(await suppressionKeys({ name: 'Dana Liu', orgs: ['Ramp Inc.'] })).toEqual(
      await suppressionKeys({ name: 'dana liu', orgs: ['Ramp'] }),
    );
  });

  it('with no LinkedIn and no company, spends nothing and counts nothing: it asks for one', async () => {
    const s = await setup();
    const r = await s.post('/quick', body(s.token, { person: { name: 'Dana Liu' }, profile: null }));
    expect(r.body).toMatchObject({ ok: true, status: 'needs_anchor' });
    expect(s.net.calls).toHaveLength(0);
    expect(s.store.uses.size).toBe(0);
  });

  it('Go deeper needs the quick brief first, and stays within $0.50 for both', async () => {
    const s = await setup();
    const first = await s.post('/deeper', body(s.token));
    expect(first.body).toMatchObject({ ok: false, reason: 'needs_quick' });
    const quick = await s.post('/quick', body(s.token));
    const deeper = await s.post('/deeper', body(s.token));
    expect(deeper.body).toMatchObject({ ok: true, allowance: { used: 1 } });
    const b = deeper.body.brief as { kind: string; costUsd: number; content: { deeper?: string } };
    expect(b.kind).toBe('deeper');
    expect(b.content.deeper).toBe('person');
    expect((quick.body.brief as { costUsd: number }).costUsd + b.costUsd).toBeLessThanOrEqual(0.5);
    expect(s.store.runs.map((r) => r.kind)).toEqual(['quick', 'deeper']);
  });

  it('holds every student together to the daily dollar cap', async () => {
    const s = await setup({ usdPerDay: 0.1 });
    await s.post('/quick', body(s.token));
    const r = await s.post(
      '/quick',
      body(s.token, {
        person: person({ name: 'Sam Lee', linkedinUrl: 'https://www.linkedin.com/in/sam-lee' }),
      }),
    );
    expect(r.body).toMatchObject({ ok: false, reason: 'busy' });
  });

  it('says how many are left without researching anything', async () => {
    const s = await setup();
    const r = await s.post('/status', { accountId: 'acc_1', token: s.token });
    expect(r.body).toMatchObject({
      ok: true,
      allowance: { used: 0, left: 15 },
      providers: { exa: false, claude: true },
    });
    expect(s.net.calls).toHaveLength(0);
  });

  it('unconfigured without the Anthropic key', async () => {
    const s = await setup({ anthropicKey: undefined });
    const r = await s.post('/quick', body(s.token));
    expect(r.status).toBe(503);
    expect(r.body.reason).toBe('unconfigured');
  });

  it('with nothing on the web, the brief says so honestly and still counts as the month’s brief', async () => {
    const s = await setup({}, { webPages: false });
    const r = await s.post('/quick', body(s.token));
    const b = r.body.brief as { content: { who: string }; strongPages: number };
    expect(b.strongPages).toBe(0);
    expect(b.content.who).toMatch(/Not much is public about Dana beyond LinkedIn/);
  });
});

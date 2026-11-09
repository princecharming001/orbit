import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setConnectorsMockForTests } from './connectorsMock';
import { readPosting } from './postings';
import { setUnipileUrlForTests } from './unipile';

/** The server's answer to /posting, as the proxy would give it. */
const answering = (body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe('reading a job link in the app', () => {
  beforeEach(() => {
    setConnectorsMockForTests(false);
    setUnipileUrlForTests('https://proxy.test');
  });
  afterEach(() => {
    setConnectorsMockForTests(undefined);
    setUnipileUrlForTests(undefined);
  });

  it('a job link the server could not make out still targets the company the site names', async () => {
    const r = await readPosting(
      'u1',
      { url: 'https://neuralink.com/careers/apply/?gh_jid=5663271003' },
      { fetch: answering({ ok: false, reason: 'not_a_posting', message: 'x' }) },
    );
    expect(r).toMatchObject({ ok: true, source: 'typed', posting: { company: 'Neuralink' } });
  });

  it('a page that is not a job link, a careers list and a closed job keep their own answers', async () => {
    for (const [url, reason] of [
      ['https://blog.example.com/post/7', 'not_a_posting'],
      ['https://stripe.com/careers', 'careers_list'],
      ['https://acme.com/careers/apply/?gh_jid=9999999', 'closed'],
    ] as const) {
      const r = await readPosting('u1', { url }, { fetch: answering({ ok: false, reason, message: 'm' }) });
      expect(r).toMatchObject({ ok: false, reason });
    }
  });

  it("passes the board's answer through", async () => {
    const posting = {
      company: 'Neuralink',
      role: 'Machine Learning Engineer',
      namesOnPage: { recruiters: [], managers: [] },
    };
    const r = await readPosting(
      'u1',
      { url: 'https://neuralink.com/careers/apply/?gh_jid=5663271003' },
      { fetch: answering({ ok: true, source: 'board', posting }) },
    );
    expect(r).toMatchObject({ ok: true, source: 'board', posting: { role: 'Machine Learning Engineer' } });
  });
});

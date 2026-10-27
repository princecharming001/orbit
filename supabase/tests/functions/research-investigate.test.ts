/**
 * The investigator loop (functions/_shared/research/investigate.ts): wide searches from every anchor, pages read
 * straight from their sites, the fast model's reading of each page (them or not, what it says, what to search next),
 * follow-up rounds from the leads, accounts from usernames they published, and the brief written from the facts.
 * Search engines, sites and the model are fakes.
 */
import { describe, expect, it } from 'vitest';
import type { SearchEngine, WebHit } from '../../functions/_shared/providers/webSearch';
import { runBrief } from '../../functions/_shared/research/brief';
import type { ClaudeDep } from '../../functions/_shared/research/deps';
import { distinctiveSlug, findAccounts, HANDLE_SITES } from '../../functions/_shared/research/handles';
import { identityCard } from '../../functions/_shared/research/identity';
import { followUps, investigate, widePlan } from '../../functions/_shared/research/investigate';
import { htmlToText, profileHandle, profileLinks } from '../../functions/_shared/research/pageText';
import { memorySharedCache } from '../../functions/_shared/research/web';

const profile = {
  headline: 'Finance @ NYU Stern',
  location: 'New York, New York',
  publicIdentifier: 'bhavya-mehta-8a4148231',
  experience: [
    { title: 'Investment Banking Intern', company: 'Craft Capital Management', current: true, start: '2026' },
  ],
  education: [
    { school: 'NYU Stern School of Business', start: '2025', end: '2029' },
    { school: 'Washington High School', start: '2021', end: '2025' },
  ],
};
/** today: a fake clock at 0 would read 1970, when a 2029 graduate looks like a minor */
const T = Date.parse('2026-10-27T10:00:00Z');

const card = () =>
  identityCard({
    name: 'Bhavya Mehta',
    linkedinUrl: 'https://www.linkedin.com/in/bhavya-mehta-8a4148231',
    profile,
  });

const page = (title: string, body: string, links = '') =>
  `<html><head><title>${title}</title><script>var x = "Bhavya Mehta secret"</script></head><body><nav>Home</nav><p>${body}</p>${links}</body></html>`;

/** A web of four pages: the DECA chapter (theirs), the scholars society (found only from a lead), a namesake, and noise. */
const SITES: Record<string, string> = {
  'https://whsdeca.org/legacy': page(
    'Washington High School DECA',
    'Bhavya Mehta, Washington High School senior, served as California DECA Team 74 VP of Marketing.',
    '<a href="https://github.com/bhavyacodes">GitHub</a><a href="https://github.com/about">About GitHub</a>',
  ),
  'https://nshss.org/scholars': page(
    'NSHSS Scholars',
    'Congratulations to Bhavya Mehta of Washington High School, named a National Society of High School Scholars member.',
  ),
  'https://dentist.example/team': page(
    'Dr. Bhavya Mehta, DDS - Toronto',
    'Dr. Bhavya Mehta has practiced dentistry in Toronto since 1998.',
  ),
  'https://github.com/bhavyacodes': page(
    'bhavyacodes (Bhavya Mehta) · GitHub',
    'Bhavya Mehta. Finance and CS at NYU Stern. Projects: stock screener.',
  ),
};

function fakeFetch(): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === 'https://api.github.com/users/bhavyacodes')
      return new Response('{"login":"bhavyacodes"}', { status: 200 });
    const html = SITES[url];
    if (!html) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }) as typeof fetch & { calls: string[] };
  f.calls = calls;
  return f;
}

function engine(
  name: 'parallel' | 'serper',
  answer: (qs: string[]) => WebHit[] | 'fail',
): SearchEngine & {
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    name,
    configured: true,
    usdPerCall: 0.001,
    queriesPerCall: name === 'parallel' ? 5 : 1,
    calls,
    async search(queries) {
      calls.push(queries);
      const a = answer(queries);
      if (a === 'fail') return { ok: false, kind: 'http', provider: name, message: 'out of credit' } as never;
      return { ok: true, value: a };
    },
  };
}

/** Hits for a set of queries: the wide round finds DECA, the namesake and noise; the lead finds the scholars page. */
function hitsFor(queries: string[]): WebHit[] {
  const hits: WebHit[] = [];
  for (const q of queries) {
    if (/National Society of High School Scholars/i.test(q))
      hits.push({
        url: 'https://nshss.org/scholars',
        title: 'NSHSS Scholars',
        snippet: 'Bhavya Mehta, Washington High School',
      });
    else if (/Washington High School/.test(q) || q === '"Bhavya Mehta"')
      hits.push(
        {
          url: 'https://whsdeca.org/legacy',
          title: 'Washington High School DECA',
          snippet: 'Bhavya Mehta, Team 74 VP of Marketing',
        },
        {
          url: 'https://dentist.example/team',
          title: 'Dr. Bhavya Mehta, DDS',
          snippet: 'Bhavya Mehta, dentist in Toronto',
        },
        { url: 'https://noise.example/x', title: 'Something else', snippet: 'Nothing about anyone' },
      );
  }
  return hits;
}

/** The fast model's reading of each page, keyed by the address in the prompt. */
function fakeClaude(): ClaudeDep & { tasks: string[] } {
  const tasks: string[] = [];
  return {
    tasks,
    async parse(task, _schema, prompt) {
      tasks.push(task);
      if (task === 'extract') {
        const u = /url: (\S+)/.exec(prompt.user)?.[1] ?? '';
        if (u.includes('whsdeca'))
          return {
            ok: true,
            costUsd: 0.0004,
            value: {
              match: 'yes',
              why: 'Washington High School, her school',
              facts: [
                {
                  text: 'Served as California DECA Team 74 VP of Marketing',
                  date: '2025',
                  quote: 'California DECA Team 74 VP of Marketing',
                },
                { text: 'Her family moved to Fremont in 2015', date: '2015', quote: 'family moved' },
              ],
              leads: ['National Society of High School Scholars', 'DECA'],
            },
          } as never;
        if (u.includes('nshss'))
          return {
            ok: true,
            costUsd: 0.0004,
            value: {
              match: 'yes',
              why: 'Washington High School',
              facts: [
                {
                  text: 'Named a National Society of High School Scholars member',
                  date: '',
                  quote: 'named a National Society of High School Scholars member',
                },
              ],
              leads: [],
            },
          } as never;
        if (u.includes('github.com/bhavyacodes'))
          return {
            ok: true,
            costUsd: 0.0004,
            value: {
              match: 'likely',
              why: 'NYU Stern fits',
              facts: [{ text: 'Built a stock screener', date: '', quote: 'Projects: stock screener' }],
              leads: [],
            },
          } as never;
        return {
          ok: true,
          costUsd: 0.0004,
          value: { match: 'no', why: 'a dentist in Toronto since 1998', facts: [], leads: [] },
        } as never;
      }
      if (task === 'brief')
        return {
          ok: true,
          costUsd: 0.02,
          value: {
            who: 'Bhavya Mehta studies finance at NYU Stern.',
            now: {
              role: 'Investment Banking Intern',
              org: 'Craft Capital Management',
              since: '',
              source_ids: ['S1'],
            },
            recently: [],
            in_common: [],
            history: { first_contact: '', last_contact: '', summary: '' },
            openers: [],
            careful: [],
            confidence: 'medium',
            highlights: [
              {
                kind: 'award',
                title: 'DECA Team 74 VP of Marketing',
                date: '2025',
                url: '',
                summary: '',
                source_ids: ['S2'],
              },
            ],
          },
        } as never;
      if (task === 'support') return { ok: true, costUsd: 0.001, value: { verdicts: [] } } as never;
      return { ok: false, reason: 'error' };
    },
  };
}

describe('the investigator loop', () => {
  it('searches from every anchor, high school included, and the kinds of pages niche facts live on', () => {
    const qs = widePlan(card(), 'Investment Banking Intern');
    expect(qs).toContain('"Bhavya Mehta"');
    expect(qs).toContain('"Bhavya Mehta" Washington High School');
    expect(qs).toContain('"Bhavya Mehta" NYU Stern School of Business');
    expect(qs.some((q) => q.includes('site:instagram.com'))).toBe(true);
    expect(qs.some((q) => /award OR officer/.test(q))).toBe(true);
    expect(qs.length).toBeLessThanOrEqual(16);
  });

  it('turns leads into new searches with their name, never one already run or their name alone', () => {
    const c = card();
    const ran = new Set(['"bhavya mehta" deca']);
    expect(
      followUps(c, ['DECA', 'National Society of High School Scholars', 'Bhavya Mehta', 'x'], ran),
    ).toEqual(['"Bhavya Mehta" National Society of High School Scholars']);
  });

  it('finds the niche record: reads pages from their sites, keeps theirs, drops the namesake, follows the lead', async () => {
    const parallel = engine('parallel', hitsFor);
    const serper = engine('serper', hitsFor);
    const f = fakeFetch();
    const claude = fakeClaude();
    const now = 0;
    const r = await investigate(
      { engines: [parallel, serper], claude, cache: memorySharedCache(), fetch: f, clock: () => now },
      {
        card: card(),
        profile: 'Education: Washington High School (2021–2025)',
        title: 'Investment Banking Intern',
      },
      { rounds: 2, budgetUsd: 0.15, deadline: 120_000 },
    );
    const urls = r.pages.map((p) => p.url);
    expect(urls).toContain('https://whsdeca.org/legacy');
    // found only by following the DECA page's lead
    expect(urls).toContain('https://nshss.org/scholars');
    expect(r.queries).toContain('"Bhavya Mehta" National Society of High School Scholars');
    // the dentist in Toronto has their name and nothing else of theirs
    expect(urls).not.toContain('https://dentist.example/team');
    expect(r.pages.find((p) => p.url.includes('whsdeca'))?.match).toBe('yes');
    // a sensitive fact the page states never reaches the brief
    expect(r.pages.flatMap((p) => p.facts.map((x) => x.text)).join(' ')).not.toMatch(/family/i);
    // their own GitHub link on their page: the account is read and judged like any page
    expect(r.accounts).toContain('https://github.com/bhavyacodes');
    expect(r.pages.find((p) => p.url === 'https://github.com/bhavyacodes')?.match).toBe('likely');
    // pages were read straight from their sites, operator queries went to Serper, the rest to Parallel in batches
    expect(f.calls).toContain('https://whsdeca.org/legacy');
    expect(serper.calls.every((c) => c.length === 1 && /site:| OR /.test(c[0]!))).toBe(true);
    expect(parallel.calls.every((c) => c.length <= 5)).toBe(true);
    expect(r.costUsd).toBeLessThan(0.05);
    expect(claude.tasks.every((t) => t === 'extract')).toBe(true);
  });

  it('Parallel out of credit: Serper takes its queries', async () => {
    const parallel = engine('parallel', () => 'fail');
    const serper = engine('serper', hitsFor);
    const r = await investigate(
      {
        engines: [parallel, serper],
        claude: fakeClaude(),
        cache: memorySharedCache(),
        fetch: fakeFetch(),
        clock: () => 0,
      },
      { card: card(), profile: '' },
      { rounds: 0, budgetUsd: 0.15, deadline: 120_000 },
    );
    expect(r.pages.map((p) => p.url)).toContain('https://whsdeca.org/legacy');
    expect(serper.calls.some((c) => c[0] === '"Bhavya Mehta"')).toBe(true);
    expect(r.notes.join(' ')).toMatch(/parallel search failed/);
  });

  it('a second run reads everything back from the shared cache for nothing', async () => {
    const cache = memorySharedCache();
    const deps = () => ({
      engines: [engine('parallel', hitsFor), engine('serper', hitsFor)],
      claude: fakeClaude(),
      cache,
      fetch: fakeFetch(),
      clock: () => 0,
    });
    const input = { card: card(), profile: '' };
    const first = await investigate(deps(), input, { rounds: 1, budgetUsd: 0.15, deadline: 120_000 });
    const d2 = deps();
    const second = await investigate(d2, input, { rounds: 1, budgetUsd: 0.15, deadline: 120_000 });
    expect(second.pages.map((p) => p.url).sort()).toEqual(first.pages.map((p) => p.url).sort());
    expect(second.costUsd).toBe(0);
    expect(d2.claude.tasks).toEqual([]);
  });

  it('the brief is written on the mid model from the facts, and a likely page is marked as likely', async () => {
    const claude = fakeClaude();
    const out = await runBrief(
      {
        web: [],
        claude,
        clock: () => T,
        engines: [engine('parallel', hitsFor), engine('serper', hitsFor)],
        cache: memorySharedCache(),
        fetch: fakeFetch(),
      },
      {
        kind: 'quick',
        person: { name: 'Bhavya Mehta', linkedinUrl: 'https://www.linkedin.com/in/bhavya-mehta-8a4148231' },
        profile,
        student: {
          firstName: 'Anish',
          context: 'Berkeley junior',
          goalSentence: 'find a finance internship',
        },
      },
      { capUsd: 0.3, deadline: T + 85_000 },
    );
    expect(out.status === 'ready' || out.status === 'partial').toBe(true);
    if (out.status !== 'ready' && out.status !== 'partial') return;
    expect(out.provider).toBe('investigate');
    expect(claude.tasks).toContain('brief');
    expect(claude.tasks).not.toContain('dossier');
    const titles = out.sources.map((s) => s.title ?? '');
    expect(titles.some((t) => t.startsWith('[likely them]'))).toBe(true);
    expect(out.sources.map((s) => s.url)).toContain('https://whsdeca.org/legacy');
    expect(out.costUsd).toBeLessThan(0.1);
  });
});

describe('their accounts (handles.ts)', () => {
  it('checks only a distinctive LinkedIn address', () => {
    expect(distinctiveSlug('vaibhavhariram')).toBe('vaibhavhariram');
    expect(distinctiveSlug('zion-darko-8a0b78190')).toBeUndefined();
    expect(distinctiveSlug('danaliu')).toBeUndefined();
  });

  it("finds an account by the site's own rule and never a payment or dating site", async () => {
    const found = await findAccounts(['bhavyacodes'], { fetch: fakeFetch() });
    expect(found.map((a) => a.url)).toEqual(['https://github.com/bhavyacodes']);
    expect(HANDLE_SITES.map((s) => s.name.toLowerCase()).join(' ')).not.toMatch(
      /paypal|venmo|cash|tinder|onlyfans/,
    );
  });
});

describe('reading pages (pageText.ts)', () => {
  it("keeps the page's words, not its scripts or navigation, and its own profile links", () => {
    const html = SITES['https://whsdeca.org/legacy']!;
    const t = htmlToText(html);
    expect(t.title).toBe('Washington High School DECA');
    expect(t.text).toContain('Team 74 VP of Marketing');
    expect(t.text).not.toContain('secret');
    expect(profileLinks(html, 'https://whsdeca.org/legacy')).toEqual(['https://github.com/bhavyacodes']);
    expect(profileHandle('https://github.com/about')).toBeUndefined();
    expect(profileHandle('https://www.instagram.com/zion.darko/')).toBe('zion.darko');
  });
});

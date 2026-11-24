/**
 * Plan 44 §4: each roles reader against trimmed captures of the real services (2026-11-24, companies renamed), with
 * paging, backoff and typed failures; links read into boards; and intake's parsing (places, countries, term, pay,
 * language, text) with no database.
 */
import { describe, expect, it } from 'vitest';
import { POSTING_USER_AGENT } from '../../functions/_shared/postings.ts';
import { careersLinkIn, siteOf } from '../../functions/_shared/roles/discover.ts';
import {
  cleanText,
  countriesOf,
  familyOf,
  intake,
  languageOf,
  payFromText,
  splitPlaces,
  TEXT_CAP,
  titleKey,
} from '../../functions/_shared/roles/intake.ts';
import { readAshby } from '../../functions/_shared/roles/readers/ashby.ts';
import { boardLinksIn, boardOfUrl } from '../../functions/_shared/roles/readers/boardUrls.ts';
import { readGreenhouse, readGreenhouseJob } from '../../functions/_shared/roles/readers/greenhouse.ts';
import { askJson } from '../../functions/_shared/roles/readers/http.ts';
import { readLever } from '../../functions/_shared/roles/readers/lever.ts';
import { linkedinJob, linkedinJobSearch } from '../../functions/_shared/roles/readers/linkedin.ts';
import { readRecruitee } from '../../functions/_shared/roles/readers/recruitee.ts';
import { simplifyListing } from '../../functions/_shared/roles/readers/simplify.ts';
import {
  readSmartRecruiters,
  readSmartRecruitersJob,
} from '../../functions/_shared/roles/readers/smartrecruiters.ts';
import { readWorkable } from '../../functions/_shared/roles/readers/workable.ts';
import { readWorkday, readWorkdayJob, workdayPosted } from '../../functions/_shared/roles/readers/workday.ts';
import { fakeBoards, fixture, json } from '../helpers/fakeBoards.ts';

const NOW = new Date('2026-11-24T12:00:00Z');
const net = (f: ReturnType<typeof fakeBoards>) => ({ fetch: f.fetch, now: () => NOW, sleep: f.sleep });

describe('the shared request', () => {
  it('sends the posting user agent, backs off on 429 and 5xx, and reads the answer', async () => {
    let n = 0;
    const f = fakeBoards([
      () => {
        n++;
        if (n === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '2' } });
        if (n === 2) return new Response('oops', { status: 503 });
        return json({ ok: true });
      },
    ]);
    const seen: string[] = [];
    const doFetch = (async (u: string, init: RequestInit) => {
      seen.push(String((init.headers as Record<string, string>)['user-agent']));
      return f.fetch(u, init);
    }) as typeof fetch;
    const start = f.clock();
    const got = await askJson(
      { fetch: doFetch, now: () => NOW, sleep: f.sleep },
      'https://api.example.test/x',
    );
    expect(got).toMatchObject({ ok: true, value: { ok: true } });
    expect(seen.every((s) => s === POSTING_USER_AGENT)).toBe(true);
    // Retry-After (2 s), then 3 s
    expect(f.clock() - start).toBe(5000);
  });

  it('never throws: a dead site, a 404, a 403 and an answer too large are typed failures', async () => {
    const thrower = (async () => {
      throw new Error('connect refused');
    }) as typeof fetch;
    const s = async () => {};
    expect(
      await askJson({ fetch: thrower, now: () => NOW, sleep: s }, 'https://a.example.test/'),
    ).toMatchObject({
      ok: false,
      reason: 'network',
    });
    const f = fakeBoards([
      (u) => (u.pathname === '/gone' ? new Response('', { status: 404 }) : undefined),
      (u) => (u.pathname === '/no' ? new Response('', { status: 403 }) : undefined),
      (u) => (u.pathname === '/big' ? new Response('x'.repeat(5000)) : undefined),
      () => new Response('', { status: 429 }),
    ]);
    expect(await askJson(net(f), 'https://a.example.test/gone')).toMatchObject({
      reason: 'not_found',
      status: 404,
    });
    expect(await askJson(net(f), 'https://a.example.test/no')).toMatchObject({ reason: 'refused' });
    expect(await askJson(net(f), 'https://a.example.test/big', { maxBytes: 1000 })).toMatchObject({
      reason: 'too_large',
    });
    expect(await askJson(net(f), 'https://a.example.test/busy')).toMatchObject({ reason: 'rate_limited' });
  });
});

describe('Greenhouse', () => {
  it('lists the board without text, with the company name, language and updated time', async () => {
    const f = fakeBoards([
      (u) => (u.pathname === '/v1/boards/nimbuspay/jobs' ? json(fixture('greenhouse-list.json')) : undefined),
    ]);
    const r = await readGreenhouse(net(f), 'nimbuspay');
    expect(f.calls[0]!.url).toBe('https://boards-api.greenhouse.io/v1/boards/nimbuspay/jobs');
    if (!r.ok) throw new Error(r.message);
    expect(r.companyName).toBe('Nimbus Pay');
    expect(r.complete).toBe(true);
    expect(r.listings).toHaveLength(10);
    const intern = r.listings.find((l) => l.externalId === '8186367')!;
    expect(intern).toMatchObject({
      source: 'greenhouse',
      companyName: 'Nimbus Pay',
      title: 'Integration Reliability Engineer Intern, Technical Operations',
      locations: ['Singapore'],
      language: 'en',
    });
    expect(intern.text).toBeUndefined();
    expect(intern.meta?.updatedAt).toBeTruthy();
  });

  it('reads one role with its text, for EU boards on their own host', async () => {
    const f = fakeBoards([
      (u) =>
        u.hostname === 'boards-api.eu.greenhouse.io' && u.pathname === '/v1/boards/nimbuspay/jobs/8172510'
          ? json(fixture('greenhouse-job.json'))
          : undefined,
    ]);
    const r = await readGreenhouseJob(net(f), 'eu:nimbuspay', '8172510');
    if (!r.ok) throw new Error(r.message);
    expect(r.value.team).toBe('8611 Security Analytics');
    expect(r.value.text).toMatch(/Nimbus Pay/);
    expect(r.value.text).not.toMatch(/&lt;|<h2>/);
  });
});

describe('Lever', () => {
  it('reads in pages of 50 until a short page, with text from the description, lists and closing', async () => {
    const page = fixture<Record<string, unknown>[]>('lever-page.json');
    const full = Array.from({ length: 50 }, (_, i) => ({
      ...page[i % 3]!,
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    }));
    const f = fakeBoards([
      (u) =>
        u.hostname === 'api.lever.co' && u.pathname === '/v0/postings/halcyon'
          ? json(u.searchParams.get('skip') === '0' ? full : page)
          : undefined,
    ]);
    const r = await readLever(net(f), 'halcyon', 'Halcyon');
    if (!r.ok) throw new Error(r.message);
    expect(f.calls.map((c) => new URL(c.url).searchParams.get('skip'))).toEqual(['0', '50']);
    expect(r.listings).toHaveLength(53);
    const fellow = r.listings.find((l) => l.externalId === '0ccbe620-a3ef-41d1-a5c4-68e56b3c91d0')!;
    expect(fellow).toMatchObject({
      companyName: 'Halcyon',
      team: 'Business Development',
      remote: 'remote',
      locations: ['North America'],
    });
    expect(fellow.text!.length).toBeGreaterThan(200);
    expect(fellow.meta?.commitment).toBe('Scholarship');
  });

  it('a board that answers 404 is a typed failure', async () => {
    const f = fakeBoards([]);
    const r = await readLever(net(f), 'nobody', 'Nobody');
    expect(r).toMatchObject({ ok: false, reason: 'not_found' });
  });
});

describe('Ashby', () => {
  it('reads the board whole, unlisted roles left out, with pay', async () => {
    const f = fakeBoards([
      (u) => (u.hostname === 'api.ashbyhq.com' ? json(fixture('ashby-board.json')) : undefined),
    ]);
    const r = await readAshby(net(f), 'quarry', 'Quarry');
    if (!r.ok) throw new Error(r.message);
    expect(f.calls[0]!.url).toContain('includeCompensation=true');
    expect(r.listings).toHaveLength(3);
    const swe = r.listings.find((l) => l.title === 'Software Engineer, Security, Cloud')!;
    expect(swe.pay).toMatchObject({ min: 211400, max: 290600, currency: 'USD', per: 'year' });
    expect(swe.locations).toEqual(['New York, NY (HQ)', 'Remote (Canada)', 'Remote (US)', 'Miami, FL']);
    expect(swe.remote).toBe('hybrid');
    expect(swe.text).toMatch(/Quarry/);
  });

  it('a board larger than the worker can read is too_large, with its size', async () => {
    const f = fakeBoards([
      (u) => (u.hostname === 'api.ashbyhq.com' ? json(fixture('ashby-board.json')) : undefined),
    ]);
    const r = await readAshby(net(f), 'quarry', 'Quarry', 2000);
    expect(r).toMatchObject({ ok: false, reason: 'too_large' });
    expect(r.ok ? 0 : (r.bytes ?? 0)).toBeGreaterThan(2000);
  });
});

describe('Workday', () => {
  it('pages by 20 with the total from the first page, a path place for "N Locations", dates from "Posted ..."', async () => {
    const page = fixture<{ total: number; jobPostings: Record<string, unknown>[] }>('workday-page.json');
    const twenty = {
      total: 25,
      jobPostings: Array.from({ length: 20 }, (_, i) => ({
        ...page.jobPostings[i % 5]!,
        externalPath: `/job/US-CA-Santa-Clara/Role-${i}_JR${1000 + i}`,
      })),
    };
    const f = fakeBoards([
      (u, init) => {
        if (u.hostname !== 'lumen.wd5.myworkdayjobs.com' || init.method !== 'POST') return undefined;
        const offset = JSON.parse(String(init.body)).offset as number;
        return json(offset === 0 ? twenty : { total: 0, jobPostings: page.jobPostings });
      },
    ]);
    const r = await readWorkday(net(f), 'lumen.wd5.myworkdayjobs.com/lumen/LumenExternalCareerSite', 'Lumen');
    if (!r.ok) throw new Error(r.message);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]!.url).toBe(
      'https://lumen.wd5.myworkdayjobs.com/wday/cxs/lumen/LumenExternalCareerSite/jobs',
    );
    expect(JSON.parse(f.calls[1]!.body!)).toEqual({
      appliedFacets: {},
      limit: 20,
      offset: 20,
      searchText: '',
    });
    expect(r.complete).toBe(true);
    const sre = r.listings.find((l) => l.externalId === 'lumen/LumenExternalCareerSite/JR2029097')!;
    expect(sre.locations).toEqual([]);
    expect(sre.meta).toMatchObject({
      locationsText: '2 Locations',
      path: '/job/Israel-Tel-Aviv/Senior-SRE-Engineer_JR2029097',
    });
    const trainer = r.listings.find((l) => l.externalId.endsWith('JR2030345'))!;
    expect(trainer.locations).toEqual(['Santa Clara, CA, US']);
    expect(sre.postedAt).toBe('2026-11-24T00:00:00.000Z');
    expect(workdayPosted('Posted 30+ Days Ago', NOW)).toBe('2026-10-25T00:00:00.000Z');
  });

  it('stops at its page cap and says the read is incomplete', async () => {
    const page = fixture<{ jobPostings: Record<string, unknown>[] }>('workday-page.json');
    const f = fakeBoards([
      (u, init) => {
        if (init.method !== 'POST') return undefined;
        const offset = JSON.parse(String(init.body)).offset as number;
        return json({
          total: 2000,
          jobPostings: Array.from({ length: 20 }, (_, i) => ({
            ...page.jobPostings[0]!,
            externalPath: `/job/X/R_${offset + i}`,
          })),
        });
      },
    ]);
    const r = await readWorkday(net(f), 'big.wd1.myworkdayjobs.com/big/Site', 'Big', 3);
    if (!r.ok) throw new Error(r.message);
    expect(r.listings).toHaveLength(60);
    expect(r.complete).toBe(false);
  });

  it('reads a role detail: text, every place, how it is worked', async () => {
    const f = fakeBoards([
      (u) =>
        u.pathname ===
        '/wday/cxs/lumen/LumenExternalCareerSite/job/Israel-Tel-Aviv/Senior-SRE-Engineer_JR2029097'
          ? json(fixture('workday-job.json'))
          : undefined,
    ]);
    const r = await readWorkdayJob(
      net(f),
      'lumen.wd5.myworkdayjobs.com/lumen/LumenExternalCareerSite',
      '/job/Israel-Tel-Aviv/Senior-SRE-Engineer_JR2029097',
    );
    if (!r.ok) throw new Error(r.message);
    expect(r.value.places).toEqual(['Israel, Tel Aviv', 'Israel, Yokneam']);
    expect(r.value.remote).toBe('hybrid');
    expect(r.value.text).toMatch(/Kubernetes/);
  });

  it('backs off on 429 and fails typed when the site keeps refusing', async () => {
    const f = fakeBoards([() => new Response('<html>429</html>', { status: 429 })]);
    const r = await readWorkday(net(f), 'busy.wd1.myworkdayjobs.com/busy/Site', 'Busy');
    expect(r).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(f.calls).toHaveLength(3);
  });
});

describe('SmartRecruiters, Workable, Recruitee', () => {
  it('SmartRecruiters: postings in pages of 100, text from the job ad', async () => {
    const f = fakeBoards([
      (u) =>
        u.pathname === '/v1/companies/VelvetMediaLLC/postings'
          ? json(fixture('smartrecruiters-page.json'))
          : undefined,
      (u) =>
        u.pathname === '/v1/companies/VelvetMediaLLC/postings/743999659136348'
          ? json(fixture('smartrecruiters-job.json'))
          : undefined,
    ]);
    const r = await readSmartRecruiters(net(f), 'VelvetMediaLLC');
    if (!r.ok) throw new Error(r.message);
    expect(r.listings).toHaveLength(3);
    expect(r.listings[0]).toMatchObject({
      externalId: 'VelvetMediaLLC/743999659136348',
      companyName: 'Velvet Media, LLC',
      title: 'Editorial Assistant',
      locations: ['London, England, United Kingdom'],
      url: 'https://jobs.smartrecruiters.com/VelvetMediaLLC/743999659136348',
      language: 'en',
    });
    expect(r.listings[0]!.meta?.employment).toBe('Intern');
    const job = await readSmartRecruitersJob(net(f), 'VelvetMediaLLC', '743999659136348');
    if (!job.ok) throw new Error(job.message);
    expect(job.value.text.length).toBeGreaterThan(100);
    expect(job.value.title).toBe('Editorial Assistant');
  });

  it('SmartRecruiters: an unknown company id is an empty board, not a failure', async () => {
    const f = fakeBoards([() => json({ offset: 0, limit: 100, totalFound: 0, content: [] })]);
    const r = await readSmartRecruiters(net(f), 'visa');
    expect(r).toMatchObject({ ok: true, listings: [], complete: true });
  });

  it('Workable: the v3 search by POST, paged by nextPage', async () => {
    const page = fixture<{ results: unknown[] }>('workable-page.json');
    const f = fakeBoards([
      (u, init) => {
        if (u.pathname !== '/api/v3/accounts/lanternai/jobs' || init.method !== 'POST') return undefined;
        const body = JSON.parse(String(init.body));
        return json(
          body.token
            ? { results: page.results.slice(2), nextPage: null }
            : { results: page.results.slice(0, 2), nextPage: 'NEXT' },
        );
      },
    ]);
    const r = await readWorkable(net(f), 'lanternai', 'Lantern AI');
    if (!r.ok) throw new Error(r.message);
    expect(f.calls).toHaveLength(2);
    expect(JSON.parse(f.calls[1]!.body!).token).toBe('NEXT');
    expect(r.listings).toHaveLength(3);
    expect(r.listings[1]).toMatchObject({
      externalId: 'lanternai/2EC9909936',
      locations: ['New York, New York, United States'],
      remote: 'remote',
      url: 'https://apply.workable.com/lanternai/j/2EC9909936/',
    });
  });

  it('Recruitee: every offer with its text, places, level code and degree', async () => {
    const f = fakeBoards([
      (u) =>
        u.hostname === 'borealislabs.recruitee.com' ? json(fixture('recruitee-offers.json')) : undefined,
    ]);
    const r = await readRecruitee(net(f), 'borealislabs');
    if (!r.ok) throw new Error(r.message);
    expect(r.listings).toHaveLength(3);
    const intern = r.listings[1]!;
    expect(intern).toMatchObject({
      externalId: 'borealislabs/intern-researcher-mathematical-foundations-of-differentiable-world-models',
      companyName: 'Borealis Labs Ltd.',
      level: 'intern',
      remote: 'on_site',
    });
    expect(intern.locations[0]).toMatch(/Montreal/);
    expect(r.listings[0]!.degrees).toEqual(["Bachelor's"]);
    expect(r.listings[0]!.text).toMatch(/Borealis/);
  });
});

describe('SimplifyJobs', () => {
  it('keeps only active, visible entries, with term, sponsorship, degrees and the board role it repeats', () => {
    const intern = fixture<Record<string, unknown>[]>('simplify-intern.json');
    const out = intern.map((x) => simplifyListing(x, 'intern'));
    expect(out.filter(Boolean)).toHaveLength(
      intern.filter((x) => x.active === true && x.is_visible !== false).length,
    );
    expect(out[out.length - 1]).toBeUndefined();
    expect(intern[intern.length - 1]!.active).toBe(false);
    const gh = out[0]!;
    expect(gh).toMatchObject({
      source: 'simplify',
      level: 'intern',
      employment: 'internship',
      term: 'Summer 2026',
      degrees: ["Master's"],
      meta: { list: 'intern', boardRef: 'greenhouse:4993728008' },
    });
    expect(gh.postedAt).toMatch(/^2026-/);
    const noSponsor = out.find((l) => l?.meta?.sponsorshipNote === 'Does Not Offer Sponsorship')!;
    expect(noSponsor.sponsorship).toBe('none');
    const citizens = out.find((l) => l?.meta?.citizenship)!;
    expect(citizens).toMatchObject({
      sponsorship: 'none',
      meta: { sponsorshipNote: 'U.S. Citizenship is Required' },
    });
    const lever = out.find((l) => l?.url.includes('lever.co'))!;
    expect(lever.meta?.boardRef).toBe('lever:418b3949-3b21-48f9-b7a0-1c036ca0ba51');
    const wd = out.find((l) => l?.url.includes('myworkdayjobs'))!;
    expect(wd.meta?.boardRef).toBe('workday:board5/Careersboard6/JR107037');
  });

  it('the new grad list has no term and no level until intake reads the title', () => {
    const ng = fixture<Record<string, unknown>[]>('simplify-newgrad.json');
    const l = simplifyListing(ng[1]!, 'newgrad')!;
    expect(l.level).toBeUndefined();
    expect(l.term).toBeUndefined();
    expect(l.meta?.list).toBe('newgrad');
  });
});

describe('LinkedIn through Unipile (fakes only)', () => {
  const access = { base: 'https://api9.unipile.test/', apiKey: 'test-key', accountId: 'acc-1' };
  it('one job search: the request Orbit makes and the listings it reads', async () => {
    const f = fakeBoards([
      (u) => (u.pathname === '/api/v1/linkedin/search' ? json(fixture('linkedin-search.json')) : undefined),
    ]);
    const seen: Record<string, string>[] = [];
    const doFetch = (async (u: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return f.fetch(u, init);
    }) as typeof fetch;
    const r = await linkedinJobSearch({ fetch: doFetch, now: () => NOW, sleep: f.sleep }, access, {
      keywords: 'software engineer intern',
      seniority: ['intern', 'entry'],
      jobType: ['internship'],
      datePosted: 7,
      limit: 25,
    });
    if (!r.ok) throw new Error(r.message);
    const u = new URL(f.calls[0]!.url);
    expect(u.toString()).toBe('https://api9.unipile.test/api/v1/linkedin/search?account_id=acc-1&limit=25');
    expect(seen[0]!['X-API-KEY']).toBe('test-key');
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({
      api: 'classic',
      category: 'jobs',
      keywords: 'software engineer intern',
      sort_by: 'date',
      seniority: ['intern', 'entry'],
      job_type: ['internship'],
      date_posted: 7,
    });
    expect(r.value).toHaveLength(3);
    expect(r.value[0]).toMatchObject({
      source: 'linkedin',
      externalId: '4478635358',
      companyName: 'Orchard Streaming',
      companyLinkedinId: '165158',
      locations: ['Los Gatos, CA'],
      remote: 'on_site',
      url: 'https://www.linkedin.com/jobs/view/4478635358',
    });
    expect(r.value[2]).toMatchObject({ locations: ['United States'], remote: 'remote' });
  });

  it("one job's text", async () => {
    const f = fakeBoards([
      (u) =>
        u.pathname === '/api/v1/linkedin/jobs/4478635358' ? json(fixture('linkedin-job.json')) : undefined,
    ]);
    const r = await linkedinJob(net(f), access, '4478635358');
    if (!r.ok) throw new Error(r.message);
    expect(r.value).toMatchObject({
      title: 'Software Engineer Intern - Summer 2027',
      companyName: 'Orchard Streaming',
      state: 'active',
    });
    expect(r.value.text).toMatch(/data structures/);
  });
});

describe('links to boards', () => {
  it.each([
    [
      'https://job-boards.greenhouse.io/acme/jobs/4993728008',
      { service: 'greenhouse', token: 'acme', externalId: '4993728008' },
    ],
    [
      'https://boards.eu.greenhouse.io/acme/jobs/123456',
      { service: 'greenhouse', token: 'eu:acme', externalId: '123456' },
    ],
    ['https://boards.greenhouse.io/embed/job_board?for=acme', { service: 'greenhouse', token: 'acme' }],
    [
      'https://www.acme.example/careers?gh_jid=5386005003',
      { service: 'greenhouse', token: '', externalId: '5386005003' },
    ],
    [
      'https://jobs.lever.co/acme/418b3949-3b21-48f9-b7a0-1c036ca0ba51/apply',
      { service: 'lever', token: 'acme', externalId: '418b3949-3b21-48f9-b7a0-1c036ca0ba51' },
    ],
    ['https://jobs.eu.lever.co/acme', { service: 'lever', token: 'eu:acme' }],
    [
      'https://jobs.ashbyhq.com/acme/71168628-1998-47d3-87a9-be7bc56a430d/application',
      { service: 'ashby', token: 'acme', externalId: '71168628-1998-47d3-87a9-be7bc56a430d' },
    ],
    [
      'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Engineer_JR123',
      {
        service: 'workday',
        token: 'nvidia.wd5.myworkdayjobs.com/nvidia/NVIDIAExternalCareerSite',
        externalId: 'nvidia/NVIDIAExternalCareerSite/JR123',
        path: '/job/US-CA-Santa-Clara/Engineer_JR123',
      },
    ],
    [
      'https://acme.wd1.myworkdayjobs.com/External',
      { service: 'workday', token: 'acme.wd1.myworkdayjobs.com/acme/External' },
    ],
    [
      'https://jobs.smartrecruiters.com/Visa/744000130799419-software-engineer',
      { service: 'smartrecruiters', token: 'Visa', externalId: 'Visa/744000130799419' },
    ],
    [
      'https://apply.workable.com/acme/j/FD4C9770FF/',
      { service: 'workable', token: 'acme', externalId: 'acme/FD4C9770FF' },
    ],
    [
      'https://acme.recruitee.com/o/co-op-engineer',
      { service: 'recruitee', token: 'acme', externalId: 'acme/co-op-engineer' },
    ],
  ])('%s', (url, want) => {
    expect(boardOfUrl(url)).toMatchObject(want);
  });

  it('is nothing for other sites', () => {
    expect(boardOfUrl('https://www.linkedin.com/jobs/view/1')).toBeUndefined();
    expect(boardOfUrl('not a link')).toBeUndefined();
  });

  it('reads the board a careers page names most, embed scripts included', () => {
    const page = `<a href="https://jobs.lever.co/other">x</a>
      <script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>
      <a href="https://boards.greenhouse.io/acme/jobs/123456">Role</a>`;
    expect(boardLinksIn(page)[0]!.link).toEqual({ service: 'greenhouse', token: 'acme' });
    expect(careersLinkIn('<a class="nav" href="/company/careers">Careers</a>', 'https://acme.example/')).toBe(
      'https://acme.example/company/careers',
    );
    expect(siteOf('https://www.Acme.com/about')).toBe('acme.com');
    expect(siteOf('gmail.com')).toBeUndefined();
    expect(siteOf('cs.stanford.edu')).toBeUndefined();
  });
});

describe('intake parsing', () => {
  it('splits places written in one string', () => {
    expect(splitPlaces(['San Francisco, CA; New York, NY'])).toEqual(['San Francisco, CA', 'New York, NY']);
    expect(splitPlaces(['Seattle, San Francisco, New York City'])).toEqual([
      'Seattle',
      'San Francisco',
      'New York City',
    ]);
    expect(splitPlaces(['San Francisco, CA, New York, NY'])).toEqual(['San Francisco, CA', 'New York, NY']);
    expect(splitPlaces(['Fremont, California, United States'])).toEqual([
      'Fremont, California, United States',
    ]);
    expect(splitPlaces(['SF, NYC, SEA, CHI'])).toEqual(['SF', 'NYC', 'SEA', 'CHI']);
    expect(splitPlaces(['New York, NY (HQ)', 'Remote (US)'])).toEqual(['New York, NY', 'Remote (US)']);
    expect(splitPlaces(['London | Dublin'])).toEqual(['London', 'Dublin']);
    expect(splitPlaces(['N/A'])).toEqual([]);
  });

  it('reads countries from places', () => {
    expect(countriesOf(['San Francisco, CA', 'London, United Kingdom'])).toEqual(['US', 'GB']);
    expect(countriesOf(['Remote (US)'])).toEqual(['US']);
    expect(countriesOf(['Singapore'], 'SG')).toEqual(['SG']);
  });

  it('reads pay only when it is written plainly', () => {
    expect(payFromText('The base salary range is $148,000 - $287,500 USD.')).toEqual({
      min: 148000,
      max: 287500,
      currency: 'USD',
      per: 'year',
    });
    expect(payFromText('Pay: $45 - $60 per hour')).toEqual({
      min: 45,
      max: 60,
      currency: 'USD',
      per: 'hour',
    });
    expect(payFromText('$120K–$160K')).toEqual({ min: 120000, max: 160000, currency: 'USD', per: 'year' });
    expect(payFromText('We raised $40M from investors in 2024')).toBeUndefined();
    expect(payFromText('Revenue grew from $1 to $3 billion')).toBeUndefined();
  });

  it('tells English from other languages', () => {
    expect(
      languageOf(
        'Software Engineer',
        'You will work with our team on the payments platform and build the tools that our users rely on every day. We are looking for an engineer who is excited to learn and to grow with us, and to own projects from the start to the end of their life.',
      ),
    ).toBe('en');
    expect(
      languageOf(
        'Ingeniero de Software',
        'Buscamos una persona para el equipo de pagos de la empresa, con experiencia en sistemas distribuidos y en el desarrollo de servicios para los clientes de la región. Trabajarás con el equipo de producto y con los ingenieros de la plataforma en la ciudad de Madrid.',
      ),
    ).toBe('other');
    expect(languageOf('Werkstudent Softwareentwicklung')).toBe('other');
    expect(languageOf('Software Engineer')).toBeUndefined();
  });

  it('keys titles and cleans text to its cap', () => {
    expect(titleKey('Software Engineer Intern (Summer 2027)')).toBe(
      titleKey('Software Engineer Intern - Summer 2027'),
    );
    expect(titleKey('R&D Engineer')).toBe('r and d engineer');
    const long = cleanText(`<p>${'word '.repeat(3000)}</p>`)!;
    expect(long.length).toBeLessThanOrEqual(TEXT_CAP);
    expect(long).not.toMatch(/<p>/);
  });

  it('reads the family from the title, then the team or category', () => {
    expect(familyOf('Data Scientist')).toBe('data_ml');
    expect(familyOf('Product Designer, Terminal')).toBe('design');
    expect(familyOf('Deployment Strategist', 'Engineering')).toBe('engineering');
    expect(familyOf('Quant Intern', undefined, 'Quant')).toBe('data_ml');
  });

  it('a listing becomes a row: level, term, employment, places, pay; a German posting is left out', async () => {
    const row = await intake(
      {
        source: 'ashby',
        externalId: 'x1',
        companyName: 'Quarry, Inc.',
        title: 'Software Engineer Intern (Summer 2027)',
        locations: ['New York, NY (HQ); Remote (US)'],
        url: 'https://jobs.ashbyhq.com/quarry/x1',
        text: '<p>Pay: $45 - $60 per hour. You will build services with our team.</p>',
      },
      { now: NOW },
    );
    expect(row).toMatchObject({
      company_key: 'quarry',
      title_key: 'software engineer intern summer 2027',
      level: 'intern',
      term: 'Summer 2027',
      employment: 'internship',
      family: 'engineering',
      places: ['New York, NY', 'Remote (US)'],
      countries: ['US'],
      remote: 'remote',
      pay: { min: 45, max: 60, per: 'hour' },
    });
    expect(row!.text_hash).toMatch(/^[0-9a-f]{64}$/);
    const german = await intake(
      {
        source: 'greenhouse',
        externalId: 'g1',
        companyName: 'X',
        title: 'Entwickler',
        locations: [],
        url: 'https://x.example/1',
        language: 'de',
      },
      { now: NOW },
    );
    expect(german).toBeUndefined();
  });

  it('a new grad list entry with a plain title is entry level; a senior title stays senior', async () => {
    const base = {
      source: 'simplify' as const,
      companyName: 'X',
      locations: [],
      url: 'https://x.example/1',
      meta: { list: 'newgrad' },
    };
    expect(
      (await intake({ ...base, externalId: 'a', title: 'Software Engineer' }, { now: NOW }))?.level,
    ).toBe('entry');
    expect(
      (await intake({ ...base, externalId: 'b', title: 'Senior Software Engineer' }, { now: NOW }))?.level,
    ).toBe('senior');
  });
});

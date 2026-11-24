/**
 * Plan 44 §4 on PGlite: the source side of Roles against fakes of the real boards. Keeping listings (upserts, one
 * role per city, reposts, a list entry that is a board's role), the daily read (adds, updates by text hash, closes,
 * never twice a day, failures), discovery (a careers page proves a board; a Lever name is never guessed; "none" is
 * remembered), the SimplifyJobs lists, the tick inside its time share, the nightly top-up, upkeep, text on demand,
 * a posting by its link, and the digest block.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JobListing } from '../../../packages/core/src/roles/types.ts';
import { KIND_QUEUE, sqlQueue } from '../../functions/_shared/queue.ts';
import {
  BOARD_BYTES_PER_TICK,
  BOARD_COLUMNS,
  type BoardRow,
  claimBoard,
  LARGE_BOARD_BYTES,
  nextReadAt,
  RATE_LIMIT_DAYS_TO_STOP,
  RATE_LIMIT_RETRY_MS,
  readBoard,
  readDueBoards,
  readMsOf,
  upsertBoard,
  WORKDAY_PAUSE_MIN,
  workdayPaused,
} from '../../functions/_shared/roles/boards.ts';
import { TextLater } from '../../functions/_shared/roles/contracts.ts';
import { rolesDigest, rolesDigestLines } from '../../functions/_shared/roles/digest.ts';
import { companiesToFind, discoverCompany, discoverSome } from '../../functions/_shared/roles/discover.ts';
import { keepListings } from '../../functions/_shared/roles/intake.ts';
import { ASHBY_MAX_BYTES } from '../../functions/_shared/roles/readers/ashby.ts';
import {
  resetWorkdayPacing,
  roleSources,
  text,
  WORKDAY_TEXT_GAP_MS,
  WORKDAY_TEXT_PAUSE_MS,
} from '../../functions/_shared/roles/sources.ts';
import {
  queueTopups,
  readSimplifyPart,
  runRolesTick,
  TICK_MAX_BYTES,
  upkeep,
} from '../../functions/_shared/roles/tick.ts';
import { setMark } from '../../functions/_shared/roles/usage.ts';
import { defaultHandlers } from '../../functions/orbit-worker/worker.ts';
import { fakeBoards, fixture, html, json, redirect } from '../helpers/fakeBoards.ts';
import { freshDb, makeUser, type TestDb } from '../helpers/pglite.ts';

let t: TestDb;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(async () => {
  await t.pg.close();
});
beforeEach(async () => {
  await t.pg.exec(`delete from orbit_private.jobs; delete from orbit_private.job_board_lookups;
    delete from orbit_private.job_boards; delete from orbit_private.roles_usage; delete from orbit_private.company_facts;
    delete from orbit.users; delete from orbit.job_runs; delete from pgmq.q_orbit_score;`);
  resetWorkdayPacing();
});

const DAY1 = new Date('2026-11-24T09:30:00Z');
const DAY2 = new Date('2026-11-25T09:30:00Z');
const net = (f: ReturnType<typeof fakeBoards>, now: Date) => ({
  fetch: f.fetch,
  now: () => now,
  sleep: f.sleep,
});

async function board(service: BoardRow['service'], token: string, name?: string): Promise<BoardRow> {
  const b = await upsertBoard(t.db, {
    service,
    token,
    companyName: name,
    companyKey: name?.toLowerCase(),
    foundVia: 'seed',
  });
  // due before the test's day (a new board is due at the database's own now)
  await t.db
    .sql`update orbit_private.job_boards set next_read_at = ${new Date(DAY1.getTime() - 3_600_000)}::timestamptz
    where id = ${b.id}::uuid`;
  return boardRow(b.id);
}

/** A board as the daily read takes it (every column a read needs), as it stands now. */
async function boardRow(id: string): Promise<BoardRow> {
  const [row] = await t.db.query<BoardRow>(
    `select ${BOARD_COLUMNS} from orbit_private.job_boards where id = $1::uuid`,
    [id],
  );
  return row!;
}

/** An Ashby board's answer of about `mb` megabytes: the fixture's role, many times over. */
function ashbyOfSize(mb: number): { jobs: object[] } {
  const role = fixture<{ jobs: Record<string, unknown>[] }>('ashby-board.json').jobs[1]!;
  const each = JSON.stringify(role).length + 40;
  return {
    jobs: Array.from({ length: Math.ceil((mb * 1_000_000) / each) }, (_, i) => ({
      ...role,
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      title: `Software Engineer, Team ${i}`,
    })),
  };
}

async function jobs(where = 'true') {
  return t.db.query<{
    id: string;
    source: string;
    external_id: string;
    title: string;
    places: string[];
    level: string | null;
    dupe_of: string | null;
    closed_at: Date | null;
    first_seen_at: Date;
    text_hash: string | null;
    text: string | null;
    text_read_at: Date | null;
  }>(
    `select id, source, external_id, title, places, level, dupe_of, closed_at, first_seen_at, text_hash, text, text_read_at
       from orbit_private.jobs where ${where} order by external_id`,
  );
}

const ghList = () => fixture<{ jobs: Record<string, unknown>[] }>('greenhouse-list.json');
const greenhouseRoute = (body: () => unknown) => (u: URL) =>
  u.hostname === 'boards-api.greenhouse.io' && u.pathname === '/v1/boards/nimbuspay/jobs'
    ? json(body())
    : undefined;

describe('keep', () => {
  const listing = (id: string, title: string, over: Partial<JobListing> = {}): JobListing => ({
    source: 'ashby',
    externalId: id,
    companyName: 'Quarry',
    title,
    locations: ['New York, NY'],
    url: `https://jobs.ashbyhq.com/quarry/${id}`,
    text: `About ${title}. You will work with our team on the tools we build.`,
    ...over,
  });

  it('upserts on source and id: a second keep updates, keeps first-seen, and returns the roles in order', async () => {
    const first = await keepListings(
      t.db,
      [listing('a', 'Data Analyst'), listing('b', 'Software Engineer Intern')],
      {
        now: DAY1,
      },
    );
    expect(first).toMatchObject({ added: 2, updated: 0 });
    expect(first.jobs.map((j) => j.title)).toEqual(['Data Analyst', 'Software Engineer Intern']);
    expect(first.jobs[1]).toMatchObject({ level: 'intern', companyKey: 'quarry', places: ['New York, NY'] });
    const again = await keepListings(
      t.db,
      [listing('b', 'Software Engineer Intern', { text: 'New words for the role and the team.' })],
      {
        now: DAY2,
      },
    );
    expect(again).toMatchObject({ added: 0, updated: 1 });
    expect(again.jobs[0]!.firstSeenAt).toBe(DAY1.toISOString());
    const [b] = await jobs(`external_id = 'b'`);
    expect(b!.text).toBe('New words for the role and the team.');
  });

  it('a posting pasted as text has no link and is kept all the same; a board role without one is not', async () => {
    const pasted: JobListing = {
      source: 'posting',
      externalId: 'pasted:0123456789abcdef',
      companyName: 'Unknown company',
      title: 'Data Engineer Intern at Lumen',
      locations: [],
      url: '',
      text: 'Data Engineer Intern at Lumen. You will build pipelines in Python and SQL with the data team.',
    };
    const [job] = await roleSources.keep(t.db, [pasted]);
    expect(job).toMatchObject({
      source: 'posting',
      title: 'Data Engineer Intern at Lumen',
      url: '',
      level: 'intern',
    });
    // its text is the pasted text: asking for it reads no page
    const f = fakeBoards([]);
    expect(await roleSources.text(t.db, net(f, DAY1), job!.id)).toMatch(/pipelines in Python and SQL/);
    expect(f.calls).toHaveLength(0);
    expect(await roleSources.keep(t.db, [listing('nolink', 'Data Analyst', { url: '' })])).toEqual([]);
  });

  it('the same title and text at two companies, kept with no board, are two roles', async () => {
    const r = await keepListings(
      t.db,
      [
        listing('x1', 'Software Engineer Intern', { companyName: 'Quarry', text: 'Must have Python.' }),
        listing('x2', 'Software Engineer Intern', { companyName: 'Harbor', text: 'Must have Python.' }),
      ],
      { now: DAY1 },
    );
    expect(r.jobs.map((j) => j.companyName)).toEqual(['Quarry', 'Harbor']);
    expect((await jobs(`title = 'Software Engineer Intern'`)).every((j) => !j.dupe_of)).toBe(true);
  });

  it('a non-English listing is not stored', async () => {
    const r = await keepListings(t.db, [listing('de', 'Entwickler', { language: 'de' })], { now: DAY1 });
    expect(r).toMatchObject({ added: 0, skipped: 1, jobs: [] });
  });
});

describe('the daily read of a board', () => {
  it('one role per title listed in several cities: the first is shown, the others point at it, places merged', async () => {
    const b = await board('greenhouse', 'nimbuspay');
    const body = ghList();
    const dup = body.jobs.filter((j) => j.title === 'Account Executive, AI Sales');
    dup[1]!.location = { name: 'New York, NY' };
    const f = fakeBoards([greenhouseRoute(() => body)]);
    const o = await readBoard(t.db, net(f, DAY1), b, DAY1);
    expect(o).toMatchObject({ ok: true, added: 9, closed: 0 });
    const ae = await jobs(`title = 'Account Executive, AI Sales'`);
    expect(ae).toHaveLength(2);
    const shown = ae.find((j) => !j.dupe_of)!;
    expect(ae.find((j) => j.dupe_of)!.dupe_of).toBe(shown.id);
    expect(shown.places).toEqual(['San Francisco, CA', 'New York, NY']);
    // the German posting is not kept; the board's company name is taken from Greenhouse
    expect((await jobs(`external_id = '8260982'`)).length).toBe(0);
    const [row] = await t.db.sql<{
      company_name: string;
      status: string;
      roles_open: number;
      next_read_at: Date;
    }>`
      select company_name, status, roles_open, next_read_at from orbit_private.job_boards where id = ${b.id}::uuid`;
    expect(row).toMatchObject({ company_name: 'Nimbus Pay', status: 'active', roles_open: 8 });
    expect(new Date(row!.next_read_at).toISOString()).toBe(nextReadAt(b.id, DAY1).toISOString());
  });

  it('adds, updates by text hash and closes what the next read no longer lists', async () => {
    const b = await board('lever', 'halcyon', 'Halcyon');
    const page = fixture<Record<string, unknown>[]>('lever-page.json');
    let day = 1;
    const f = fakeBoards([
      (u) => {
        if (u.hostname !== 'api.lever.co') return undefined;
        if (day === 1) return json(page);
        // day 2: the fellowship's text changed, the London role is gone
        return json([
          page[0],
          { ...page[2], descriptionPlain: 'A new description of the fellowship for students.' },
        ]);
      },
    ]);
    const one = await readBoard(t.db, net(f, DAY1), b, DAY1);
    expect(one).toMatchObject({ ok: true, added: 3, closed: 0 });
    const before = (await jobs(`external_id = '0ccbe620-a3ef-41d1-a5c4-68e56b3c91d0'`))[0]!;
    expect(before.level).toBe('entry');
    day = 2;
    const two = await readBoard(t.db, net(f, DAY2), b, DAY2);
    expect(two).toMatchObject({ ok: true, added: 0, updated: 2, closed: 1 });
    const after = (await jobs(`external_id = '0ccbe620-a3ef-41d1-a5c4-68e56b3c91d0'`))[0]!;
    expect(after.text_hash).not.toBe(before.text_hash);
    expect(new Date(after.first_seen_at).toISOString()).toBe(DAY1.toISOString());
    const london = (await jobs(`external_id = 'ac978161-6f46-4f6b-ad9e-a258e642751c'`))[0]!;
    expect(london.closed_at).not.toBeNull();
  });

  it('a repost under a new id keeps the first-seen date; the old id closes', async () => {
    const b = await board('greenhouse', 'nimbuspay');
    const body = ghList();
    const f = fakeBoards([greenhouseRoute(() => body)]);
    await readBoard(t.db, net(f, DAY1), b, DAY1);
    const abuse = body.jobs.find((j) => j.title === 'Abuse Investigator')!;
    abuse.id = 9999001;
    await readBoard(t.db, net(f, DAY2), b, DAY2);
    const [old] = await jobs(`external_id = '8172510'`);
    const [neu] = await jobs(`external_id = '9999001'`);
    expect(old!.closed_at).not.toBeNull();
    expect(neu!.closed_at).toBeNull();
    expect(neu!.dupe_of).toBeNull();
    expect(new Date(neu!.first_seen_at).toISOString()).toBe(DAY1.toISOString());
  });

  it('is never read twice in a day, whatever next_read_at says', async () => {
    const b = await board('greenhouse', 'nimbuspay');
    const f = fakeBoards([greenhouseRoute(ghList)]);
    const run = { clock: f.clock, deadline: f.clock() + 60_000, maxBytes: 10_000_000 };
    expect((await readDueBoards(t.db, net(f, DAY1), DAY1, run)).read).toBe(1);
    await t.db
      .sql`update orbit_private.job_boards set next_read_at = ${DAY1}::timestamptz where id = ${b.id}::uuid`;
    const later = new Date(DAY1.getTime() + 3 * 3_600_000);
    expect((await readDueBoards(t.db, net(f, later), later, run)).read).toBe(0);
    expect(await claimBoard(t.db, b.id, later)).toBe(false);
    expect(f.calls).toHaveLength(1);
    expect(await claimBoard(t.db, b.id, DAY2)).toBe(true);
  });

  it('reads two Workday sites a tick at most, and none more after one answers 429', async () => {
    for (let i = 0; i < 4; i++) await board('workday', `t${i}.wd1.myworkdayjobs.com/t${i}/Site`, `T${i}`);
    const page = fixture('workday-page.json');
    const ok = fakeBoards([(u) => (u.hostname.endsWith('myworkdayjobs.com') ? json(page) : undefined)]);
    const run = { clock: ok.clock, deadline: ok.clock() + 600_000, maxBytes: 10_000_000 };
    expect((await readDueBoards(t.db, net(ok, DAY1), DAY1, run)).read).toBe(2);
    const busy = fakeBoards([() => new Response('', { status: 429 })]);
    const s = await readDueBoards(t.db, net(busy, DAY1), DAY1, {
      ...run,
      clock: busy.clock,
      deadline: busy.clock() + 600_000,
    });
    expect(s).toMatchObject({ read: 0, failed: 1 });
    // the one that was asked is not marked as failing: it is asked again later today
    const rows = await t.db.sql<{ failures: number; rate_limited_days: number }>`
      select failures, rate_limited_days from orbit_private.job_boards where rate_limited_at is not null`;
    expect(rows).toEqual([{ failures: 0, rate_limited_days: 0 }]);
  });

  it('three 404s in three days make a board gone', async () => {
    const gone = await board('lever', 'vanished', 'Vanished');
    const f = fakeBoards([]);
    for (let d = 0; d < 3; d++) {
      const now = new Date(DAY1.getTime() + d * 86_400_000);
      await readBoard(t.db, net(f, now), await boardRow(gone.id), now);
    }
    const [g] = await t.db.sql<{
      status: string;
      failures: number;
    }>`select status, failures from orbit_private.job_boards where id = ${gone.id}::uuid`;
    expect(g).toEqual({ status: 'gone', failures: 3 });
  });

  it('an Ashby board of several megabytes is read whole; one over 12 MB is skipped with its size, for a week', async () => {
    expect(ASHBY_MAX_BYTES).toBe(12_000_000);
    const big = await board('ashby', 'quarry', 'Quarry');
    // 4.6 MB: over the old 2 MB limit, where 22% of Ashby boards are
    const large = ashbyOfSize(4.6);
    let body: unknown = large;
    const f = fakeBoards([(u) => (u.hostname === 'api.ashbyhq.com' ? json(body) : undefined)]);
    const o = await readBoard(t.db, net(f, DAY1), big, DAY1);
    expect(o).toMatchObject({ ok: true, added: large.jobs.length, roles: large.jobs.length });
    expect(o.bytes).toBeGreaterThan(4_000_000);
    const after = await boardRow(big.id);
    expect(after).toMatchObject({ status: 'active', failures: 0 });
    expect(Number(after.last_size_bytes)).toBe(o.bytes);
    // its text came with the board: nothing is fetched to read a role of it closely
    const [role] = await jobs(`title = 'Software Engineer, Team 7'`);
    expect(role!.text).toMatch(/Quarry/);
    // the next day it has grown past 12 MB: not read, its size kept, tried again in a week, not a failure
    body = ashbyOfSize(12.4);
    const too = await readBoard(t.db, net(f, DAY2), await boardRow(big.id), DAY2);
    expect(too).toMatchObject({ ok: false, error: 'too_large' });
    const [a] = await t.db.sql<{
      last_error: string;
      last_size_bytes: number;
      failures: number;
      next_read_at: Date;
    }>`
      select last_error, last_size_bytes, failures, next_read_at from orbit_private.job_boards
       where id = ${big.id}::uuid`;
    expect(a!.last_error).toMatch(/^too_large/);
    expect(a!.last_size_bytes).toBeGreaterThan(ASHBY_MAX_BYTES);
    expect(a!.failures).toBe(0);
    expect(new Date(a!.next_read_at).toISOString()).toBe(nextReadAt(big.id, DAY2, 7).toISOString());
    // nothing it listed before is closed by a read that did not happen
    expect((await jobs(`closed_at is not null`)).length).toBe(0);
  }, 60_000);

  it("a large board is a tick's whole share: it waits for a tick of its own, and nothing is read after it", async () => {
    expect(TICK_MAX_BYTES).toBe(BOARD_BYTES_PER_TICK);
    expect(BOARD_BYTES_PER_TICK).toBe(ASHBY_MAX_BYTES);
    const small = await board('greenhouse', 'nimbuspay');
    const big = await board('ashby', 'quarry', 'Quarry');
    const other = await board('greenhouse', 'second', 'Second');
    // the large board is known to be large from its last read, and is due first
    await t.db.sql`update orbit_private.job_boards set last_size_bytes = 9000000 where id = ${big.id}::uuid`;
    await t.db
      .sql`update orbit_private.job_boards set next_read_at = ${new Date(DAY1.getTime() - 7_200_000)}::timestamptz
      where id = ${small.id}::uuid`;
    const large = ashbyOfSize(3);
    const f = fakeBoards([
      (u) => (u.hostname === 'api.ashbyhq.com' ? json(large) : undefined),
      (u) => (u.hostname === 'boards-api.greenhouse.io' ? json(ghList()) : undefined),
    ]);
    const run = { clock: f.clock, deadline: f.clock() + 600_000, maxBytes: BOARD_BYTES_PER_TICK };
    // a tick that has already read a board leaves the large one for a tick of its own
    const one = await readDueBoards(t.db, net(f, DAY1), DAY1, run);
    expect(one.outcomes.map((o) => o.token).sort()).toEqual(['nimbuspay', 'second']);
    expect(one.waiting).toBe(1);
    expect((await boardRow(big.id)).last_size_bytes).toBe(9000000);
    // the next tick starts with it (it is the oldest due), and reads nothing after it
    await board('greenhouse', 'third', 'Third');
    const later = new Date(DAY1.getTime() + 600_000);
    const two = await readDueBoards(t.db, net(f, later), later, { ...run, deadline: f.clock() + 600_000 });
    expect(two.outcomes.map((o) => o.token)).toEqual(['quarry']);
    expect(two).toMatchObject({ read: 1, stoppedBy: 'bytes' });
    expect(two.bytes).toBeGreaterThan(LARGE_BOARD_BYTES);
    // the board after it is read by the tick after that
    const three = await readDueBoards(t.db, net(f, later), later, { ...run, deadline: f.clock() + 600_000 });
    expect(three.outcomes.map((o) => o.token)).toEqual(['third']);
    void other;
  }, 60_000);

  it('a tick that also read a SimplifyJobs list has half the share: a board larger than that waits', async () => {
    const big = await board('ashby', 'quarry', 'Quarry');
    await t.db.sql`update orbit_private.job_boards set last_size_bytes = 9000000 where id = ${big.id}::uuid`;
    const f = fakeBoards([(u) => (u.hostname === 'api.ashbyhq.com' ? json(ashbyOfSize(2.2)) : undefined)]);
    const half = await readDueBoards(t.db, net(f, DAY1), DAY1, {
      clock: f.clock,
      deadline: f.clock() + 600_000,
      maxBytes: BOARD_BYTES_PER_TICK / 2,
    });
    expect(half).toMatchObject({ read: 0, waiting: 1 });
    expect(f.calls).toHaveLength(0);
    // a board never read has no size: it is read when its turn comes, and when it turns out large the tick ends
    await t.db.sql`update orbit_private.job_boards set last_size_bytes = null where id = ${big.id}::uuid`;
    await board('greenhouse', 'nimbuspay');
    const first = await readDueBoards(t.db, net(f, DAY1), DAY1, {
      clock: f.clock,
      deadline: f.clock() + 600_000,
      maxBytes: BOARD_BYTES_PER_TICK,
    });
    expect(first.outcomes.map((o) => o.token)).toEqual(['quarry']);
    expect(first.stoppedBy).toBe('bytes');
    // a large board is given the time it needs before it is started
    expect(readMsOf({ service: 'ashby', last_size_bytes: 9_000_000 })).toBe(13_000);
    expect(readMsOf({ service: 'ashby', last_size_bytes: null })).toBe(4_000);
  }, 60_000);
});

describe('a board that answers 429', () => {
  const busy = () => fakeBoards([() => new Response('<html>429</html>', { status: 429 })]);
  const state = async (id: string) => {
    const [r] = await t.db.sql<{
      status: string;
      failures: number;
      rate_limited_days: number;
      rate_limited_at: Date | null;
      next_read_at: Date;
      last_error: string | null;
    }>`
      select status, failures, rate_limited_days, rate_limited_at, next_read_at, last_error
        from orbit_private.job_boards where id = ${id}::uuid`;
    return { ...r!, next: new Date(r!.next_read_at).toISOString() };
  };

  it('is asked once more later the same day, then daily, and neither counts as a failure of the board', async () => {
    const b = await board('workday', 'busy.wd1.myworkdayjobs.com/busy/Site', 'Busy');
    const f = busy();
    const run = () => ({ clock: f.clock, deadline: f.clock() + 600_000, maxBytes: BOARD_BYTES_PER_TICK });
    // 09:30: asked to slow down
    const one = await readDueBoards(t.db, net(f, DAY1), DAY1, run());
    expect(one).toMatchObject({ read: 0, failed: 1 });
    expect(one.outcomes[0]).toMatchObject({ ok: false, error: 'rate_limited' });
    let s = await state(b.id);
    expect(s).toMatchObject({ status: 'active', failures: 0, rate_limited_days: 0 });
    expect(s.last_error).toMatch(/^rate_limited/);
    // due again later the same day, three hours on
    expect(s.next).toBe(new Date(DAY1.getTime() + RATE_LIMIT_RETRY_MS).toISOString());
    expect(s.next.slice(0, 10)).toBe('2026-11-24');
    // not before then
    const soon = new Date(DAY1.getTime() + 3_600_000);
    expect((await readDueBoards(t.db, net(f, soon), soon, run())).outcomes).toHaveLength(0);
    // 12:30: asked once more; still busy, so that is the day: tomorrow at its own minute, one day counted
    const retry = new Date(DAY1.getTime() + RATE_LIMIT_RETRY_MS);
    const calls = f.calls.length;
    const two = await readDueBoards(t.db, net(f, retry), retry, run());
    expect(two.outcomes).toHaveLength(1);
    expect(f.calls.length).toBeGreaterThan(calls);
    s = await state(b.id);
    expect(s).toMatchObject({ status: 'active', failures: 0, rate_limited_days: 1 });
    expect(s.next).toBe(nextReadAt(b.id, retry).toISOString());
    // and not a third time today, whatever its next read says
    await t.db
      .sql`update orbit_private.job_boards set next_read_at = ${retry}::timestamptz where id = ${b.id}::uuid`;
    const evening = new Date(DAY1.getTime() + 9 * 3_600_000);
    expect((await readDueBoards(t.db, net(f, evening), evening, run())).outcomes).toHaveLength(0);
    expect(await claimBoard(t.db, b.id, evening)).toBe(false);
    // the digest says how often boards asked Orbit to slow down, apart from failures
    const d = (await rolesDigest(t.db, '2026-11-24'))!;
    expect(d).toMatchObject({ boardsRateLimited: 2, boardsFailed: 1 });
    expect(rolesDigestLines(d).join('\n')).toMatch(/failed: 1, asked to slow down: 2/);
  });

  it('a 429 late in the day has no later that day: it waits for tomorrow', async () => {
    const b = await board('lever', 'slow', 'Slow');
    const late = new Date('2026-11-24T22:15:00Z');
    const f = busy();
    await readBoard(t.db, net(f, late), await boardRow(b.id), late);
    const s = await state(b.id);
    expect(s).toMatchObject({ failures: 0, rate_limited_days: 1, status: 'active' });
    expect(s.next).toBe(nextReadAt(b.id, late).toISOString());
  });

  it('is set aside only after days in a row of it, a read that works starts the count again, and a 404 streak is its own', async () => {
    expect(RATE_LIMIT_DAYS_TO_STOP).toBeGreaterThan(3);
    const b = await board('workday', 'busy.wd1.myworkdayjobs.com/busy/Site', 'Busy');
    const f = busy();
    const day = (d: number, hour = 22) => new Date(Date.UTC(2026, 10, 24 + d, hour, 15));
    // three days of 429, where three failures of another kind would have set it aside: still active
    for (let d = 0; d < 3; d++) await readBoard(t.db, net(f, day(d)), await boardRow(b.id), day(d));
    expect(await state(b.id)).toMatchObject({ status: 'active', failures: 0, rate_limited_days: 3 });
    // a day it answers: the count starts again
    const page = fixture('workday-page.json');
    const ok = fakeBoards([(_u, init) => (init.method === 'POST' ? json(page) : undefined)]);
    await readBoard(t.db, net(ok, day(3)), await boardRow(b.id), day(3));
    expect(await state(b.id)).toMatchObject({
      status: 'active',
      rate_limited_days: 0,
      rate_limited_at: null,
    });
    // then every day for RATE_LIMIT_DAYS_TO_STOP days: set aside for a month
    for (let d = 4; d < 4 + RATE_LIMIT_DAYS_TO_STOP; d++)
      await readBoard(t.db, net(f, day(d)), await boardRow(b.id), day(d));
    const last = day(3 + RATE_LIMIT_DAYS_TO_STOP);
    const s = await state(b.id);
    expect(s).toMatchObject({ status: 'refused', failures: 0, rate_limited_days: RATE_LIMIT_DAYS_TO_STOP });
    expect(s.next).toBe(nextReadAt(b.id, last, 30).toISOString());
    // when its month is over it is tried again, one more day of 429 from being set aside again
    const month = new Date(last.getTime() + 31 * 86_400_000);
    await readDueBoards(t.db, net(ok, month), month, {
      clock: ok.clock,
      deadline: ok.clock() + 600_000,
      maxBytes: BOARD_BYTES_PER_TICK,
    });
    expect(await state(b.id)).toMatchObject({ status: 'active', rate_limited_days: 0 });
  });

  it('after one Workday site says to slow down, no Workday site is asked for an hour; other boards are read', async () => {
    for (let i = 0; i < 3; i++) await board('workday', `t${i}.wd1.myworkdayjobs.com/t${i}/Site`, `T${i}`);
    await board('greenhouse', 'nimbuspay');
    const f = fakeBoards([
      (u) => (u.hostname === 'boards-api.greenhouse.io' ? json(ghList()) : undefined),
      () => new Response('', { status: 429 }),
    ]);
    const run = () => ({ clock: f.clock, deadline: f.clock() + 600_000, maxBytes: BOARD_BYTES_PER_TICK });
    const one = await readDueBoards(t.db, net(f, DAY1), DAY1, run());
    // one Workday site asked, the other two left alone; the Greenhouse board read
    expect(one.outcomes.filter((o) => o.service === 'workday')).toHaveLength(1);
    expect(one).toMatchObject({ read: 1, failed: 1 });
    expect(await workdayPaused(t.db, DAY1)).toBe(true);
    // the next tick, ten minutes on: no Workday site is asked at all
    const ten = new Date(DAY1.getTime() + 600_000);
    const before = f.calls.length;
    const two = await readDueBoards(t.db, net(f, ten), ten, run());
    expect(two.outcomes).toHaveLength(0);
    expect(f.calls.length).toBe(before);
    // after the hour the two that were left alone are asked
    const hour = new Date(DAY1.getTime() + (WORKDAY_PAUSE_MIN + 1) * 60_000);
    expect(await workdayPaused(t.db, hour)).toBe(false);
    const page = fixture('workday-page.json');
    const ok = fakeBoards([(_u, init) => (init.method === 'POST' ? json(page) : undefined)]);
    const three = await readDueBoards(t.db, net(ok, hour), hour, {
      clock: ok.clock,
      deadline: ok.clock() + 600_000,
      maxBytes: BOARD_BYTES_PER_TICK,
    });
    expect(three.read).toBe(2);
  });
});

describe('Workday role details', () => {
  const SITE = 'lumen.wd5.myworkdayjobs.com/lumen/LumenExternalCareerSite';
  /** Five Workday roles of one site, kept as its list read keeps them (no text). */
  async function workdayRoles() {
    const b = await board('workday', SITE, 'Lumen');
    const f = fakeBoards([
      (_u, init) => (init.method === 'POST' ? json(fixture('workday-page.json')) : undefined),
    ]);
    await readBoard(t.db, net(f, DAY1), b, DAY1);
    return jobs(`source = 'workday'`);
  }

  it('are read one at a time, a gap apart, however many are asked for at once', async () => {
    const roles = await workdayRoles();
    expect(roles).toHaveLength(5);
    let open = 0;
    let most = 0;
    const at: number[] = [];
    const f = fakeBoards([
      async (u) => {
        if (!u.pathname.includes('/job/')) return undefined;
        at.push(f.clock());
        most = Math.max(most, ++open);
        await new Promise((r) => setTimeout(r, 5));
        open--;
        return json(fixture('workday-job.json'));
      },
    ]);
    // a search reads its ten roles side by side
    const texts = await Promise.all(roles.map((r) => text(t.db, net(f, DAY1), r.id)));
    expect(texts.every((x) => /Kubernetes/.test(x ?? ''))).toBe(true);
    expect(most).toBe(1);
    expect(at).toHaveLength(5);
    for (let i = 1; i < at.length; i++)
      expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(WORKDAY_TEXT_GAP_MS);
  });

  it('after a 429 none is asked for a while, and a role not read is read later, never scored without its text', async () => {
    const roles = await workdayRoles();
    let now = DAY1;
    const f = fakeBoards([
      (u) => (u.pathname.includes('/job/') ? new Response('', { status: 429 }) : undefined),
    ]);
    const n = { fetch: f.fetch, now: () => now, sleep: f.sleep };
    const settled = await Promise.allSettled(roles.map((r) => text(t.db, n, r.id)));
    // one request found Workday busy; the others were not sent
    expect(f.calls).toHaveLength(1);
    expect(settled.every((s) => s.status === 'rejected' && s.reason instanceof TextLater)).toBe(true);
    // nothing was closed or kept as read
    expect((await jobs(`source = 'workday'`)).every((j) => !j.closed_at && !j.text && !j.text_read_at)).toBe(
      true,
    );
    // still paused a minute on, with no request
    now = new Date(DAY1.getTime() + 60_000);
    await expect(text(t.db, n, roles[0]!.id)).rejects.toBeInstanceOf(TextLater);
    expect(f.calls).toHaveLength(1);
    // after the pause Workday is asked again
    now = new Date(DAY1.getTime() + WORKDAY_TEXT_PAUSE_MS + 1_000);
    const ok = fakeBoards([
      (u) => (u.pathname.includes('/job/') ? json(fixture('workday-job.json')) : undefined),
    ]);
    const again = { fetch: ok.fetch, now: () => now, sleep: ok.sleep };
    expect(await text(t.db, again, roles[0]!.id)).toMatch(/Kubernetes/);
    // a posting scored by its Workday link while Workday is busy: a line to show, and no page fetched instead
    resetWorkdayPacing();
    const link = `https://lumen.wd5.myworkdayjobs.com/LumenExternalCareerSite/job/Israel-Tel-Aviv/Senior-SRE-Engineer_JR2029097`;
    const busy = fakeBoards([() => new Response('', { status: 429 })]);
    expect(await roleSources.readUrl(net(busy, DAY1), link)).toEqual({
      problem: "Workday is busy just now. Try again in a few minutes, or paste the posting's text.",
    });
    expect(busy.calls).toHaveLength(1);
  });

  it('a role whose board says it is gone is closed, and one whose site cannot be reached is read later', async () => {
    const b = await board('greenhouse', 'nimbuspay');
    await readBoard(t.db, net(fakeBoards([greenhouseRoute(ghList)]), DAY1), b, DAY1);
    const [role] = await jobs(`external_id = '8172510'`);
    const down = fakeBoards([() => new Response('', { status: 503 })]);
    await expect(text(t.db, net(down, DAY1), role!.id)).rejects.toBeInstanceOf(TextLater);
    expect((await jobs(`external_id = '8172510'`))[0]!.closed_at).toBeNull();
    const gone = fakeBoards([() => new Response('', { status: 404 })]);
    expect(await text(t.db, net(gone, DAY1), role!.id)).toBeUndefined();
    expect((await jobs(`external_id = '8172510'`))[0]!.closed_at).not.toBeNull();
  });
});

describe('a list entry or a LinkedIn result that is a board role', () => {
  it('points at the board role, whichever was kept first', async () => {
    // the list first, then the board
    const sim: JobListing = {
      source: 'simplify',
      externalId: 'sim-1',
      companyName: 'Nimbus Pay',
      title: 'Integration Reliability Engineer Intern, Technical Operations',
      locations: ['Singapore'],
      url: 'https://job-boards.greenhouse.io/nimbuspay/jobs/8186367',
      level: 'intern',
      meta: { list: 'intern', boardRef: 'greenhouse:8186367' },
    };
    await keepListings(t.db, [sim], { now: DAY1 });
    const b = await board('greenhouse', 'nimbuspay');
    await readBoard(t.db, net(fakeBoards([greenhouseRoute(ghList)]), DAY1), b, DAY1);
    const [boardRole] = await jobs(`external_id = '8186367'`);
    const [s] = await jobs(`external_id = 'sim-1'`);
    expect(s!.dupe_of).toBe(boardRole!.id);

    // the board first, then LinkedIn: same company and title, a place in common
    const li = await roleSources.keep(t.db, [
      {
        source: 'linkedin',
        externalId: '555',
        companyName: 'Nimbus Pay',
        title: 'Software Engineer, New Grad - Frontend',
        locations: ['Barcelona, Catalonia, Spain'],
        url: 'https://www.linkedin.com/jobs/view/555',
      },
      {
        source: 'linkedin',
        externalId: '556',
        companyName: 'Nimbus Pay',
        title: 'Software Engineer, New Grad - Frontend',
        locations: ['Austin, TX'],
        url: 'https://www.linkedin.com/jobs/view/556',
      },
    ]);
    const [ng] = await jobs(`external_id = '8130927'`);
    expect(li[0]!.id).toBe(ng!.id);
    expect(li[0]!.source).toBe('greenhouse');
    // no place in common: its own role
    expect(li[1]!.source).toBe('linkedin');
  });
});

describe('discovery', () => {
  it('a careers page on the company site names its board; the lookup is kept', async () => {
    await t.db.sql`
      insert into orbit_private.company_facts (source, source_id, key, name, website, team_size)
      values ('yc', '1', 'acme robotics', 'Acme Robotics', 'https://www.acmerobotics.example', 80)`;
    const f = fakeBoards([
      (u) =>
        u.hostname === 'acmerobotics.example' && u.pathname === '/careers'
          ? html(`<h1>Join us</h1><div id="grnhse_app"></div>
              <script src="https://boards.greenhouse.io/embed/job_board/js?for=acmerobotics"></script>`)
          : undefined,
    ]);
    const todo = await companiesToFind(t.db, DAY1, 10);
    expect(todo).toEqual([{ key: 'acme robotics', name: 'Acme Robotics', domain: 'acmerobotics.example' }]);
    const d = await discoverCompany(t.db, net(f, DAY1), todo[0]!, DAY1);
    expect(d).toMatchObject({
      outcome: 'found',
      requests: 1,
      board: { service: 'greenhouse', token: 'acmerobotics', via: 'careers_page' },
    });
    const [row] = await t.db.sql<{ found_via: string; found_url: string; company_key: string }>`
      select found_via, found_url, company_key from orbit_private.job_boards`;
    expect(row).toEqual({
      found_via: 'careers_page',
      found_url: 'https://acmerobotics.example/careers',
      company_key: 'acme robotics',
    });
    const [l] = await t.db.sql<{ outcome: string }>`select outcome from orbit_private.job_board_lookups`;
    expect(l!.outcome).toBe('found');
    expect(await companiesToFind(t.db, DAY1, 10)).toEqual([]);
  });

  it('a careers page that redirects to the board is proof too', async () => {
    const f = fakeBoards([
      (u) =>
        u.hostname === 'beta.example' && u.pathname === '/careers'
          ? redirect('https://jobs.lever.co/betaco')
          : undefined,
    ]);
    const d = await discoverCompany(
      t.db,
      net(f, DAY1),
      { key: 'beta', name: 'Beta', domain: 'beta.example' },
      DAY1,
    );
    expect(d).toMatchObject({ outcome: 'found', board: { service: 'lever', token: 'betaco' } });
  });

  it('a Lever name is never guessed, a Greenhouse name only when the board says it is the company; "none" is kept', async () => {
    const f = fakeBoards([
      // Lever and Ashby would answer for any name
      (u) => (u.hostname === 'api.lever.co' ? json([{ id: 'x', text: 'Role' }]) : undefined),
      (u) => (u.hostname === 'api.ashbyhq.com' ? json({ jobs: [] }) : undefined),
      (u) => (u.pathname === '/v1/boards/gammaco' ? json({ name: 'Gamma Holdings Group' }) : undefined),
      (u) => (u.pathname === '/v1/boards/nimbuspay' ? json({ name: 'Nimbus Pay', content: '' }) : undefined),
    ]);
    const gamma = await discoverCompany(
      t.db,
      net(f, DAY1),
      { key: 'gammaco', name: 'GammaCo', domain: 'gammaco.example' },
      DAY1,
    );
    expect(gamma.outcome).toBe('none');
    expect(f.calls.some((c) => c.url.includes('lever.co') || c.url.includes('ashbyhq'))).toBe(false);
    const nimbus = await discoverCompany(t.db, net(f, DAY1), { key: 'nimbus pay', name: 'Nimbus Pay' }, DAY1);
    expect(nimbus).toMatchObject({
      outcome: 'found',
      board: { service: 'greenhouse', token: 'nimbuspay', via: 'name' },
    });
    const lookups = await t.db.sql<{ company_key: string; outcome: string }>`
      select company_key, outcome from orbit_private.job_board_lookups order by company_key`;
    expect(lookups).toEqual([
      { company_key: 'gammaco', outcome: 'none' },
      { company_key: 'nimbus pay', outcome: 'found' },
    ]);
    // "none" is remembered for 30 days, then asked again
    await t.db.sql`insert into orbit_private.company_facts (source, source_id, key, name, website)
      values ('yc', '2', 'gammaco', 'GammaCo', 'gammaco.example')`;
    expect(await companiesToFind(t.db, DAY2, 10)).toEqual([]);
    expect(
      (await companiesToFind(t.db, new Date(DAY1.getTime() + 31 * 86_400_000), 10)).map((c) => c.key),
    ).toEqual(['gammaco']);
  });

  it('a site that refuses counts as refused and the lookup as failed', async () => {
    const f = fakeBoards([
      (u) => (u.hostname.endsWith('shy.example') ? new Response('', { status: 403 }) : undefined),
    ]);
    const d = await discoverCompany(
      t.db,
      net(f, DAY1),
      { key: 'shy', name: 'Shy', domain: 'shy.example' },
      DAY1,
    );
    expect(d.outcome).toBe('failed');
    expect(d.refused).toBe(4);
  });

  it("looks for students' target companies first, from their people's companies too, never schools", async () => {
    const u = await makeUser(t.db);
    await t.db.sql`insert into orbit.goals (user_id, kind, title, targets)
      values (${u}::uuid, 'recruiting', 'Roles', ${{ organizations: ['Delta Labs'], roles: [], geographies: [], people: [] }}::jsonb)`;
    for (const [name, org] of [
      ['A', 'Echo Corp'],
      ['B', 'Echo Corp'],
      ['C', 'Stanford University'],
    ] as const)
      await t.db.sql`insert into orbit.people (user_id, display_name, name_norm, org_raw)
        values (${u}::uuid, ${name}, ${name.toLowerCase()}, ${org})`;
    const todo = await companiesToFind(t.db, DAY1, 10);
    expect(todo.map((c) => c.name)).toEqual(['Delta Labs', 'Echo Corp']);
  });
});

describe('the SimplifyJobs lists', () => {
  it('one list a tick, kept and harvested for boards, once a day', async () => {
    const f = fakeBoards([
      (u) =>
        u.hostname === 'raw.githubusercontent.com'
          ? json(
              fixture(u.pathname.includes('Internships') ? 'simplify-intern.json' : 'simplify-newgrad.json'),
            )
          : undefined,
    ]);
    const run = { clock: f.clock, deadline: f.clock() + 30_000 };
    const one = await readSimplifyPart(t.db, net(f, DAY1), DAY1, run);
    expect(one).toMatchObject({ list: 'intern', done: true });
    expect(one!.harvested).toBeGreaterThanOrEqual(8);
    const two = await readSimplifyPart(t.db, net(f, DAY1), DAY1, run);
    expect(two).toMatchObject({ list: 'newgrad', done: true });
    expect(await readSimplifyPart(t.db, net(f, DAY1), DAY1, run)).toBeUndefined();
    expect(f.calls).toHaveLength(2);
    const boards = await t.db.sql<{ service: string; token: string; found_via: string }>`
      select service, token, found_via from orbit_private.job_boards order by service, token`;
    expect(new Set(boards.map((b) => b.service))).toEqual(
      new Set(['greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'workable', 'recruitee']),
    );
    expect(boards.every((b) => b.found_via === 'simplify')).toBe(true);
    expect(boards.find((b) => b.service === 'workday')!.token).toMatch(
      /^board\d+\.wd\d\.myworkdayjobs\.com\/board\d+\/Careersboard\d+$/,
    );
    const sim = await t.db.sql<{ level: string | null; sponsorship: string | null; term: string | null }>`
      select level, sponsorship, term from orbit_private.jobs where source = 'simplify'`;
    expect(sim.length).toBeGreaterThan(15);
    expect(sim.filter((s) => s.level === 'intern').length).toBeGreaterThanOrEqual(10);
    expect(sim.some((s) => s.sponsorship === 'none')).toBe(true);
    // tomorrow both lists are read again
    expect(await readSimplifyPart(t.db, net(f, DAY2), DAY2, run)).toMatchObject({ list: 'intern' });
  });
});

describe('the tick', () => {
  it('stays inside its time share (fake clock), leaving the rest of the boards for the next tick', async () => {
    for (let i = 0; i < 30; i++) await board('greenhouse', `board${i}`, `Company ${i}`);
    await setMark(t.db, DAY1, 'simplify_intern_done', 1);
    await setMark(t.db, DAY1, 'simplify_newgrad_done', 1);
    const f = fakeBoards([(u) => (u.hostname === 'boards-api.greenhouse.io' ? json(ghList()) : undefined)], {
      cost: 3_000,
    });
    const start = f.clock();
    const s = await runRolesTick(t.db, {
      net: net(f, DAY1),
      queue: sqlQueue(t.db),
      clock: f.clock,
      budgetMs: 40_000,
    });
    expect(f.clock() - start).toBeLessThanOrEqual(40_000);
    expect(s.boards.read).toBeGreaterThan(3);
    expect(s.boards.read).toBeLessThan(30);
    expect(s.boards.stoppedBy).toBe('time');
    const [left] = await t.db.sql<{ n: number }>`
      select count(*)::int as n from orbit_private.job_boards where last_read_at is null`;
    expect(left!.n).toBe(30 - s.boards.read);
  });

  it('is registered: roles.tick on orbit_score with a handler, roles.topup on orbit_score', () => {
    expect(KIND_QUEUE['roles.tick']).toBe('orbit_score');
    expect(KIND_QUEUE['roles.topup']).toBe('orbit_score');
    expect(typeof defaultHandlers()['roles.tick']).toBe('function');
  });
});

describe('the nightly top-up', () => {
  it('queued once a night, from 06:00 UTC, only for students who searched in the last 14 days', async () => {
    const active = await makeUser(t.db);
    const old = await makeUser(t.db);
    await makeUser(t.db);
    await t.db.sql`insert into orbit.role_searches (user_id, evidence_hash, wants_hash, created_at)
      values (${active}::uuid, 'e', 'w', ${new Date(DAY1.getTime() - 2 * 86_400_000)}::timestamptz),
             (${old}::uuid, 'e', 'w', ${new Date(DAY1.getTime() - 20 * 86_400_000)}::timestamptz)`;
    const q = sqlQueue(t.db);
    expect(await queueTopups(t.db, q, new Date('2026-11-24T05:50:00Z'))).toBeNull();
    expect(await queueTopups(t.db, q, new Date('2026-11-24T06:05:00Z'))).toBe(1);
    expect(await queueTopups(t.db, q, new Date('2026-11-24T06:15:00Z'))).toBeNull();
    const msgs = await t.db.sql<{
      message: { kind: string; userId: string; payload: object; dedupeKey: string };
    }>`
      select message from pgmq.q_orbit_score`;
    expect(msgs.map((m) => m.message)).toEqual([
      { kind: 'roles.topup', userId: active, payload: {}, dedupeKey: `roles.topup:${active}:2026-11-24` },
    ]);
  });
});

describe('upkeep', () => {
  it('closes list roles not seen for 3 days; deletes closed roles after 60 days unless someone saved them', async () => {
    const u = await makeUser(t.db);
    await keepListings(
      t.db,
      [
        {
          source: 'simplify',
          externalId: 's-old',
          companyName: 'A',
          title: 'Data Intern',
          locations: [],
          url: 'https://a.example/1',
        },
        {
          source: 'simplify',
          externalId: 's-new',
          companyName: 'A',
          title: 'ML Intern',
          locations: [],
          url: 'https://a.example/2',
        },
        {
          source: 'ashby',
          externalId: 'kept',
          companyName: 'B',
          title: 'Analyst',
          locations: [],
          url: 'https://b.example/1',
        },
        {
          source: 'ashby',
          externalId: 'gone',
          companyName: 'B',
          title: 'Analyst II',
          locations: [],
          url: 'https://b.example/2',
        },
      ],
      { now: DAY1 },
    );
    const now = new Date(DAY1.getTime() + 70 * 86_400_000);
    await t.db
      .sql`update orbit_private.jobs set last_seen_at = ${now}::timestamptz where external_id = 's-new'`;
    await t.db
      .sql`update orbit_private.jobs set closed_at = ${new Date(now.getTime() - 61 * 86_400_000)}::timestamptz
      where external_id in ('kept', 'gone')`;
    const [kept] = await jobs(`external_id = 'kept'`);
    await t.db.sql`insert into orbit.role_matches (user_id, job_id, evidence_hash, status)
      values (${u}::uuid, ${kept!.id}::uuid, 'e', 'saved')`;
    expect(await upkeep(t.db, now)).toEqual({ closed: 1, deleted: 1 });
    expect((await jobs()).map((j) => [j.external_id, !!j.closed_at])).toEqual([
      ['kept', true],
      ['s-new', false],
      ['s-old', true],
    ]);
  });
});

describe('text, on demand', () => {
  it('Greenhouse: read once, kept with its hash, then served from the table for 7 days', async () => {
    const b = await board('greenhouse', 'nimbuspay');
    const f = fakeBoards([
      greenhouseRoute(ghList),
      (u) =>
        u.pathname === '/v1/boards/nimbuspay/jobs/8172510' ? json(fixture('greenhouse-job.json')) : undefined,
    ]);
    await readBoard(t.db, net(f, DAY1), b, DAY1);
    const [role] = await jobs(`external_id = '8172510'`);
    expect(role!.text).toBeNull();
    const words = await text(t.db, net(f, DAY1), role!.id);
    expect(words).toMatch(/Nimbus Pay/);
    const [after] = await jobs(`external_id = '8172510'`);
    expect(after!.text_hash).toMatch(/^[0-9a-f]{64}$/);
    const calls = f.calls.length;
    expect(await text(t.db, net(f, DAY2), role!.id)).toBe(words);
    expect(f.calls.length).toBe(calls);
  });

  it('Workday: the detail gives the text and every place of a "2 Locations" role', async () => {
    const b = await board('workday', 'lumen.wd5.myworkdayjobs.com/lumen/LumenExternalCareerSite', 'Lumen');
    const f = fakeBoards([
      (u, init) => (init.method === 'POST' ? json(fixture('workday-page.json')) : undefined),
      (u) =>
        u.pathname.endsWith('/job/Israel-Tel-Aviv/Senior-SRE-Engineer_JR2029097')
          ? json(fixture('workday-job.json'))
          : undefined,
    ]);
    await readBoard(t.db, net(f, DAY1), b, DAY1);
    const [sre] = await jobs(`external_id = 'lumen/LumenExternalCareerSite/JR2029097'`);
    expect(sre!.places).toEqual([]);
    expect(await text(t.db, net(f, DAY1), sre!.id)).toMatch(/Kubernetes/);
    const [after] = await jobs(`external_id = 'lumen/LumenExternalCareerSite/JR2029097'`);
    expect(after!.places).toEqual(['Israel, Tel Aviv', 'Israel, Yokneam']);
    // the next list read keeps the places the detail named
    await readBoard(t.db, net(f, DAY2), b, DAY2);
    expect((await jobs(`external_id = 'lumen/LumenExternalCareerSite/JR2029097'`))[0]!.places).toEqual([
      'Israel, Tel Aviv',
      'Israel, Yokneam',
    ]);
  });

  it('LinkedIn through the student account; a role the board says is gone closes', async () => {
    const access = { base: 'https://api9.unipile.test', apiKey: 'k', accountId: 'acc' };
    const f = fakeBoards([
      (u) => (u.pathname === '/api/v1/linkedin/search' ? json(fixture('linkedin-search.json')) : undefined),
      (u) =>
        u.pathname === '/api/v1/linkedin/jobs/4478635358' ? json(fixture('linkedin-job.json')) : undefined,
    ]);
    const found = await roleSources.linkedinSearch(net(f, DAY1), access, {
      keywords: 'software engineer intern',
    });
    const kept = await roleSources.keep(t.db, found);
    const intern = kept.find((j) => j.externalId === '4478635358')!;
    expect(intern).toMatchObject({ level: 'intern', term: 'Summer 2027', remote: 'on_site' });
    expect(await roleSources.text(t.db, net(f, DAY1), intern.id)).toBeUndefined();
    expect(await roleSources.text(t.db, net(f, DAY1), intern.id, access)).toMatch(/data structures/);
    const analyst = kept.find((j) => j.externalId === '4477100001')!;
    await roleSources.text(t.db, net(f, DAY1), analyst.id, access);
    expect((await jobs(`external_id = '4477100001'`))[0]!.closed_at).not.toBeNull();
  });
});

describe('a posting by its link', () => {
  it('a board link, a page with a JobPosting block (text kept), a LinkedIn link without the account', async () => {
    const lever = fixture<Record<string, unknown>[]>('lever-page.json')[2]!;
    const f = fakeBoards([
      (u) =>
        u.pathname === '/v0/postings/halcyon/0ccbe620-a3ef-41d1-a5c4-68e56b3c91d0' ? json(lever) : undefined,
      (u) =>
        u.hostname === 'careers.orla.example'
          ? html(
              `<html><head><script type="application/ld+json">${JSON.stringify({
                '@context': 'https://schema.org',
                '@type': 'JobPosting',
                title: 'Data Analyst, New Grad',
                hiringOrganization: { '@type': 'Organization', name: 'Orla' },
                description:
                  '&lt;p&gt;You will build dashboards in SQL and Python for the growth team.&lt;/p&gt;',
                datePosted: '2026-11-20',
                jobLocation: {
                  '@type': 'Place',
                  address: { addressLocality: 'Chicago', addressRegion: 'IL', addressCountry: 'US' },
                },
              })}</script></head><body></body></html>`,
            )
          : undefined,
    ]);
    const l = await roleSources.readUrl(
      net(f, DAY1),
      'https://jobs.lever.co/halcyon/0ccbe620-a3ef-41d1-a5c4-68e56b3c91d0',
    );
    expect(l).toMatchObject({ source: 'lever', title: 'American Tech Fellowship', companyName: 'Halcyon' });
    expect('text' in l && l.text!.length).toBeGreaterThan(100);
    const page = await roleSources.readUrl(net(f, DAY1), 'https://careers.orla.example/jobs/42');
    expect(page).toMatchObject({
      source: 'posting',
      companyName: 'Orla',
      title: 'Data Analyst, New Grad',
      locations: ['Chicago, IL, US'],
      text: 'You will build dashboards in SQL and Python for the growth team.',
    });
    expect(
      await roleSources.readUrl(net(f, DAY1), 'https://www.linkedin.com/jobs/view/4478635358'),
    ).toMatchObject({
      problem: expect.stringMatching(/your own LinkedIn/),
    });
    expect(await roleSources.readUrl(net(f, DAY1), 'http://localhost/x')).toHaveProperty('problem');
  });
});

describe('the digest block', () => {
  it('counts the day and names boards failing three days running', async () => {
    const b = await board('greenhouse', 'nimbuspay');
    await readBoard(t.db, net(fakeBoards([greenhouseRoute(ghList)]), DAY1), b, DAY1);
    const bad = await board('lever', 'broken', 'Broken Co');
    await t.db
      .sql`update orbit_private.job_boards set failures = 3, last_error = 'server: HTTP 503' where id = ${bad.id}::uuid`;
    await setMark(t.db, DAY1, 'simplify_intern_done', 1);
    const d = (await rolesDigest(t.db, '2026-11-24'))!;
    expect(d).toMatchObject({
      boardsRead: 1,
      rolesAdded: 9,
      simplify: { intern: true, newgrad: false },
      failing: [{ name: 'Broken Co', service: 'lever', failures: 3, error: 'server: HTTP 503' }],
    });
    const lines = rolesDigestLines(d).join('\n');
    expect(lines).toMatch(/Boards read: 1, failed: 0/);
    expect(lines).toMatch(/Failing three days running: Broken Co/);
    expect(lines).not.toMatch(/[—!]/);
  });
});

describe('discoverSome', () => {
  it('stops at the day cap', async () => {
    for (let i = 0; i < 3; i++)
      await t.db
        .sql`insert into orbit_private.company_facts (source, source_id, key, name, website, team_size)
        values ('yc', ${String(i)}, ${`co ${i}`}, ${`Co ${i}`}, ${`co${i}.example`}, ${10 - i})`;
    await t.db
      .sql`insert into orbit_private.roles_usage (day, kind, n) values ('2026-11-24', 'src:discovery_cap', 499)`;
    const f = fakeBoards([]);
    const s = await discoverSome(t.db, net(f, DAY1), DAY1, {
      clock: f.clock,
      deadline: f.clock() + 60_000,
      maxCompanies: 5,
    });
    expect(s).toMatchObject({ looked: 1, stoppedBy: 'cap' });
  });
});

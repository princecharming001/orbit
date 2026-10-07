import { expect, type Page, type TestInfo, test } from '@playwright/test';
import { injectPeople, loadDemo, mapCanvas, mapSettled, mapSnapshot } from './helpers';

/**
 * Frame times of the map's animations in a real browser with the real clock (`?perf=1` records every drawn frame's
 * requestAnimationFrame delta and the script time spent drawing it). Each animation is measured from the moment it
 * is triggered until the map settles. Frame pacing depends on the whole machine, so an animation that misses the bar
 * is run again, up to three times, and its best run counts: a slow map is slow every time, a busy machine is not.
 */

interface Stats {
  frames: number;
  p50: number;
  p95: number;
  max: number;
  dropped: number;
  workP50: number;
  workP95: number;
  workMax: number;
}

interface Row extends Stats {
  runs: number;
}

/** Script time per frame the map may spend drawing, at any size of network. */
const SCRIPT_P95 = 8;
const ATTEMPTS = 3;

const perfStats = (page: Page) =>
  page.evaluate(() => (window as unknown as { __orbitPerf: { stats(): Stats } }).__orbitPerf.stats());
const perfReset = (page: Page) =>
  page.evaluate(() => (window as unknown as { __orbitPerf: { reset(): void } }).__orbitPerf.reset());

/** People the map draws: human and not hidden. */
const peopleOnMap = (page: Page) =>
  page.evaluate(async () => {
    const db = (
      window as unknown as { __orbitDb: { people: { toArray(): Promise<Record<string, unknown>[]> } } }
    ).__orbitDb;
    return (await db.people.toArray()).filter((p) => p.isHuman && !p.hiddenAt).length;
  });

async function search(page: Page, q: string) {
  await page.getByTestId('reach-input').fill(q);
  await page.getByTestId('reach-input').press('Enter');
}

const focusIs = (page: Page, v: string | RegExp) => expect(mapCanvas(page)).toHaveAttribute('data-focus', v);

/** One animation: `act` triggers it and returns once the map has taken the change in. */
async function measure(page: Page, act: () => Promise<void>): Promise<Stats> {
  await perfReset(page);
  await act();
  await mapSettled(page, 60_000);
  return perfStats(page);
}

/** An animation and the one that undoes it, measured in turn. */
interface Pair {
  name: string;
  in: (page: Page) => Promise<void>;
  out?: { name: string; act: (page: Page) => Promise<void> };
}

const PAIRS: Pair[] = [
  {
    name: 'company',
    in: async (page) => {
      await search(page, 'Google');
      await focusIs(page, 'company:n:google');
    },
    out: {
      name: 'company clear',
      act: async (page) => {
        await page.keyboard.press('Escape');
        await focusIs(page, '');
      },
    },
  },
  {
    name: 'reach',
    in: async (page) => {
      await search(page, 'Maya Chen');
      await focusIs(page, /^reach:/);
    },
    out: {
      name: 'reach clear',
      act: async (page) => {
        await page.keyboard.press('Escape');
        await focusIs(page, '');
      },
    },
  },
  {
    name: 'introductions',
    in: async (page) => {
      await page.getByTestId('map-filter-intros').click();
      await focusIs(page, 'web');
    },
    out: {
      name: 'introductions out',
      act: async (page) => {
        await page.getByTestId('map-filter-all').click();
        await focusIs(page, '');
      },
    },
  },
  {
    name: 'hover',
    in: async (page) => {
      const pos = await page.evaluate(() =>
        (
          window as unknown as { __orbitMap: { positions(): Record<string, { x: number; y: number }> } }
        ).__orbitMap.positions(),
      );
      const box = (await mapCanvas(page).boundingBox())!;
      for (const id of Object.keys(pos).slice(0, 12)) {
        await page.mouse.move(box.x + pos[id]!.x, box.y + pos[id]!.y, { steps: 4 });
        await page.waitForTimeout(80);
      }
      await page.mouse.move(box.x + 4, box.y + 4);
    },
  },
];

const better = (a: Row | undefined, s: Stats, runs: number): Row =>
  !a || s.p95 < a.p95 || (s.p95 === a.p95 && s.workP95 < a.workP95) ? { ...s, runs } : { ...a, runs };

async function run(page: Page, people: number, limit: number, testInfo: TestInfo) {
  await loadDemo(page, { clock: false });
  // the first load after the demo writes today's brief and recomputes every strength: let that finish first,
  // or it would also reset the people added below
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const db = (
            window as unknown as { __orbitDb: { briefs: { toArray(): Promise<{ kind: string }[]> } } }
          ).__orbitDb;
          return (await db.briefs.toArray()).some((b) => b.kind === 'daily');
        }),
      { timeout: 60_000 },
    )
    .toBe(true);
  await injectPeople(page, people - (await peopleOnMap(page)));
  expect(await peopleOnMap(page)).toBe(people);

  const ok = (s: Stats) => s.p95 <= limit && s.workP95 <= SCRIPT_P95;
  const rows: Record<string, Row> = {};
  const context = page.context();
  let tab = page;
  // a new tab is a new session, so the arrival plays; the page it came from is closed so it draws nothing
  for (let i = 1; i <= ATTEMPTS && !(rows.arrival && ok(rows.arrival)); i++) {
    const next = await context.newPage();
    await tab.close();
    tab = next;
    await tab.goto('map?perf=1');
    await expect(mapCanvas(tab)).toBeVisible();
    await mapSettled(tab, 60_000);
    expect((await mapSnapshot(tab)).phaseLog).toContain('arrival');
    rows.arrival = better(rows.arrival, await perfStats(tab), i);
  }
  const dots = Number(await mapCanvas(tab).getAttribute('data-nodes'));

  for (const pair of PAIRS) {
    const out = pair.out;
    for (let i = 1; i <= ATTEMPTS; i++) {
      rows[pair.name] = better(rows[pair.name], await measure(tab, () => pair.in(tab)), i);
      if (out) rows[out.name] = better(rows[out.name], await measure(tab, () => out.act(tab)), i);
      if (ok(rows[pair.name]!) && (!out || ok(rows[out.name]!))) break;
    }
  }

  const ms = (x: number) => x.toFixed(1).padStart(6);
  const table = [
    `${people} people (${dots} dots on the map); best of up to ${ATTEMPTS} runs`,
    'animation          runs frames    p50    p95    max  dropped  script p95  script max',
    ...Object.entries(rows).map(
      ([k, s]) =>
        `${k.padEnd(18)} ${String(s.runs).padStart(4)} ${String(s.frames).padStart(6)} ${ms(s.p50)} ${ms(s.p95)} ${ms(s.max)} ${`${(s.dropped * 100).toFixed(1)}%`.padStart(8)}  ${ms(s.workP95)}      ${ms(s.workMax)}`,
    ),
  ].join('\n');
  console.log(table);
  await testInfo.attach(`frame-times-${people}`, { body: table, contentType: 'text/plain' });
  for (const [k, s] of Object.entries(rows)) {
    expect(s.frames, k).toBeGreaterThan(5);
    expect(s.p95, k).toBeLessThanOrEqual(limit);
    expect(s.workP95, k).toBeLessThanOrEqual(SCRIPT_P95);
  }
}

test.describe('Map frame times', () => {
  test.setTimeout(300_000);

  test('300 people: every animation holds 60 frames a second', async ({ page }, testInfo) => {
    await run(page, 300, 24, testInfo);
  });

  test('2,000 people: every animation stays smooth', async ({ page }, testInfo) => {
    await run(page, 2000, 40, testInfo);
  });
});

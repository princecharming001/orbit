import { expect, type Page, test } from '@playwright/test';
import {
  angleFromCentre,
  briefWritten,
  degreesApart,
  injectPeople,
  loadDemo,
  mapCanvas,
  mapDots,
  mapHitTest,
  mapSettled,
  mapSlot,
  mapSnapshot,
  mapStageColor,
  nextRender,
  screenDots,
} from './helpers';

/** People by display name, straight from the app's database (ids are the demo's, never hard-coded). */
async function idsByName<N extends string>(page: Page, names: N[]): Promise<Record<N, string>> {
  const found = await page.evaluate(async (names) => {
    const db = (
      window as unknown as {
        __orbitDb: { people: { toArray(): Promise<{ id: string; displayName: string }[]> } };
      }
    ).__orbitDb;
    const all = await db.people.toArray();
    return names.map((n) => all.find((p) => p.displayName === n)?.id ?? '');
  }, names);
  const out = {} as Record<N, string>;
  names.forEach((n, i) => {
    if (!found[i]) throw new Error(`no one called ${n} in the demo`);
    out[n] = found[i];
  });
  return out;
}

async function openMap(page: Page) {
  await page.goto('map');
  await expect(mapCanvas(page)).toBeVisible();
  await mapSettled(page);
}

async function search(page: Page, q: string) {
  await page.getByTestId('reach-input').fill(q);
  await page.getByTestId('reach-input').press('Enter');
}

/** Pause the page clock: from here on, time only moves when the test steps it. */
async function pauseClock(page: Page) {
  // the page clock keeps running while this reads it: on a busy machine "50 ms from now" can already be past
  for (const ahead of [50, 250, 1000]) {
    const now = await page.evaluate(() => Date.now());
    try {
      await page.clock.pauseAt(new Date(now + ahead));
      return;
    } catch (e) {
      if (!String(e).includes('past') || ahead === 1000) throw e;
    }
  }
}

/** Escape, then wait for the page to apply it before waiting for the map to settle (React applies it a beat later). */
async function escapeTo(page: Page, focus: string) {
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await mapSnapshot(page)).focus).toBe(focus);
}

/** With the clock paused: step it a frame at a time until `check` passes. */
async function stepUntil(page: Page, check: () => Promise<boolean>, maxMs = 3000) {
  for (let t = 0; t <= maxMs; t += 16) {
    if (await check()) return;
    await page.clock.runFor(16);
  }
  throw new Error(`still waiting after ${maxMs} ms of animation time`);
}

/** With the clock paused: step it until nothing on the map is in transition. */
async function stepUntilSettled(page: Page, maxMs = 8000) {
  for (let t = 0; t <= maxMs; t += 100) {
    if ((await mapCanvas(page).getAttribute('data-animating')) === 'false') return;
    await page.clock.runFor(100);
  }
  throw new Error(`the map was still moving after ${maxMs} ms of animation time`);
}

/**
 * Steps the paused clock one frame at a time and records how far each dot moves on screen per frame. Every sample is
 * taken after a real rendering step, so the map has been told about any layout change, as it is before a paint.
 */
async function stepAndMeasure(page: Page, ids: string[], frames: number, into: number[]) {
  await nextRender(page);
  let prev = await screenDots(page, ids);
  for (let i = 0; i < frames; i++) {
    await page.clock.runFor(16);
    await nextRender(page);
    const cur = await screenDots(page, ids);
    let max = 0;
    for (const id of ids) {
      const a = prev[id];
      const b = cur[id];
      if (a && b && a.alpha > 0.05 && b.alpha > 0.05) max = Math.max(max, Math.hypot(b.x - a.x, b.y - a.y));
    }
    into.push(max);
    prev = cur;
  }
}

/** True when a dot (page px) is at least partly under a box on the page. */
function under(
  box: { x: number; y: number; width: number; height: number },
  d: { x: number; y: number; r: number },
) {
  return (
    d.x + d.r > box.x && d.x - d.r < box.x + box.width && d.y + d.r > box.y && d.y - d.r < box.y + box.height
  );
}

/** Per-frame travel stays smooth: it moved, it never snapped, and no frame stands out from both of its neighbours. */
function expectSmooth(moves: number[], max: number, label: string) {
  expect(Math.max(...moves), label).toBeGreaterThan(2);
  expect(Math.max(...moves), label).toBeLessThan(max);
  for (let i = 1; i < moves.length - 1; i++) {
    if (moves[i]! < 12) continue;
    expect(moves[i]!, `${label}, frame ${i}: ${moves.slice(i - 2, i + 3).join(', ')}`).toBeLessThanOrEqual(
      3 * Math.max(moves[i - 1]!, moves[i + 1]!),
    );
  }
}

/** Circular mean of the dots' angles around the centre, in degrees. */
function meanAngle(dots: { x: number; y: number }[], centre: [number, number]): number {
  let sx = 0;
  let sy = 0;
  for (const d of dots) {
    const a = (angleFromCentre({ ...d, r: 0, alpha: 1 }, { x: centre[0], y: centre[1] }) * Math.PI) / 180;
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  return (Math.atan2(sy, sx) * 180) / Math.PI;
}

test.describe('Map motion', () => {
  test('the first visit of a session plays the arrival once; a click finishes it at once', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.getByRole('link', { name: /^map$/i }).first().click();
    await expect(mapCanvas(page)).toBeVisible();
    await mapSettled(page);
    const first = await mapSnapshot(page);
    expect(first.phaseLog).toContain('arrival');
    expect(first.phaseLog.indexOf('loading')).toBeLessThan(first.phaseLog.indexOf('arrival'));
    // the end state: every person on the map, fully drawn, labels in, none clipped
    const dots = await mapDots(page);
    expect(Object.keys(dots).length).toBe(first.nodes);
    for (const d of Object.values(dots)) expect(d.alpha).toBeGreaterThan(0.95);
    expect(Number(await mapCanvas(page).getAttribute('data-labels'))).toBeGreaterThan(0);
    await expect(mapCanvas(page)).toHaveAttribute('data-labels-clipped', '0');
    // only once per session: back from another page, the people are simply there
    await page
      .getByRole('link', { name: /^today$/i })
      .first()
      .click();
    await page.getByRole('link', { name: /^map$/i }).first().click();
    await mapSettled(page);
    expect((await mapSnapshot(page)).phaseLog).not.toContain('arrival');

    // a new tab is a new session: the arrival plays again, and a click finishes it at once
    const tab = await page.context().newPage();
    await tab.goto('map');
    await expect
      .poll(async () => (await mapSnapshot(tab).catch(() => undefined))?.phase, {
        timeout: 15_000,
        intervals: [50],
      })
      .toBe('arrival');
    // a click on an empty corner, so no dot ends up under the pointer
    const box = (await mapCanvas(tab).boundingBox())!;
    await tab.mouse.click(box.x + 6, box.y + 6);
    await mapSettled(tab, 600);
    const done = await mapSnapshot(tab);
    expect(done.phaseLog).toContain('arrival');
    for (const d of Object.values(await mapDots(tab))) expect(d.alpha).toBeGreaterThan(0.95);
    await expect(tab).toHaveURL(/\/map$/);
    await tab.close();
  });

  test('the arrival is over within 1.4 s, and "You" never shrinks as it starts', async ({ page }) => {
    await loadDemo(page);
    await page.goto('map');
    await expect
      .poll(async () => (await mapSnapshot(page).catch(() => undefined))?.phase, {
        timeout: 15_000,
        intervals: [20],
      })
      .toBe('arrival');
    await pauseClock(page);
    // "You" swells once from the size it had while loading, then settles back
    const centre = () =>
      page.evaluate(() => {
        const c = document.querySelector('[data-testid="orbit-canvas"]') as HTMLCanvasElement;
        const ctx = c.getContext('2d')!;
        const s = (
          window as unknown as { __orbitMap: { snapshot(): { centre: [number, number] } } }
        ).__orbitMap.snapshot();
        const dpr = window.devicePixelRatio || 1;
        // the radius of the accent disc: walk right from the centre until the pixel is no longer the accent
        let r = 0;
        for (let x = 0; x < 60; x++) {
          const d = ctx.getImageData(
            Math.round((s.centre[0] + x) * dpr),
            Math.round(s.centre[1] * dpr - 10 * dpr),
            1,
            1,
          ).data;
          if (!(d[2]! > 180 && d[0]! < 120)) break;
          r = x;
        }
        return r;
      });
    const sizes: number[] = [await centre()];
    let elapsed = 0;
    for (; elapsed <= 2000; elapsed += 16) {
      if ((await mapCanvas(page).getAttribute('data-animating')) === 'false') break;
      await page.clock.runFor(16);
      if (elapsed < 400) sizes.push(await centre());
    }
    expect(elapsed).toBeLessThanOrEqual(1400);
    for (let i = 1; i < sizes.length; i++)
      expect(sizes[i]!, sizes.join(', ')).toBeGreaterThanOrEqual(sizes[0]! - 2);
  });

  test('a company search turns its wedge to the top, pops its people, shows the count chip; Esc reverses it', async ({
    page,
  }) => {
    await loadDemo(page);
    await openMap(page);
    const before = await mapSnapshot(page);
    await search(page, 'Stripe');
    await expect(page.getByText(/people there now/i)).toBeVisible();
    await mapSettled(page);
    const snap = await mapSnapshot(page);
    expect(snap.focus).toBe('company:n:stripe');
    expect(snap.phaseLog).toContain('company');
    // the people emphasised are exactly the people at Stripe
    const stripe: string[] = await page.evaluate(async () => {
      const db = (
        window as unknown as { __orbitDb: { people: { toArray(): Promise<Record<string, unknown>[]> } } }
      ).__orbitDb;
      return (await db.people.toArray())
        .filter((p) => p.currentOrganizationId === 'org_stripe' && p.isHuman && !p.hiddenAt)
        .map((p) => p.id as string);
    });
    expect(new Set(snap.emphasized)).toEqual(new Set(stripe));
    const chip = (await mapCanvas(page).getAttribute('data-chip')) ?? '';
    expect(chip).toMatch(new RegExp(`^${stripe.length} at Stripe( · \\d+ warm)?$`));
    await expect(page.getByTestId('map-legend-line')).toHaveText(
      new RegExp(`Showing ${stripe.length} people at Stripe`),
    );
    // the wedge sits at twelve o'clock
    const dots = Object.values(await mapDots(page, stripe));
    expect(degreesApart(meanAngle(dots, snap.centre), -90)).toBeLessThan(25);
    // everyone else is faded back
    expect(snap.dimmed).toBe(snap.nodes - stripe.length);
    // the panel can list everyone the map lights up, not only the first six
    const there = page.getByText(/people there now · \d+/i);
    const n = Number((await there.textContent())!.match(/(\d+)/)![1]);
    if (n > 6) {
      await page.getByTestId('company-show-all').first().click();
      await expect(there.locator('xpath=..').locator('li')).toHaveCount(n);
    }

    await escapeTo(page, '');
    await mapSettled(page);
    const after = await mapSnapshot(page);
    expect(after.focus).toBe('');
    expect(after.emphasized).toEqual([]);
    expect(after.dimmed).toBe(0);
    await expect(mapCanvas(page)).toHaveAttribute('data-chip', '');
    expect(after.phaseLog).toContain('company-out');
    // the orbit turned back to where it was (it drifts slowly, so allow a little)
    const turned = Math.abs(((after.rotation - before.rotation + Math.PI) % (2 * Math.PI)) - Math.PI);
    expect(turned).toBeLessThan(0.05);
  });

  test('Esc right after a company search cancels it: the late lookup never brings it back', async ({
    page,
  }) => {
    await loadDemo(page);
    await openMap(page);
    await search(page, 'Stripe');
    // the map turns at once, before the panel's lookup is done
    await expect.poll(async () => (await mapSnapshot(page)).focus).toBe('company:n:stripe');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await mapSnapshot(page)).focus).toBe('');
    await mapSettled(page);
    await page.waitForTimeout(500);
    expect((await mapSnapshot(page)).focus).toBe('');
    await expect(page).toHaveURL(/\/map$/);
    await expect(page.getByTestId('map-legend-line')).toHaveText(/everyone you know/i);
    // a company search followed at once by a person: the person's route stays
    await search(page, 'Stripe');
    await search(page, 'Maya Chen');
    await expect.poll(async () => (await mapSnapshot(page)).focus).toMatch(/^reach:/);
    await page.waitForTimeout(800);
    expect((await mapSnapshot(page)).focus).toMatch(/^reach:/);
  });

  test('interrupting a focus never makes a dot jump', async ({ page }) => {
    await loadDemo(page);
    await openMap(page);
    await pauseClock(page);
    const ids = Object.keys(await mapDots(page)).slice(0, 70);
    const moves: number[] = [];
    await search(page, 'Stripe');
    await expect(page.getByText(/people there now/i)).toBeVisible();
    await stepAndMeasure(page, ids, 14, moves);
    // mid-turn, a second company: everything heads for the new target from where it is
    await search(page, 'Datadog');
    await expect(page.getByTestId('map-legend-line')).toHaveText(/at Datadog/);
    await stepAndMeasure(page, ids, 45, moves);
    // and Esc mid-way back home
    await page.keyboard.press('Escape');
    await stepAndMeasure(page, ids, 45, moves);
    expect(Math.max(...moves)).toBeGreaterThan(5); // it did move
    // the fastest turn covers about 33 px per 16 ms frame; a snap would be several times that
    expect(Math.max(...moves)).toBeLessThan(48);
    // no frame stands out from both of its neighbours: speed changes smoothly
    for (let i = 1; i < moves.length - 1; i++) {
      if (moves[i]! < 12) continue;
      expect(moves[i]!, `frame ${i}: ${moves.slice(i - 2, i + 3).join(', ')}`).toBeLessThanOrEqual(
        3 * Math.max(moves[i - 1]!, moves[i + 1]!),
      );
    }
  });

  test('a search that finds no one says so on the page and shakes the search box', async ({ page }) => {
    await loadDemo(page);
    await openMap(page);
    await search(page, 'Zzyzx Nobody');
    await expect(page.getByTestId('map-legend-line')).toHaveText(
      'No one matches “Zzyzx Nobody” in your network yet.',
    );
    await expect(page.getByTestId('reach-form')).toHaveClass(/shake-x/);
    // typing again puts the line back
    await page.getByTestId('reach-input').fill('Zzy');
    await expect(page.getByTestId('map-legend-line')).toHaveText(/everyone you know/i);
    await expect(page.getByTestId('reach-form')).not.toHaveClass(/shake-x/);
  });

  test('a search that finds someone takes down the toast an earlier miss left up', async ({ page }) => {
    await loadDemo(page);
    await openMap(page);
    const toast = page.getByTestId('toasts').getByText(/no one by that name or company/i);
    await search(page, 'Zzyzx Nobody');
    await expect(toast).toBeVisible();
    await search(page, 'Stripe');
    await expect(page.getByTestId('map-legend-line')).toHaveText(/Showing \d+ people at Stripe/);
    await expect(toast).toHaveCount(0);
  });

  test('the company panel names the same route, with the same hops, that Reach then shows', async ({
    page,
  }) => {
    await loadDemo(page);
    await openMap(page);
    await search(page, 'Stripe');
    const row = page.getByTestId('company-routes').locator('li').first();
    await expect(row).toBeVisible();
    await expect(page.getByText(/two-hop/i)).toHaveCount(0);
    const text = await row.innerText();
    const hops = Number(/(\d+) hops?, via/.exec(text)?.[1]);
    expect(hops).toBeGreaterThan(1);
    const vias = text.split(', via ')[1]!.split(' then ');
    await row.getByRole('button').click();
    const first = page.getByTestId('reach-path').first();
    await expect(first).toContainText(`Route 1 · ${hops} hops`);
    for (const v of vias) await expect(first).toContainText(v.trim());
  });

  test('the person card sits near the hovered dot without hiding the people right round it', async ({
    page,
  }) => {
    await loadDemo(page);
    await openMap(page);
    const { 'Maya Chen': maya } = await idsByName(page, ['Maya Chen']);
    const box = (await mapCanvas(page).boundingBox())!;
    const at = (await mapDots(page, [maya]))[maya]!;
    await page.mouse.move(box.x + at.x, box.y + at.y);
    const card = page.getByTestId('map-tooltip');
    await expect(card).toContainText('Maya Chen');
    await expect(card).toHaveAttribute('data-place', 'beside');
    await mapSettled(page);
    const c = (await card.boundingBox())!;
    const dots = await mapDots(page);
    const dot = dots[maya]!;
    const x = box.x + dot.x;
    const y = box.y + dot.y;
    // the gap between the dot and the card's nearest edge: close enough that the eye does not cross the map
    const dx = Math.max(c.x - x, 0, x - (c.x + c.width));
    const dy = Math.max(c.y - y, 0, y - (c.y + c.height));
    expect(Math.hypot(dx, dy)).toBeGreaterThan(dot.r);
    expect(Math.hypot(dx, dy)).toBeLessThan(180);
    // nobody sitting right next to her is under the card
    const hidden = Object.entries(dots).filter(
      ([id, d]) =>
        id !== maya &&
        d.alpha > 0.3 &&
        Math.hypot(d.x - dot.x, d.y - dot.y) < 70 &&
        under(c, { ...d, x: box.x + d.x, y: box.y + d.y }),
    );
    expect(hidden.map(([id]) => id)).toEqual([]);
  });

  test('with keyboard focus, the person card never hides the dots the arrow keys go to next', async ({
    page,
  }) => {
    await loadDemo(page);
    await openMap(page);
    await mapCanvas(page).focus();
    await page.keyboard.press('Home');
    const card = page.getByTestId('map-tooltip');
    const seen = new Set<string>();
    for (const key of [
      '',
      'ArrowRight',
      'ArrowDown',
      'ArrowLeft',
      'ArrowUp',
      'ArrowUp',
      'ArrowRight',
      'ArrowDown',
    ]) {
      if (key) await page.keyboard.press(key);
      const id = (await mapSnapshot(page)).hover!;
      seen.add(id);
      await expect(card).toBeVisible();
      const c = (await card.boundingBox())!;
      const box = (await mapCanvas(page).boundingBox())!;
      const next: string[] = await page.evaluate(
        (id) =>
          (
            [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ] as const
          )
            .map(([dx, dy]) =>
              (
                window as unknown as {
                  __orbitMap: { neighbour(id: string, dx: number, dy: number): string | undefined };
                }
              ).__orbitMap.neighbour(id, dx, dy),
            )
            .filter((n): n is string => !!n && n !== id),
        id,
      );
      expect(next.length).toBeGreaterThan(0);
      const dots = await mapDots(page, [id, ...next]);
      expect(under(c, { ...dots[id]!, x: box.x + dots[id]!.x, y: box.y + dots[id]!.y }), id).toBe(false);
      for (const n of next)
        expect(
          under(c, { ...dots[n]!, x: box.x + dots[n]!.x, y: box.y + dots[n]!.y }),
          `${key} ${id} > ${n}`,
        ).toBe(false);
    }
    expect(seen.size).toBeGreaterThan(2);
  });

  test('with a filter on, the arrow keys walk only the people it shows, and the subtitle counts them', async ({
    page,
  }) => {
    await loadDemo(page);
    await openMap(page);
    const alumni: string[] = await page.evaluate(async () => {
      const db = (
        window as unknown as { __orbitDb: { people: { toArray(): Promise<Record<string, unknown>[]> } } }
      ).__orbitDb;
      return (await db.people.toArray())
        .filter((p) => p.isAlumni && p.isHuman && !p.hiddenAt)
        .map((p) => p.id as string);
    });
    const all = Object.keys(await mapDots(page)).length;
    await page.getByTestId('map-filter-alumni').click();
    await mapSettled(page);
    await expect(page.getByText(`${alumni.length} of ${all} people shown`)).toBeVisible();
    await mapCanvas(page).focus();
    const seen = new Set<string>();
    for (const key of [
      'Home',
      'ArrowRight',
      'ArrowRight',
      'ArrowDown',
      'ArrowLeft',
      'ArrowUp',
      'ArrowRight',
    ]) {
      await page.keyboard.press(key);
      const id = (await mapSnapshot(page)).hover;
      expect(id).toBeTruthy();
      seen.add(id!);
    }
    expect(seen.size).toBeGreaterThan(2);
    for (const id of seen) expect(alumni).toContain(id);
  });

  test('every animation carries on from where the dots are when another one interrupts it', async ({
    page,
  }) => {
    await loadDemo(page);
    await openMap(page);
    const ids = Object.keys(await mapDots(page)).slice(0, 70);
    await pauseClock(page);
    // a route, then a company before the route has finished drawing
    let moves: number[] = [];
    await search(page, 'Maya Chen');
    await expect(page.getByTestId('reach-path').first()).toBeVisible();
    await stepAndMeasure(page, ids, 30, moves);
    await page.getByTestId('reach-path').nth(1).click();
    await stepAndMeasure(page, ids, 12, moves);
    await search(page, 'Stripe');
    await expect(page.getByTestId('map-legend-line')).toHaveText(/at Stripe/);
    await stepAndMeasure(page, ids, 50, moves);
    expectSmooth(moves, 80, 'route, route switch, company');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await mapSnapshot(page)).focus).toBe('');
    await stepUntilSettled(page);
    // the introductions view, and a filter before its people have reached the tree
    moves = [];
    await page.getByTestId('map-filter-intros').click();
    await stepAndMeasure(page, ids, 20, moves);
    await page.getByTestId('map-filter-alumni').click();
    await stepAndMeasure(page, ids, 50, moves);
    expectSmooth(moves, 80, 'introductions, then a filter');
    await stepUntilSettled(page);
  });

  test('a search during the arrival takes the dots from where they are', async ({ page }) => {
    await loadDemo(page);
    await page.goto('map');
    await expect
      .poll(async () => (await mapSnapshot(page).catch(() => undefined))?.phase, {
        timeout: 15_000,
        intervals: [20],
      })
      .toBe('arrival');
    await pauseClock(page);
    const ids = Object.keys(await mapDots(page)).slice(0, 70);
    const moves: number[] = [];
    await stepAndMeasure(page, ids, 20, moves);
    await search(page, 'Stripe');
    await expect(page.getByTestId('map-legend-line')).toHaveText(/at Stripe/);
    await stepAndMeasure(page, ids, 60, moves);
    // the arrival's own spiral is the fastest travel on the map
    expectSmooth(moves, 70, 'arrival, then a company');
    await stepUntilSettled(page);
    expect((await mapSnapshot(page)).focus).toBe('company:n:stripe');
  });

  test('reach draws the route hop by hop with the target at the top; switching routes morphs', async ({
    page,
  }) => {
    await loadDemo(page);
    await openMap(page);
    const { 'Maya Chen': maya } = await idsByName(page, ['Maya Chen']);
    await search(page, 'Maya Chen');
    await expect(page.getByTestId('reach-path').first()).toBeVisible({ timeout: 15_000 });
    await mapSettled(page);
    let snap = await mapSnapshot(page);
    expect(snap.focus).toBe(`reach:${maya}:found`);
    expect(snap.phaseLog).toEqual(expect.arrayContaining(['reach-search', 'reach-path']));
    expect(snap.phaseLog.indexOf('reach-search')).toBeLessThan(snap.phaseLog.lastIndexOf('reach-path'));
    expect(snap.path[0]).toBe('user');
    expect(snap.path[snap.path.length - 1]).toBe(maya);
    expect(snap.pathDrawn).toBe(snap.path.length - 1);
    for (const id of snap.path.slice(1)) expect(snap.emphasized).toContain(id);
    // everyone on the route is named on the map, so the panel's words match the dots
    const names: string[] = await page.evaluate(async (ids) => {
      const db = (
        window as unknown as {
          __orbitDb: { people: { toArray(): Promise<{ id: string; firstName: string }[]> } };
        }
      ).__orbitDb;
      const all = await db.people.toArray();
      return ids.map((id) => all.find((p) => p.id === id)!.firstName);
    }, snap.path.slice(1));
    for (const n of names) expect(snap.tags.some((t) => t.startsWith(n))).toBe(true);
    const target = (await mapDots(page, [maya]))[maya]!;
    expect(degreesApart(angleFromCentre(target, { x: snap.centre[0], y: snap.centre[1] }), -90)).toBeLessThan(
      10,
    );
    const first = snap.path.join('>');

    // another route: the old one retracts and the new one draws
    const routes = page.getByTestId('reach-path');
    expect(await routes.count()).toBeGreaterThan(1);
    await routes.nth(1).click();
    await expect(mapCanvas(page)).not.toHaveAttribute('data-path', first);
    await mapSettled(page);
    snap = await mapSnapshot(page);
    expect(snap.path.join('>')).not.toBe(first);
    expect(snap.path[snap.path.length - 1]).toBe(maya);
    expect(snap.pathDrawn).toBe(snap.path.length - 1);
    // every dot on the route is fully drawn
    const onRoute = await mapDots(page, snap.path.slice(1));
    for (const d of Object.values(onRoute)) expect(d.alpha).toBeGreaterThan(0.95);
  });

  test('on a laptop with the demo banner showing, the map fits the window and the page never scrolls under it', async ({
    page,
  }) => {
    await loadDemo(page);
    await openMap(page);
    await expect(page.getByTestId('demo-banner')).toBeVisible();
    const fits = () =>
      page.evaluate(() => {
        const main = document.querySelector('main')!;
        const canvas = document.querySelector('[data-testid="orbit-canvas"]')!.getBoundingClientRect();
        return {
          overflow: main.scrollHeight - main.clientHeight,
          below: Math.round(canvas.bottom - window.innerHeight),
          scrolled: main.scrollTop + window.scrollY,
        };
      });
    expect(await fits()).toEqual({ overflow: 0, below: expect.any(Number), scrolled: 0 });
    expect((await fits()).below).toBeLessThanOrEqual(1);
    // a route picked lower in the panel, and the keyboard on the canvas, leave the page where it is
    await search(page, 'Felix Garcia');
    await expect(page.getByTestId('reach-path').nth(2)).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('reach-path').nth(2).click();
    await mapCanvas(page).focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    const after = await fits();
    expect(after.scrolled).toBe(0);
    expect(after.overflow).toBe(0);
    await expect(page.getByRole('heading', { name: 'Reach' })).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId('reach-input')).toBeInViewport({ ratio: 1 });
  });

  test('picking another route morphs: the map always shows a route, and the new one is drawn in under a second', async ({
    page,
  }) => {
    await loadDemo(page);
    await openMap(page);
    await search(page, 'Felix Garcia');
    await expect(page.getByTestId('reach-path').nth(1)).toBeVisible({ timeout: 15_000 });
    await mapSettled(page);
    const first = (await mapSnapshot(page)).path.join('>');
    await pauseClock(page);
    for (const pick of [1, 0]) {
      const before = (await mapSnapshot(page)).path.join('>');
      await page.getByTestId('reach-path').nth(pick).click();
      await expect.poll(async () => (await mapSnapshot(page)).path.join('>')).not.toBe(before);
      const frames: string[] = [];
      let done = -1;
      for (let t = 0; t <= 1200; t += 16) {
        const s = await mapSnapshot(page);
        const hops = s.path.length - 1;
        frames.push(`${t}:${s.pathDrawn.toFixed(2)}/${s.pathOldDrawn.toFixed(2)}`);
        // the old route pulls back while the new one draws: never a moment with no route on the map
        expect(Math.max(s.pathDrawn, s.pathOldDrawn), frames.join(' ')).toBeGreaterThan(0.4);
        if (s.pathDrawn >= hops && done < 0) done = t;
        await page.clock.runFor(16);
      }
      expect(done, frames.join(' ')).toBeGreaterThanOrEqual(0);
      expect(done, frames.join(' ')).toBeLessThan(900);
      if (!pick) expect((await mapSnapshot(page)).path.join('>')).toBe(first);
    }
  });

  test('a contact the student barely knows: Reach says why the routes go through others, and offers the direct note last', async ({
    page,
  }) => {
    await loadDemo(page);
    await openMap(page);
    await search(page, 'Felix Garcia');
    const routes = page.getByTestId('reach-path');
    await expect(routes.first()).toBeVisible({ timeout: 15_000 });
    await expect(routes.first()).toContainText('3 hops');
    const note = page.getByTestId('reach-cold-note');
    await expect(note).toContainText(/connected with Felix on LinkedIn/);
    await expect(note).toContainText(/routes through people you know come first/);
    const last = routes.last();
    await expect(last).toContainText('1 hop');
    await expect(last).toContainText('Cold tie');
    await expect(note).toContainText(`Route ${await routes.count()}`);
    await last.click();
    await expect(page.getByTestId('map-legend-line')).toHaveText(/only slightly/);
    await expect(page.getByRole('button', { name: 'Write to Felix directly' })).toBeVisible();
    // the company panel says why it lists a route to someone it also lists as there now
    await search(page, 'Stripe');
    await expect(page.getByTestId('company-routes')).toBeVisible();
    await expect(page.getByTestId('company-routes-why')).toContainText(/know these people only slightly/);
  });

  test('a search that finds no one takes the old route away; one with several matches lights them on the map', async ({
    page,
  }) => {
    await loadDemo(page);
    await openMap(page);
    await search(page, 'Felix Garcia');
    await expect(page.getByTestId('reach-path').first()).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => (await mapSnapshot(page)).path.length).toBeGreaterThan(1);
    await search(page, 'Zzqx Corp');
    await expect(page.getByTestId('map-legend-line')).toHaveText(/No one matches/);
    await expect(page.getByTestId('reach-path')).toHaveCount(0);
    await expect.poll(async () => (await mapSnapshot(page)).focus).toBe('');
    await mapSettled(page);
    expect((await mapSnapshot(page)).path).toEqual([]);
    await search(page, 'Ines');
    await expect(page.getByTestId('reach-choice').first()).toBeVisible();
    await expect(page.getByTestId('map-legend-line')).toHaveText(/lit on the map/);
    const ines = await page.evaluate(async () => {
      const db = (
        window as unknown as {
          __orbitDb: {
            people: { toArray(): Promise<{ id: string; firstName?: string; isHuman: boolean }[]> };
          };
        }
      ).__orbitDb;
      return (await db.people.toArray()).filter((p) => p.isHuman && p.firstName === 'Ines').map((p) => p.id);
    });
    expect(ines.length).toBeGreaterThanOrEqual(2);
    await mapSettled(page);
    const dots = await mapDots(page);
    for (const id of ines) expect(dots[id]!.alpha, id).toBeGreaterThan(0.9);
    const faded = Object.entries(dots).filter(([id, d]) => !ines.includes(id) && d.alpha < 0.5);
    expect(faded.length).toBeGreaterThan(Object.keys(dots).length / 2);
  });

  test('people on a route who sit side by side step apart, so every hop shows, and step back after', async ({
    page,
  }) => {
    await loadDemo(page);
    await openMap(page);
    // a route of three hops through two connectors (the demo has several)
    const names: string[] = await page.evaluate(async () => {
      const db = (
        window as unknown as {
          __orbitDb: {
            people: { toArray(): Promise<{ displayName: string; strength: number; isHuman: boolean }[]> };
          };
        }
      ).__orbitDb;
      const all = (await db.people.toArray()).filter((p) => p.isHuman);
      return all
        .filter((p) => p.strength < 0.15 && all.filter((q) => q.displayName === p.displayName).length === 1)
        .map((p) => p.displayName);
    });
    let path: string[] = [];
    for (const name of names.slice(0, 25)) {
      await search(page, name);
      await expect(page.getByTestId('reach-path').first()).toBeVisible({ timeout: 15_000 });
      await mapSettled(page);
      path = (await mapSnapshot(page)).path;
      if (path.length >= 4) break;
      await escapeTo(page, '');
      await mapSettled(page);
    }
    expect(path.length).toBeGreaterThanOrEqual(4);
    const dots = await mapDots(page, path.slice(1));
    const ids = path.slice(1);
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const a = dots[ids[i]!]!;
        const b = dots[ids[j]!]!;
        // room for the line, its arrow and the names between any two of them
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.r + b.r + 18);
      }
    // clearing the route puts everyone back on their own slot
    await escapeTo(page, '');
    await mapSettled(page);
    const s = await mapSnapshot(page);
    const k = Number(await mapCanvas(page).getAttribute('data-scale')) * s.zoom;
    const back = await mapDots(page, ids);
    for (const id of ids) {
      const slot = (await mapSlot(page, id))!;
      const want = {
        x: s.centre[0] + Math.cos(slot.angle + s.rotation) * slot.radius * k,
        y: s.centre[1] + Math.sin(slot.angle + s.rotation) * slot.radius * k,
      };
      expect(Math.hypot(back[id]!.x - want.x, back[id]!.y - want.y)).toBeLessThan(2);
    }
  });

  test('reach with no route: the sweep fades and the target shakes', async ({ page }) => {
    await loadDemo(page);
    await openMap(page);
    // someone with no tie to the student or to anyone they know
    await page.evaluate(async () => {
      const db = (
        window as unknown as {
          __orbitDb: {
            users: { toArray(): Promise<{ id: string }[]> };
            people: { add(p: unknown): Promise<unknown> };
          };
        }
      ).__orbitDb;
      const user = (await db.users.toArray())[0]!;
      const now = new Date().toISOString();
      await db.people.add({
        id: 'e2e-alone',
        userId: user.id,
        displayName: 'Robin Okonkwo',
        firstName: 'Robin',
        lastName: 'Okonkwo',
        nameNormalized: 'robin okonkwo',
        emails: [],
        currentOrganizationRaw: 'Quietwater Labs',
        relationshipType: 'unknown',
        strength: 0,
        interactionCount: 0,
        sources: ['manual'],
        isHuman: true,
        tags: [],
        createdAt: now,
        updatedAt: now,
      });
    });
    await page.goto('map');
    await mapSettled(page);
    await pauseClock(page);
    await search(page, 'Robin Okonkwo');
    await expect(page.getByText(/no route found/i)).toBeVisible({ timeout: 15_000 });
    // the target's sideways wobble: how far the dot sits from where its slot puts it, frame by frame
    const slot = (await mapSlot(page, 'e2e-alone'))!;
    const offsets: number[] = [];
    for (let t = 0; t < 1400; t += 16) {
      await page.clock.runFor(16);
      const d = (await mapDots(page, ['e2e-alone']))['e2e-alone'];
      const s = await mapSnapshot(page);
      const k = Number(await mapCanvas(page).getAttribute('data-scale')) * s.zoom;
      if (d) offsets.push(d.x - (s.centre[0] + Math.cos(slot.angle + s.rotation) * slot.radius * k));
    }
    const label = offsets.map((x) => x.toFixed(1)).join(' ');
    expect(Math.max(...offsets.map(Math.abs)), label).toBeGreaterThan(2);
    let turns = 0;
    let side = 0;
    for (const o of offsets) {
      if (Math.abs(o) < 0.5) continue;
      if (side && Math.sign(o) !== side) turns++;
      side = Math.sign(o);
    }
    // one gentle shake: a few swings either way, and still again afterwards
    expect(turns, label).toBeGreaterThanOrEqual(3);
    expect(Math.abs(offsets.at(-1)!), label).toBeLessThan(0.5);
    await stepUntilSettled(page);
    const snap = await mapSnapshot(page);
    expect(snap.focus).toBe('reach:e2e-alone:none');
    expect(snap.phaseLog).toContain('reach-none');
    expect(snap.path).toEqual([]);
    // the radar swept for a moment before the answer, even though the answer came at once
    expect(snap.phaseLog.indexOf('reach-search')).toBeGreaterThanOrEqual(0);
  });

  test('someone new is born at their introducer and lands; a stage change crossfades', async ({ page }) => {
    await loadDemo(page);
    await openMap(page);
    const { 'Keiko Yamamoto': keiko, 'Maya Chen': maya } = await idsByName(page, [
      'Keiko Yamamoto',
      'Maya Chen',
    ]);
    await pauseClock(page);
    await page.evaluate(async (by) => {
      const db = (
        window as unknown as {
          __orbitDb: Record<
            string,
            { add(x: unknown): Promise<unknown>; toArray(): Promise<{ id: string }[]> }
          >;
        }
      ).__orbitDb;
      const user = (await db.users!.toArray())[0]!;
      const now = new Date().toISOString();
      // Keiko introduced the student to Jamie: the chat records her as referrer
      await db.chats!.add({
        id: 'c-e2e-new',
        userId: user.id,
        personId: 'e2e-new',
        stage: 'identified',
        stageEnteredAt: now,
        source: 'reach',
        goalTags: [],
        bumpCount: 0,
        priority: 2,
        referrerPersonId: by,
        referrerName: 'Keiko',
        createdAt: now,
        updatedAt: now,
      });
      await db.people!.add({
        id: 'e2e-new',
        userId: user.id,
        displayName: 'Jamie Lindgren',
        firstName: 'Jamie',
        lastName: 'Lindgren',
        nameNormalized: 'jamie lindgren',
        emails: [],
        currentOrganizationId: 'org_vercel',
        currentOrganizationRaw: 'Vercel',
        relationshipType: 'unknown',
        strength: 0.1,
        interactionCount: 0,
        sources: ['manual'],
        isHuman: true,
        tags: [],
        createdAt: now,
        updatedAt: now,
      });
    }, keiko);
    // the first frame that shows Jamie shows them on top of Keiko
    let born: Record<string, { x: number; y: number; alpha: number }> = {};
    for (let i = 0; i < 60; i++) {
      await page.clock.runFor(16);
      born = await mapDots(page, ['e2e-new', keiko]);
      if (born['e2e-new'] && born['e2e-new'].alpha > 0) break;
    }
    expect(born['e2e-new']).toBeTruthy();
    expect(Math.hypot(born['e2e-new']!.x - born[keiko]!.x, born['e2e-new']!.y - born[keiko]!.y)).toBeLessThan(
      12,
    );
    expect((await mapSnapshot(page)).phaseLog).toContain('newcomer-intro');
    // the line under the filters says it in words, for anyone who blinked
    await expect(page.getByTestId('map-legend-line')).toHaveText(
      'Jamie Lindgren joined your orbit, introduced by Keiko Yamamoto.',
    );
    // it lands and is named under its dot while in the spotlight; the name goes when the spotlight ends
    await stepUntil(page, async () => (await mapSnapshot(page)).tags.some((t) => t.startsWith('Jamie')));
    // it travels to its own slot and lands
    await stepUntilSettled(page);
    expect((await mapSnapshot(page)).tags.some((t) => t.startsWith('Jamie'))).toBe(false);
    const landed = await mapDots(page, ['e2e-new', keiko]);
    expect(landed['e2e-new']!.alpha).toBeGreaterThan(0.95);
    expect(
      Math.hypot(landed['e2e-new']!.x - landed[keiko]!.x, landed['e2e-new']!.y - landed[keiko]!.y),
    ).toBeGreaterThan(20);
    // exactly on its own slot in the layout
    const slot = (await mapSlot(page, 'e2e-new'))!;
    const s = await mapSnapshot(page);
    const k = Number(await mapCanvas(page).getAttribute('data-scale')) * s.zoom;
    const want = {
      x: s.centre[0] + Math.cos(slot.angle + s.rotation) * slot.radius * k,
      y: s.centre[1] + Math.sin(slot.angle + s.rotation) * slot.radius * k,
    };
    expect(Math.hypot(landed['e2e-new']!.x - want.x, landed['e2e-new']!.y - want.y)).toBeLessThan(2);

    // a chat gets booked: the stage ring crossfades, with one soft burst
    const setStage = (stage: string) =>
      page.evaluate(
        async ([pid, stage]) => {
          const db = (
            window as unknown as {
              __orbitDb: {
                chats: {
                  where(k: string): { equals(v: string): { first(): Promise<{ id: string }> } };
                  update(id: string, x: unknown): Promise<unknown>;
                };
              };
            }
          ).__orbitDb;
          const chat = await db.chats.where('personId').equals(pid!).first();
          await db.chats.update(chat.id, { stage, updatedAt: new Date().toISOString() });
        },
        [maya, stage],
      );
    // first a stage of another colour (warming up, amber), so the crossfade to green shows
    await setStage('warming');
    await stepUntil(page, async () => (await mapStageColor(page, maya)) === 'rgb(183,121,31)');
    await stepUntilSettled(page, 3000);
    const before = await mapStageColor(page, maya);
    const rest = (await mapDots(page, [maya]))[maya]!.r;
    expect((await mapSnapshot(page)).phase).toBe('idle');
    await setStage('scheduled');
    // the warming change logged a 'stage' too, so wait for a new one after the idle
    await stepUntil(page, async () => (await mapSnapshot(page)).phaseLog.at(-1) === 'stage');
    await expect(mapCanvas(page)).toHaveAttribute('data-animating', 'true');
    // half way: the ring is between the two colours, and the dot has lifted for the burst
    await page.clock.runFor(200);
    const mid = await mapStageColor(page, maya);
    expect(mid).not.toBe(before);
    expect(mid).not.toBe('rgb(31,138,76)');
    expect((await mapDots(page, [maya]))[maya]!.r).toBeGreaterThan(rest * 1.1);
    await expect(page.getByTestId('map-legend-line')).toHaveText('Your chat with Maya Chen is booked.');
    // and the map names her where it happens
    expect((await mapSnapshot(page)).tags.some((t) => t.startsWith('Maya'))).toBe(true);
    await stepUntilSettled(page, 3000);
    // and it lands on the scheduled colour
    expect(await mapStageColor(page, maya)).toBe('rgb(31,138,76)');
  });

  test('the Introductions view grows outward generation by generation; a chain lights up; search turns to it', async ({
    page,
  }) => {
    await loadDemo(page);
    await openMap(page);
    const ids = await idsByName(page, ['Elena Cohen', 'Keiko Yamamoto', 'Zara Fischer']);
    await pauseClock(page);
    await page.getByTestId('map-filter-intros').click();
    // links finish at different times: the second generation before the third
    const drawn: number[] = [];
    let total = 0;
    for (let i = 0; i < 40; i++) {
      await page.clock.runFor(50);
      const s = await mapSnapshot(page);
      total = s.webLinks;
      drawn.push(s.webDrawn);
      if (s.webDrawn === s.webLinks && !s.animating) break;
    }
    expect(total).toBeGreaterThanOrEqual(5);
    expect(drawn.at(-1)).toBe(total);
    expect(drawn.some((d) => d > 0 && d < total)).toBe(true);
    for (let i = 1; i < drawn.length; i++) expect(drawn[i]!).toBeGreaterThanOrEqual(drawn[i - 1]!);
    await page.clock.resume();
    await mapSettled(page);
    // each generation sits one ring further out: Elena, then Keiko whom she introduced, then Zara whom Keiko did
    const snap = await mapSnapshot(page);
    const dots = await mapDots(page, Object.values(ids));
    const dist = (id: string) => Math.hypot(dots[id]!.x - snap.centre[0], dots[id]!.y - snap.centre[1]);
    expect(dist(ids['Elena Cohen']!)).toBeLessThan(dist(ids['Keiko Yamamoto']!));
    expect(dist(ids['Keiko Yamamoto']!)).toBeLessThan(dist(ids['Zara Fischer']!));
    // the people in it are named on the map, and the line under the filters says what the rings mean now
    for (const n of ['Elena', 'Keiko', 'Zara'])
      expect(
        snap.tags.some((t) => t.startsWith(n)),
        snap.tags.join(', '),
      ).toBe(true);
    await expect(page.getByTestId('map-legend-line')).toContainText(
      'Each ring out from You is one more introduction',
    );
    // the panel tells each chain in words
    const stories = page.getByTestId('map-intro-story');
    expect(await stories.count()).toBeGreaterThanOrEqual(3);
    await expect(
      stories.filter({ hasText: 'Elena introduced you to Keiko, who introduced you to Zara.' }),
    ).toHaveCount(1);
    // hovering a chain lights it, from Elena through Keiko to Zara
    await stories.filter({ hasText: 'Elena introduced you to Keiko' }).hover();
    await expect
      .poll(async () => new Set((await mapSnapshot(page)).webLit))
      .toEqual(new Set(Object.values(ids)));
    // hovering Zara on the map lights the same chain; the list already says it in those words, so its entry is
    // marked rather than repeated in a card under the list
    await page.mouse.move(5, 5);
    const box = (await mapCanvas(page).boundingBox())!;
    const zaraDot = (await mapDots(page, [ids['Zara Fischer']]))[ids['Zara Fischer']]!;
    await page.mouse.move(box.x + zaraDot.x, box.y + zaraDot.y);
    const said = stories.filter({ hasText: 'Elena introduced you to Keiko, who introduced you to Zara.' });
    await expect(said).toHaveAttribute('data-lit', 'true');
    await expect(page.getByTestId('map-chain-sentence')).toHaveCount(0);
    await page.mouse.move(5, 5);
    await expect(said).not.toHaveAttribute('data-lit', 'true');
    // the search box searches the web and turns the orbit to the match
    await search(page, 'Zara Fischer');
    await expect.poll(async () => (await mapSnapshot(page)).focus).toBe(`web:${ids['Zara Fischer']}`);
    await mapSettled(page);
    const s2 = await mapSnapshot(page);
    const zara = (await mapDots(page, [ids['Zara Fischer']!]))[ids['Zara Fischer']!]!;
    expect(degreesApart(angleFromCentre(zara, { x: s2.centre[0], y: s2.centre[1] }), -90)).toBeLessThan(10);
    // Esc lets go of the match, then of the view
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await mapSnapshot(page)).focus).toBe('web');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await mapSnapshot(page)).focus).toBe('');
    await mapSettled(page);
    // everyone is back in their own slot
    expect((await mapSnapshot(page)).webLinks).toBe(0);
  });

  test('a search inside Introductions replaces the hovered person, and a change of view lets go of a hover', async ({
    page,
  }) => {
    await loadDemo(page);
    await openMap(page);
    const ids = await idsByName(page, ['Keiko Yamamoto', 'Priya Hassan']);
    const keiko = ids['Keiko Yamamoto']!;
    const priya = ids['Priya Hassan']!;
    await page.getByTestId('map-filter-intros').click();
    await mapSettled(page);
    const box = (await mapCanvas(page).boundingBox())!;
    const hoverKeiko = async () => {
      const at = (await mapDots(page, [keiko]))[keiko]!;
      await page.mouse.move(box.x + at.x, box.y + at.y);
      await expect.poll(async () => (await mapSnapshot(page)).hover).toBe(keiko);
      await expect(page.getByTestId('map-tooltip')).toContainText('Keiko Yamamoto');
    };
    await hoverKeiko();
    expect((await mapSnapshot(page)).focus).toBe(`web:${keiko}`);
    // the pointer rests on Keiko while the student searches: the search answers, not the old hover
    await search(page, 'Priya');
    await expect.poll(async () => (await mapSnapshot(page)).focus).toBe(`web:${priya}`);
    await expect(page.getByTestId('map-legend-line')).toContainText(
      'Showing the introductions through Priya Hassan',
    );
    await expect(page.getByTestId('map-tooltip')).toHaveCount(0);
    expect((await mapSnapshot(page)).hover).toBeUndefined();
    // back to the whole web, then hover Keiko and press Esc without moving the mouse: her dot glides back to her
    // orbit slot, and her card and lines go with the view instead of pointing at empty space
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await mapSnapshot(page)).focus).toBe('web');
    await mapSettled(page);
    await hoverKeiko();
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await mapSnapshot(page)).focus).toBe('');
    await expect(page.getByTestId('map-tooltip')).toHaveCount(0);
    expect((await mapSnapshot(page)).hover).toBeUndefined();
  });

  test('hover lifts the dot and stops the drift; leaving lets it drift again', async ({ page }) => {
    await loadDemo(page);
    await openMap(page);
    const { 'Maya Chen': maya } = await idsByName(page, ['Maya Chen']);
    expect((await mapSnapshot(page)).spin).toBeGreaterThan(0);
    const box = (await mapCanvas(page).boundingBox())!;
    const at = (await mapDots(page, [maya]))[maya]!;
    await page.mouse.move(box.x + at.x, box.y + at.y);
    await expect(page.getByTestId('map-tooltip')).toContainText('Maya Chen');
    await expect.poll(async () => (await mapSnapshot(page)).hover).toBe(maya);
    // the orbit eases to a stop under the pointer, so the dot stays put
    await expect.poll(async () => (await mapSnapshot(page)).spin, { timeout: 3000 }).toBe(0);
    const lifted = (await mapDots(page, [maya]))[maya]!;
    expect(lifted.r).toBeGreaterThan(at.r * 1.15);
    await page.mouse.move(box.x + 3, box.y + 3);
    await expect(page.getByTestId('map-tooltip')).toHaveCount(0);
    await expect.poll(async () => (await mapSnapshot(page)).spin, { timeout: 3000 }).toBeGreaterThan(0);
  });

  test('filters sweep round the orbit from twelve o’clock and the legend line says what is shown', async ({
    page,
  }) => {
    await loadDemo(page);
    await openMap(page);
    const alumni: string[] = await page.evaluate(async () => {
      const db = (
        window as unknown as { __orbitDb: { people: { toArray(): Promise<Record<string, unknown>[]> } } }
      ).__orbitDb;
      return (await db.people.toArray())
        .filter((p) => p.isAlumni && p.isHuman && !p.hiddenAt)
        .map((p) => p.id as string);
    });
    const all = Object.keys(await mapDots(page));
    const others = all.filter((id) => !alumni.includes(id));
    await pauseClock(page);
    await page.getByTestId('map-filter-alumni').click();
    await page.clock.runFor(96);
    // the dots fading out near twelve o'clock are further along than those just before it
    const snap = await mapSnapshot(page);
    const dots = await mapDots(page, others);
    const pos = (id: string) => {
      const a = angleFromCentre(dots[id]!, { x: snap.centre[0], y: snap.centre[1] });
      return (((a + 90) % 360) + 360) % 360; // degrees clockwise from twelve o'clock
    };
    const early = others.filter((id) => pos(id) < 90).map((id) => dots[id]!.alpha);
    const late = others.filter((id) => pos(id) > 270).map((id) => dots[id]!.alpha);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(early.length).toBeGreaterThan(0);
    expect(late.length).toBeGreaterThan(0);
    expect(mean(early)).toBeLessThan(mean(late));
    await page.clock.resume();
    await mapSettled(page);
    const end = await mapSnapshot(page);
    expect(end.dimmed).toBe(others.length);
    expect(end.phaseLog).toContain('filter');
    await expect(page.getByTestId('map-legend-line')).toHaveText(
      new RegExp(`Showing ${alumni.length} alumni`),
    );
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('map-filter-all')).toHaveAttribute('aria-pressed', 'true');
    await mapSettled(page);
    expect((await mapSnapshot(page)).dimmed).toBe(0);
  });

  test('the person card never covers the person it is about', async ({ page }) => {
    await loadDemo(page);
    await openMap(page);
    const box = (await mapCanvas(page).boundingBox())!;
    const all = await mapDots(page);
    // dots from every part of the map: the left- and rightmost, the top and the bottom ones
    const ids = Object.keys(all);
    const pick = [
      ...ids.sort((a, b) => all[a]!.x - all[b]!.x).slice(0, 3),
      ...ids.sort((a, b) => all[b]!.x - all[a]!.x).slice(0, 3),
      ...ids.sort((a, b) => all[b]!.y - all[a]!.y).slice(0, 3),
      ...ids.sort((a, b) => all[a]!.y - all[b]!.y).slice(0, 3),
    ];
    let checked = 0;
    for (const id of pick) {
      const d = (await mapDots(page, [id]))[id];
      if (!d) continue;
      await page.mouse.move(box.x + d.x, box.y + d.y);
      const hovered = await expect
        .poll(async () => (await mapSnapshot(page)).hover, { timeout: 2000 })
        .toBe(id)
        .then(() => true)
        .catch(() => false);
      if (!hovered) continue;
      const card = page.getByTestId('map-tooltip');
      if (!(await card.isVisible())) continue;
      const c = (await card.boundingBox())!;
      const dot = (await mapDots(page, [id]))[id]!;
      const x = box.x + dot.x;
      const y = box.y + dot.y;
      const inside = x > c.x && x < c.x + c.width && y > c.y && y < c.y + c.height;
      expect(inside, `${id} at ${x},${y} under the card at ${JSON.stringify(c)}`).toBe(false);
      checked++;
    }
    expect(checked).toBeGreaterThan(4);
  });

  test('keyboard: Tab focuses the map, arrows move between people, Enter opens, Esc lets go', async ({
    page,
  }) => {
    await loadDemo(page);
    await openMap(page);
    for (let i = 0; i < 60; i++) {
      if (await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'orbit-canvas'))
        break;
      await page.keyboard.press('Tab');
    }
    await expect(mapCanvas(page)).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('map-announce')).toHaveText(/Press Enter to (open|see them)\.$/);
    const one = (await mapSnapshot(page)).hover;
    expect(one).toBeTruthy();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowDown');
    const two = (await mapSnapshot(page)).hover;
    expect(two).toBeTruthy();
    // the focused dot pops and its card shows, like a hover
    await expect(page.getByTestId('map-tooltip')).toBeVisible();
    // Esc lets go of the dot first, without leaving the map
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await mapSnapshot(page)).hover).toBeUndefined();
    await expect(page).toHaveURL(/\/map$/);
    await page.keyboard.press('ArrowUp');
    const three = (await mapSnapshot(page)).hover!;
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/people/${three}$`));
  });
});

test.describe('Map motion with a big network', () => {
  test.setTimeout(150_000);

  test('a "+N" dot bursts open into a fan that can be clicked, folds back on Esc, and turns round if asked again', async ({
    page,
  }) => {
    await loadDemo(page);
    await briefWritten(page);
    await injectPeople(page, 1910);
    await openMap(page);
    await search(page, 'Google');
    await expect.poll(async () => (await mapSnapshot(page)).focus).toBe('company:n:google');
    await mapSettled(page, 30_000);
    const snap = await mapSnapshot(page);
    expect(snap.fans.length).toBeGreaterThan(5);
    // fanned dots sit side by side, never on top of each other, and a click lands on the one under the pointer
    const fans = Object.values(await mapDots(page, snap.fans));
    for (let i = 0; i < fans.length; i++)
      for (let j = i + 1; j < fans.length; j++)
        expect(Math.hypot(fans[i]!.x - fans[j]!.x, fans[i]!.y - fans[j]!.y)).toBeGreaterThan(
          (fans[i]!.r + fans[j]!.r) * 0.95,
        );
    const one = snap.fans[Math.floor(snap.fans.length / 2)]!;
    const at = (await mapDots(page, [one]))[one]!;
    expect(await mapHitTest(page, at.x, at.y)).toBe(one);
    // Esc folds the fan back; Google again half way through turns the same dots round, no restart from the "+N" dot
    await pauseClock(page);
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await mapSnapshot(page)).focus).toBe('');
    const moves: number[] = [];
    await stepAndMeasure(page, snap.fans, 10, moves);
    await search(page, 'Google');
    await expect.poll(async () => (await mapSnapshot(page)).focus).toBe('company:n:google');
    await stepAndMeasure(page, snap.fans, 40, moves);
    expectSmooth(moves, 90, 'fan folding back, then out again');
    await stepUntilSettled(page);
    expect(new Set((await mapSnapshot(page)).fans)).toEqual(new Set(snap.fans));
  });
});

test.describe('Map motion with reduced motion', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('every change is an instant set or a short fade: no arrival, no travel, no drift', async ({
    page,
  }) => {
    await loadDemo(page);
    await openMap(page);
    const snap = await mapSnapshot(page);
    expect(snap.phaseLog).not.toContain('arrival');
    expect(snap.spin).toBe(0);
    await expect(mapCanvas(page)).toHaveAttribute('data-moving', 'false');
    await search(page, 'Stripe');
    await expect(page.getByText(/people there now/i)).toBeVisible();
    // settled within a short fade, already turned
    await mapSettled(page, 1500);
    const after = await mapSnapshot(page);
    const stripe = await page.evaluate(async () => {
      const db = (
        window as unknown as { __orbitDb: { people: { toArray(): Promise<Record<string, unknown>[]> } } }
      ).__orbitDb;
      return (await db.people.toArray())
        .filter((p) => p.currentOrganizationId === 'org_stripe')
        .map((p) => p.id as string);
    });
    const dots = Object.values(await mapDots(page, stripe));
    expect(degreesApart(meanAngle(dots, after.centre), -90)).toBeLessThan(25);
    expect(after.fans).toEqual([]);
    // the introductions view draws its links at once: nothing to wait for beyond the fade
    await escapeTo(page, '');
    await mapSettled(page, 1500);
    await pauseClock(page);
    await page.getByTestId('map-filter-intros').click();
    await expect.poll(async () => (await mapSnapshot(page)).focus).toBe('web');
    // people are set in their place in the tree at once, with no travel
    await page.clock.runFor(16);
    await nextRender(page);
    const ids = Object.keys(await mapDots(page)).slice(0, 40);
    const first = await mapDots(page, ids);
    await page.clock.runFor(1000);
    const later = await mapDots(page, ids);
    for (const id of ids)
      expect(Math.hypot(first[id]!.x - later[id]!.x, first[id]!.y - later[id]!.y)).toBeLessThan(1);
    await page.clock.resume();
    await mapSettled(page, 700);
    // a route search shows a still ring, no sweep, and settles as soon as the route is drawn
    await page.getByTestId('map-filter-all').click();
    await search(page, 'Maya Chen');
    await expect.poll(async () => (await mapSnapshot(page)).focus).toMatch(/:found$/);
    await mapSettled(page, 700);
  });
});

test.describe('Map motion on a touch screen', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('a search that finds no one says so in a toast that fits the phone, above the tab bar', async ({
    page,
  }) => {
    await loadDemo(page);
    await openMap(page);
    await search(page, 'Zzyzx Nobody');
    const toast = page.getByTestId('toasts').locator('> div').first();
    await expect(toast).toContainText(/no one by that name or company/i);
    const b = (await toast.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(8);
    expect(b.x + b.width).toBeLessThanOrEqual(390 - 8);
    // nothing spills out of the pill, and it clears the tab bar
    const spills = await toast.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    expect(spills).toBe(false);
    const bar = (await page.getByRole('navigation', { name: 'Main' }).last().boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(bar.y);
    // it sits over the search box, so typing again takes it down
    await page.getByTestId('reach-input').fill('Zzy');
    await expect(toast).toHaveCount(0);
  });

  test('every control on the map page is at least 44 px tall for a thumb', async ({ page }) => {
    await loadDemo(page);
    await openMap(page);
    const controls = page.locator(
      '[data-testid^="map-filter-"], [data-testid="reach-input"], [data-testid="map-panel"] button',
    );
    expect(await controls.count()).toBeGreaterThan(6);
    for (const box of await controls.evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { h: r.height, name: el.textContent ?? '' };
      }),
    ))
      expect(box.h, box.name).toBeGreaterThanOrEqual(44);
  });

  test('pending suggestions ripple together every 2.4 s, and the map sleeps in between', async ({ page }) => {
    await loadDemo(page);
    await openMap(page);
    // the orbit holds still on touch screens, so the ripples are all that moves
    await expect(mapCanvas(page)).toHaveAttribute('data-moving', 'false');
    await pauseClock(page);
    const before = (await mapSnapshot(page)).draws;
    // two ripple periods, a frame at a time: 300 frames at full rate
    for (let i = 0; i < 300; i++) await page.clock.runFor(16);
    const drawn = (await mapSnapshot(page)).draws - before;
    expect(drawn).toBeGreaterThan(20);
    expect(drawn).toBeLessThan(120);
    await expect(mapCanvas(page)).toHaveAttribute('data-animating', 'false');
    // only the people behind the few most pressing suggestions ripple, not half the inner ring
    const rippling = (await mapSnapshot(page)).pending;
    expect(rippling.length).toBeGreaterThan(0);
    expect(rippling.length).toBeLessThanOrEqual(3);
  });
});

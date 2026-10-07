import { expect, type Page } from '@playwright/test';

/**
 * Shared e2e setup. `clock` pins the browser to a Tuesday morning (the demo is laid out on business days relative to
 * "now"); the performance tests leave it off, because a fake clock also fakes requestAnimationFrame.
 */
export async function prep(page: Page, opts: { clock?: boolean } = {}) {
  if (opts.clock !== false) await page.clock.install({ time: new Date('2026-10-06T10:00:00') });
  await page.addInitScript(() => {
    // headless Chromium closes pages on mailto: popups; the app only uses window.open for hand-offs
    window.open = () => null;
  });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 300));
  });
}

export async function loadDemo(page: Page, opts: { clock?: boolean } = {}) {
  await prep(page, opts);
  await page.goto('');
  await page.getByRole('button', { name: /try it with demo data/i }).click();
  await expect(page).toHaveURL(/\/today$/, { timeout: 90_000 });
  await expect(page.getByText(/good (morning|afternoon|evening)/i)).toBeVisible();
}

/** Add `n` synthetic contacts (Zipf-distributed companies, mostly weak ties) straight into IndexedDB. */
export async function injectPeople(page: Page, n: number) {
  await page.evaluate(async (count) => {
    const open = indexedDB.open('orbit');
    const idb: IDBDatabase = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
    });
    const userId: string = await new Promise((res) => {
      const r = idb.transaction('users').objectStore('users').getAll();
      r.onsuccess = () => res((r.result as { id: string }[])[0]!.id);
    });
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const tx = idb.transaction('people', 'readwrite');
    const store = tx.objectStore('people');
    const companies = Math.max(5, Math.round(count / 3));
    for (let i = 0; i < count; i++) {
      const c = Math.floor(companies * rnd() ** 2.5);
      const u = rnd();
      const strength = u < 0.03 ? 0.6 + rnd() * 0.3 : u < 0.15 ? 0.3 + rnd() * 0.25 : rnd() * 0.25;
      store.put({
        id: `e2e-${i}`,
        userId,
        displayName: `Test Person ${i}`,
        firstName: 'Test',
        lastName: `Person${i}`,
        nameNormalized: `test person ${i}`,
        emails: [],
        currentOrganizationRaw: c === 0 ? 'Google' : `Synthetic Company ${c}`,
        relationshipType: 'unknown',
        strength,
        interactionCount: 0,
        sources: ['manual'],
        isHuman: true,
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    await new Promise((res) => {
      tx.oncomplete = res;
    });
    idb.close();
  }, n);
}

// ---------- the orbit map's test hooks ----------

export interface MapSnapshot {
  centre: [number, number];
  phase: string;
  phaseLog: string[];
  animating: boolean;
  rotation: number;
  zoom: number;
  pan: [number, number];
  focus: string;
  chip: string;
  path: string[];
  pathDrawn: number;
  emphasized: string[];
  dimmed: number;
  nodes: number;
  fans: string[];
  webLinks: number;
  webDrawn: number;
  webLit: string[];
  hover?: string;
  spin: number;
  tags: string[];
  draws: number;
}

export type Dot = { x: number; y: number; r: number; alpha: number };

export const mapCanvas = (page: Page) => page.getByTestId('orbit-canvas');

/** Waits until nothing on the map is in transition (the slow drift and ambient ripples do not count). */
export async function mapSettled(page: Page, timeout = 15_000) {
  await expect(mapCanvas(page)).toHaveAttribute('data-animating', 'false', { timeout });
}

export function mapSnapshot(page: Page): Promise<MapSnapshot> {
  return page.evaluate(() =>
    (window as unknown as { __orbitMap: { snapshot(): MapSnapshot } }).__orbitMap.snapshot(),
  );
}

/** Dot positions in CSS px inside the canvas. */
export function mapDots(page: Page, ids?: string[]): Promise<Record<string, Dot>> {
  return page.evaluate(
    (ids) =>
      (
        window as unknown as { __orbitMap: { positions(ids?: string[]): Record<string, Dot> } }
      ).__orbitMap.positions(ids),
    ids,
  );
}

/** Dot positions on the page (canvas offset included), which is what the eye sees when the canvas moves. */
export function screenDots(page: Page, ids: string[]): Promise<Record<string, Dot>> {
  return page.evaluate((ids) => {
    const r = document.querySelector('[data-testid="orbit-canvas"]')!.getBoundingClientRect();
    const p = (
      window as unknown as { __orbitMap: { positions(ids?: string[]): Record<string, Dot> } }
    ).__orbitMap.positions(ids);
    for (const k in p) {
      p[k]!.x += r.left + window.scrollX;
      p[k]!.y += r.top + window.scrollY;
    }
    return p;
  }, ids);
}

/**
 * Waits for the browser's next real rendering step, where resize observers run (the page clock fakes
 * requestAnimationFrame and timers, not this): by then the map has been told about any layout change, as before a paint.
 */
export async function nextRender(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        const ro = new ResizeObserver(() => {
          ro.disconnect();
          done();
        });
        ro.observe(document.body);
      }),
  );
}

/** Angle of a dot around the orbit's centre ("You"), in degrees: -90 is twelve o'clock. */
export function angleFromCentre(dot: Dot, centre: { x: number; y: number }): number {
  return (Math.atan2(dot.y - centre.y, dot.x - centre.x) * 180) / Math.PI;
}

/** The smallest difference between two angles in degrees. */
export function degreesApart(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

interface MapHooks {
  hitTest(x: number, y: number): string | undefined;
  slot(id: string): { angle: number; radius: number } | undefined;
  stageColor(id: string): string | undefined;
}

/** The person (or "+N" dot) a click at this point inside the canvas would open. */
export function mapHitTest(page: Page, x: number, y: number): Promise<string | undefined> {
  return page.evaluate(
    ([x, y]) => (window as unknown as { __orbitMap: MapHooks }).__orbitMap.hitTest(x!, y!),
    [x, y],
  );
}

/** A dot's own slot in the layout: angle before rotation (radians) and radius (layout units). */
export function mapSlot(page: Page, id: string): Promise<{ angle: number; radius: number } | undefined> {
  return page.evaluate((id) => (window as unknown as { __orbitMap: MapHooks }).__orbitMap.slot(id), id);
}

/** The colour a dot's stage ring shows now, as 'rgb(r,g,b)'. */
export function mapStageColor(page: Page, id: string): Promise<string | undefined> {
  return page.evaluate((id) => (window as unknown as { __orbitMap: MapHooks }).__orbitMap.stageColor(id), id);
}

/** Waits for the demo's first daily brief: it recomputes every strength, so people added before it would be reset. */
export async function briefWritten(page: Page) {
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
}

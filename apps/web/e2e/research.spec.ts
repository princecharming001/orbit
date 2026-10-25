import { expect, type Page, test } from '@playwright/test';
import { loadDemo, prepDeckTo } from './helpers';

/**
 * Deep research on a person (docs/plan/20) in the demo, where sample briefs stand in for orbit-research: research
 * starts only from the Deep research button on a person's About tab (and Go deeper on the brief), every line is cited,
 * the footer says what research reads, the month's count goes down, someone marked do-not-contact is never
 * researched, and nothing else (the chat, Write to, opening a page) ever starts research.
 */

/** Briefs this browser holds, straight from IndexedDB. */
const briefs = (page: Page) =>
  page.evaluate(async () => {
    const open = indexedDB.open('orbit');
    const idb: IDBDatabase = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
    });
    return new Promise<{ personId: string; status: string }[]>((res) => {
      const r = idb.transaction('dossiers').objectStore('dossiers').getAll();
      r.onsuccess = () => res(r.result as { personId: string; status: string }[]);
    });
  });

/** Mark a demo person do-not-contact, as the server's sync or an import would. */
const markDoNotContact = (page: Page, personId: string) =>
  page.evaluate(async (id) => {
    const open = indexedDB.open('orbit');
    const idb: IDBDatabase = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
    });
    const tx = idb.transaction('people', 'readwrite');
    const store = tx.objectStore('people');
    const p = await new Promise<Record<string, unknown>>((res) => {
      const r = store.get(id);
      r.onsuccess = () => res(r.result as Record<string, unknown>);
    });
    store.put({ ...p, doNotContact: true });
    await new Promise((res) => {
      tx.oncomplete = res;
    });
  }, personId);

test.describe('Research', () => {
  test('About → Deep research: a cited brief with the footer, the count goes down, Go deeper, and Prep shows it', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.goto('people/p5?tab=facts');
    const card = page.getByTestId('research-card');
    await expect(card).toBeVisible();
    // opening the page researched nothing
    expect(await briefs(page)).toEqual([]);
    await expect(card.getByTestId('research-allowance')).toHaveText('Research · 15 left this month');
    await expect(card).toContainText('Public professional sources only, every line cited, kept 90 days.');

    await card.getByTestId('research-start').click();
    const debrief = page.getByTestId('research-debrief');
    await expect(debrief).toBeVisible({ timeout: 15_000 });
    await expect(debrief).toContainText('Lena Novak manages an engineering team at Ramp');
    await expect(debrief.getByTestId('debrief-openers')).toContainText('new grads should ship in week one');
    // every line carries its numbered source, and the sources are listed
    await expect(debrief.getByTestId('debrief-openers')).toContainText('[3]');
    await expect(debrief.getByTestId('debrief-sources')).toContainText('3 sources');
    await expect(debrief.getByTestId('research-footer')).toHaveText(
      'Public professional sources only, every line cited, kept 90 days.',
    );
    await expect(debrief.getByTestId('research-allowance')).toHaveText('Research · 14 left this month');
    // the brief's supported claims became facts, marked as research
    await expect(page.getByText('from research').first()).toBeVisible();

    // Go deeper: the company's news and hiring, once
    await debrief.getByTestId('research-deeper').click();
    await expect(debrief.getByTestId('debrief-company')).toContainText('Ramp', { timeout: 15_000 });
    await expect(debrief.getByTestId('research-deeper')).toHaveCount(0);
    // Go deeper upgrades the same brief: not another one of the month's
    await expect(debrief.getByTestId('research-allowance')).toHaveText('Research · 14 left this month');

    // the Prep deck shows what they did lately and the openers, with their sources (an old Prep link opens it)
    await page.goto('people/p5?tab=prep');
    const lately = await prepDeckTo(page, 'lately');
    await expect(lately).toContainText('new-grad program');
    const openers = await prepDeckTo(page, 'openers');
    await expect(openers).toContainText('new grads should ship in week one');
    await expect(openers).toContainText('Public professional sources only');
    await page.getByTestId('prep-close').click();

    // Settings has the dollars; the About tab only the count
    await page.goto('settings/integrations');
    await expect(page.getByTestId('research-spend')).toContainText('1 person researched, $0.00');

    // a brief can be deleted, and the facts it wrote go with it
    await page.goto('people/p5?tab=facts');
    await page.getByTestId('research-delete').click();
    await expect(page.getByTestId('research-card')).toBeVisible();
    await expect(page.getByText('from research')).toHaveCount(0);
    expect(await briefs(page)).toEqual([]);
  });

  test('someone marked do-not-contact cannot be researched', async ({ page }) => {
    await loadDemo(page);
    await markDoNotContact(page, 'p9');
    await page.goto('people/p9?tab=facts');
    const card = page.getByTestId('research-card');
    await expect(card.getByTestId('research-blocked')).toContainText('do-not-contact');
    await expect(card.getByTestId('research-start')).toHaveCount(0);
    expect(await briefs(page)).toEqual([]);
  });

  test('nothing but the button starts research: not the chat, not Write to, not opening the page', async ({
    page,
  }) => {
    await loadDemo(page);
    // the chat says where the button is and starts nothing
    await page.getByTestId('composer-input').fill('research Daniel Okafor');
    await page.keyboard.press('Enter');
    await expect(page.getByText(/Deep research button on Daniel Okafor's About tab/).first()).toBeVisible({
      timeout: 15_000,
    });
    expect(await briefs(page)).toEqual([]);

    // opening a person's page and their About tab researches nothing
    await page.goto('people/p1');
    await expect(page.getByTestId('person-header')).toBeVisible();
    await page.goto('people/p1?tab=facts');
    await expect(page.getByTestId('research-card')).toBeVisible();
    expect(await briefs(page)).toEqual([]);

    // Write to a stranger offers only a quiet link to the About tab
    const stranger = await page.evaluate(async () => {
      const open = indexedDB.open('orbit');
      const idb: IDBDatabase = await new Promise((res, rej) => {
        open.onsuccess = () => res(open.result);
        open.onerror = () => rej(open.error);
      });
      const all = <T>(store: string) =>
        new Promise<T[]>((res) => {
          const r = idb.transaction(store).objectStore(store).getAll();
          r.onsuccess = () => res(r.result as T[]);
        });
      const chats = new Set((await all<{ personId: string }>('chats')).map((c) => c.personId));
      // being connected on LinkedIn is not talking: someone with nothing else is still a stranger
      const touched = new Set(
        (await all<{ personId: string; kind: string }>('touchpoints'))
          .filter((t) => t.kind !== 'linkedin_connected')
          .map((t) => t.personId),
      );
      const people = await all<{
        id: string;
        hiddenAt?: string;
        primaryEmail?: string;
        currentOrganizationRaw?: string;
      }>('people');
      return people.find(
        (p) =>
          !p.hiddenAt &&
          !chats.has(p.id) &&
          !touched.has(p.id) &&
          !!p.primaryEmail &&
          !!p.currentOrganizationRaw,
      )?.id;
    });
    expect(stranger).toBeTruthy();
    await page.goto(`people/${stranger}`);
    await page.getByTestId('person-write').click();
    const skip = page.getByTestId('warmup-skip');
    if (await skip.isVisible().catch(() => false)) await skip.click();
    const link = page.getByTestId('compose-research-first');
    await expect(link).toBeVisible({ timeout: 15_000 });
    expect(await briefs(page)).toEqual([]);
    await link.click();
    await expect(page).toHaveURL(/tab=facts/);
    await expect(page.getByTestId('research-card')).toBeVisible();
    expect(await briefs(page)).toEqual([]);
  });

  test('a first message to someone researched opens with the brief’s top opener, as a chip the student can swap', async ({
    page,
  }) => {
    await loadDemo(page);
    // a stranger with a finished brief (as Deep research leaves it): two openers its sources fully support
    const id = await page.evaluate(async () => {
      const open = indexedDB.open('orbit');
      const idb: IDBDatabase = await new Promise((res, rej) => {
        open.onsuccess = () => res(open.result);
        open.onerror = () => rej(open.error);
      });
      const all = <T>(store: string) =>
        new Promise<T[]>((res) => {
          const r = idb.transaction(store).objectStore(store).getAll();
          r.onsuccess = () => res(r.result as T[]);
        });
      const chats = new Set((await all<{ personId: string }>('chats')).map((c) => c.personId));
      // being connected on LinkedIn is not talking: someone with nothing else is still a stranger
      const touched = new Set(
        (await all<{ personId: string; kind: string }>('touchpoints'))
          .filter((t) => t.kind !== 'linkedin_connected')
          .map((t) => t.personId),
      );
      const users = await all<{ id: string; school: string }>('users');
      // nothing on record that a first message would lead with instead: no earlier employer, no recent move
      const affs = await all<{ personId: string; kind: string; isCurrent: boolean; startDate?: string }>(
        'affiliations',
      );
      const recent = Date.now() - 200 * 86_400_000;
      const linked = new Set(
        affs
          .filter(
            (a) =>
              a.kind === 'employment' &&
              (!a.isCurrent || (!!a.startDate && new Date(a.startDate).getTime() > recent)),
          )
          .map((a) => a.personId),
      );
      const people = await all<{
        id: string;
        hiddenAt?: string;
        primaryEmail?: string;
        currentOrganizationRaw?: string;
        isAlumni?: boolean;
        school?: string;
      }>('people');
      const p = people.find(
        (x) =>
          !x.hiddenAt &&
          !chats.has(x.id) &&
          !touched.has(x.id) &&
          !!x.primaryEmail &&
          !!x.currentOrganizationRaw &&
          !x.isAlumni &&
          !linked.has(x.id) &&
          x.school !== users[0]!.school,
      )!;
      const now = new Date().toISOString();
      const tx = idb.transaction('dossiers', 'readwrite');
      tx.objectStore('dossiers').put({
        id: `brief_${p.id}`,
        userId: users[0]!.id,
        personId: p.id,
        status: 'ready',
        costUsd: 0,
        model: 'sample',
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
        sources: [
          { id: 'S1', url: 'https://www.linkedin.com/', title: 'LinkedIn profile', demo: true },
          { id: 'S2', url: 'https://example.com/post', title: 'A post', demo: true },
        ],
        content: {
          who: 'A sample brief.',
          now: {
            role: 'Engineer',
            org: p.currentOrganizationRaw,
            since: null,
            source_ids: ['S1'],
            support: 'full',
          },
          recently: [],
          in_common: [],
          history: { first_contact: null, last_contact: null, summary: null },
          openers: [
            {
              text: 'Your post on shipping small changes every day stuck with me',
              source_ids: ['S2'],
              support: 'full',
            },
            { text: 'I liked how your team writes up every launch', source_ids: ['S2'], support: 'full' },
          ],
          careful: [],
          confidence: 'high',
        },
        research: { kind: 'quick', sample: true, checked: true },
      });
      await new Promise((res) => {
        tx.oncomplete = res;
      });
      return p.id;
    });
    await page.goto(`people/${id}`);
    await page.getByTestId('person-write').click();
    const skip = page.getByTestId('warmup-skip');
    if (await skip.isVisible().catch(() => false)) await skip.click();
    const body = page.getByLabel('Message body');
    await expect(body).toHaveValue(/Your post on shipping small changes every day stuck with me\./, {
      timeout: 15_000,
    });
    const chip = page.getByTestId('draft-research-chip');
    await expect(chip).toContainText('from research [2]');
    // a brief on them: no "Research them first" link
    await expect(page.getByTestId('compose-research-first')).toHaveCount(0);
    await chip.getByTestId('draft-research-swap').click();
    await expect(body).toHaveValue(/I liked how your team writes up every launch\./);
    await expect(body).not.toHaveValue(/shipping small changes/);
    // after the last opener, the student writes their own line
    await page.getByTestId('draft-research-swap').click();
    await expect(body).toHaveValue(/\[Why them: one line only true of/);
    await expect(page.getByTestId('draft-research-chip')).toHaveCount(0);
  });

  test('the public remove-me page', async ({ page }) => {
    await page.goto('remove-me');
    await expect(page.getByTestId('remove-me')).toContainText("Remove me from Orbit's research");
    await expect(page.getByTestId('remove-me-submit')).toBeDisabled();
    await page.getByLabel('Your name').fill('Dana Liu');
    await page.getByLabel('Your company').fill('Ramp');
    await expect(page.getByTestId('remove-me-submit')).toBeEnabled();
  });
});

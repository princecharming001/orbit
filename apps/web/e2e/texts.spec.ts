import { expect, type Page, test } from '@playwright/test';
import initSqlJs from 'sql.js';
import { loadDemo } from './helpers';

/**
 * Texts on the demo account (plan 43 §6, §8.7): on a Mac the Texts row is in Settings, a Messages file and a contacts
 * file come in through the file inputs, the people and the conversations show, a person's page shows the texts, and
 * the one switch goes off (closeness back to what it was), on again (the same scores) and removed.
 */
test.use({
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
});

const appleNs = (iso: string) => (Date.parse(iso) - Date.UTC(2001, 0, 1)) * 1e6;

/** A small Messages database: a demo person and a new friend text one to one, both from the student's contacts. */
async function chatDb(): Promise<Buffer> {
  const SQL = await initSqlJs();
  const d = new SQL.Database();
  d.run(`
    create table handle (ROWID integer primary key, id text);
    create table chat (ROWID integer primary key, chat_identifier text);
    create table chat_handle_join (chat_id integer, handle_id integer);
    create table chat_message_join (chat_id integer, message_id integer);
    create table message (ROWID integer primary key, date integer, is_from_me integer, text text, attributedBody blob,
      associated_message_type integer default 0, item_type integer default 0, handle_id integer);
    insert into handle values (1, '+15550101001'), (2, '+15550101002');
    insert into chat values (1, 'demo-person'), (2, 'new-friend');
    insert into chat_handle_join values (1, 1), (2, 2);`);
  const texts: [number, string, 0 | 1, string][] = [];
  // three weeks of texting each, both ways
  for (let w = 0; w < 6; w++) {
    const day = `2026-09-${String(8 + w * 4).padStart(2, '0')}`;
    texts.push([1, `${day}T15:00:00Z`, 1, `Coffee this week? (${w})`]);
    texts.push([1, `${day}T16:00:00Z`, 0, `Sure, Thursday works (${w})`]);
    texts.push([2, `${day}T19:00:00Z`, 0, `Study group tonight? (${w})`]);
    texts.push([2, `${day}T19:30:00Z`, 1, `In, see you at six (${w})`]);
  }
  texts.forEach(([chat, iso, me, text], i) => {
    d.run('insert into message (ROWID, date, is_from_me, text, handle_id) values (?, ?, ?, ?, ?)', [
      i + 1,
      appleNs(iso),
      me,
      text,
      chat,
    ]);
    d.run('insert into chat_message_join values (?, ?)', [chat, i + 1]);
  });
  const out = Buffer.from(d.export());
  d.close();
  return out;
}

const vcf = (name: string, email: string) => `BEGIN:VCARD
VERSION:3.0
FN:${name}
TEL;type=CELL:+1 555 010 1001
EMAIL:${email}
END:VCARD
BEGIN:VCARD
VERSION:3.0
N:Okafor;Tobi;;;
FN:Tobi Okafor
TEL;type=CELL:+1 555 010 1002
X-SOCIALPROFILE;type=instagram;x-user=tobi.ok:x-apple:tobi.ok
END:VCARD
`;

/** A person straight from the browser's database. */
async function readPeople(page: Page) {
  return page.evaluate(async () => {
    const idb: IDBDatabase = await new Promise((res, rej) => {
      const o = indexedDB.open('orbit');
      o.onsuccess = () => res(o.result);
      o.onerror = () => rej(o.error);
    });
    const rows: {
      id: string;
      displayName: string;
      primaryEmail?: string;
      strength: number;
      phones?: string[];
      hiddenAt?: string;
    }[] = await new Promise((res) => {
      const r = idb.transaction('people').objectStore('people').getAll();
      r.onsuccess = () => res(r.result);
    });
    idb.close();
    return rows;
  });
}

test('texts on the demo: import, see them, switch off and on, remove', async ({ page }) => {
  test.setTimeout(180_000);
  await loadDemo(page);
  // someone in the demo with an address and a light tie: the contacts card names them by that address
  const before = await readPeople(page);
  const known = before
    .filter((p) => p.primaryEmail && !p.hiddenAt && p.strength > 0.05 && p.strength < 0.5)
    .sort((a, b) => a.displayName.localeCompare(b.displayName))[0]!;
  expect(known).toBeTruthy();

  await page.goto('settings/integrations');
  const row = page.getByTestId('settings-texts');
  await expect(row).toBeVisible();
  await expect(page.getByTestId('settings-texts-status')).toHaveText('Not connected');
  await expect(page.getByTestId('settings-texts-privacy')).toContainText('The words never leave it');

  // the switch opens the setup: where the folder is, then the files
  await page.getByTestId('settings-texts-switch').click();
  const setup = page.getByTestId('texts-setup');
  await expect(setup).toContainText('Cmd-Shift-G');
  await expect(setup).toContainText('Full Disk Access');
  await page.getByTestId('texts-files').setInputFiles([
    { name: 'chat.db', mimeType: 'application/octet-stream', buffer: await chatDb() },
    // the shared-memory file beside it is never needed
    { name: 'chat.db-shm', mimeType: 'application/octet-stream', buffer: Buffer.alloc(32) },
  ]);
  await expect(page.getByTestId('texts-picked')).toContainText('chat.db');
  await row.screenshot({ path: 'test-results/texts-setup.png' });
  await page.getByTestId('texts-contacts').setInputFiles({
    name: 'contacts.vcf',
    mimeType: 'text/vcard',
    buffer: Buffer.from(vcf(known.displayName, known.primaryEmail!)),
  });
  await page.getByTestId('texts-import').click();
  await expect(page.getByTestId('settings-texts-status')).toContainText('On · 2 people, 2 conversations', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('settings-texts-switch')).toHaveAttribute('aria-checked', 'true');
  await row.screenshot({ path: 'test-results/texts-settings-on.png' });

  const strengthOf = async (id: string) => (await readPeople(page)).find((p) => p.id === id)?.strength;
  await expect.poll(() => strengthOf(known.id)).toBeGreaterThan(known.strength);
  const on = (await strengthOf(known.id))!;
  const tobi = (await readPeople(page)).find((p) => p.displayName === 'Tobi Okafor')!;
  expect(tobi.strength).toBeGreaterThan(0);

  // a person's page shows the texts
  await page.goto(`people/${known.id}`);
  const card = page.getByTestId('person-texts');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('person-texts-counts')).toContainText('12');
  await expect(card).toContainText('Sure, Thursday works (5)');
  await page.screenshot({ path: 'test-results/texts-person.png' });

  // off: closeness goes back to what it was, the texts are kept and hidden
  await page.goto('settings/integrations');
  await page.getByTestId('settings-texts-switch').click();
  await expect(page.getByTestId('settings-texts-status')).toHaveText(
    'Off · kept, left out of closeness and paths',
  );
  await expect.poll(() => strengthOf(known.id)).toBe(known.strength);
  await expect.poll(() => strengthOf(tobi.id)).toBe(0);
  await page.goto(`people/${known.id}`);
  await expect(page.getByTestId('person-header')).toBeVisible();
  await expect(page.getByTestId('person-texts')).toHaveCount(0);

  // on again: the same scores, no setup
  await page.goto('settings/integrations');
  await page.getByTestId('settings-texts-switch').click();
  await expect(page.getByTestId('settings-texts-status')).toContainText('On · 2 people');
  await expect.poll(() => strengthOf(known.id)).toBe(on);

  // remove: what Orbit took is deleted; the demo person stays, the friend only texts knew goes
  await page.getByTestId('settings-texts-remove').click();
  await page.getByTestId('settings-texts-confirm-remove').click();
  await expect(page.getByTestId('settings-texts-status')).toHaveText(
    'Removed · nothing from your texts is kept',
  );
  await expect.poll(async () => (await readPeople(page)).some((p) => p.id === tobi.id)).toBe(false);
  await expect.poll(() => strengthOf(known.id)).toBe(known.strength);
  await page.getByTestId('settings-texts').screenshot({ path: 'test-results/texts-settings-removed.png' });
});

test('not on a Mac, the Texts row is not shown', async ({ browser }) => {
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  });
  const page = await ctx.newPage();
  await loadDemo(page);
  await page.goto('settings/integrations');
  await expect(page.getByTestId('settings-linkedin-live')).toBeVisible();
  await expect(page.getByTestId('settings-texts')).toHaveCount(0);
  await ctx.close();
});

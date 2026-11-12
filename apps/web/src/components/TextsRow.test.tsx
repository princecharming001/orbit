/**
 * Settings, the Texts row (plan 43 §3.1, §6): shown only on a Mac when Texts are offered, with its one switch through
 * the four states: Not connected, On, Off and Removed.
 */
import type { User } from '@orbit/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import initSqlJs from 'sql.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setCurrentUserId } from '../db/repo';
import { db, wipeDatabase } from '../db/schema';
import { createLocalUser } from '../engine/account';
import { importTexts } from '../engine/imessage';
import { setExtraSourcesForTests } from '../engine/sources';
import { setSqlJsForTests } from '../integrations/imessageDb';
import { ToastProvider } from '../ui';
import { TextsRow } from './TextsRow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await act(() => new Promise((r) => setTimeout(r, 5)));
};

const appleNs = (iso: string) => (Date.parse(iso) - Date.UTC(2001, 0, 1)) * 1e6;
async function chatDb(): Promise<Uint8Array> {
  const SQL = await initSqlJs();
  const d = new SQL.Database();
  d.run(`
    create table handle (ROWID integer primary key, id text);
    create table chat (ROWID integer primary key, chat_identifier text);
    create table chat_handle_join (chat_id integer, handle_id integer);
    create table chat_message_join (chat_id integer, message_id integer);
    create table message (ROWID integer primary key, date integer, is_from_me integer, text text, attributedBody blob,
      associated_message_type integer default 0, item_type integer default 0, handle_id integer);
    insert into handle values (1, '+15551234567');
    insert into chat values (1, 'ana');
    insert into chat_handle_join values (1, 1);`);
  [
    ['2026-10-01T15:00:00Z', 1, 'Coffee Thursday?'],
    ['2026-10-01T16:00:00Z', 0, 'Yes'],
  ].forEach(([iso, me, text], i) => {
    d.run('insert into message (ROWID, date, is_from_me, text) values (?, ?, ?, ?)', [
      i + 1,
      appleNs(iso as string),
      me as number,
      text as string,
    ]);
    d.run('insert into chat_message_join values (1, ?)', [i + 1]);
  });
  return d.export();
}
const VCF = 'BEGIN:VCARD\nFN:Ana Ruiz\nTEL:(555) 123-4567\nEND:VCARD';

const realAgent = navigator.userAgent;
function pretendMac(mac: boolean) {
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    value: mac ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 Chrome/126' : realAgent,
  });
  Object.defineProperty(window.navigator, 'platform', {
    configurable: true,
    value: mac ? 'MacIntel' : 'Linux',
  });
}

let user: User;
let host: HTMLDivElement;
let unmount: (() => void) | undefined;

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <MemoryRouter>
        <ToastProvider>
          <TextsRow user={user} />
        </ToastProvider>
      </MemoryRouter>,
    ),
  );
  unmount = () => {
    act(() => root.unmount());
    host.remove();
  };
  await settle();
}
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const statusText = () => (q('settings-texts-status')?.textContent ?? '').trim();
const click = async (id: string) => {
  await act(async () => q(id)!.click());
  await settle(30);
};

beforeAll(() => setSqlJsForTests(initSqlJs()));
beforeEach(async () => {
  await wipeDatabase();
  user = await createLocalUser({ fullName: 'Sam Lee', email: 'sam@cornell.edu' });
  await setCurrentUserId(user.id);
  setExtraSourcesForTests('imessage');
  pretendMac(true);
});
afterEach(() => {
  unmount?.();
  unmount = undefined;
});
afterAll(() => {
  setExtraSourcesForTests(undefined);
  pretendMac(false);
});

describe('the Texts row', () => {
  it('is hidden when Texts are not offered, and hidden off a Mac', async () => {
    setExtraSourcesForTests('');
    await mount();
    expect(q('settings-texts')).toBeNull();
    unmount!();
    setExtraSourcesForTests('imessage');
    pretendMac(false);
    await mount();
    expect(q('settings-texts')).toBeNull();
  });

  it('goes through Not connected, On, Off and Removed with one switch', async () => {
    await mount();
    // not connected: the switch opens the setup, nothing is on yet
    expect(statusText()).toBe('Not connected');
    expect(q('settings-texts-privacy')?.textContent).toMatch(/The words never leave it/);
    expect(q('settings-texts-switch')?.getAttribute('aria-checked')).toBe('false');
    await click('settings-texts-switch');
    expect(q('texts-setup')).not.toBeNull();
    expect(q('texts-setup')?.textContent).toMatch(/Cmd-Shift-G/);
    expect(q('texts-setup')?.textContent).toMatch(/Full Disk Access/);
    expect(q('texts-setup')?.textContent).toMatch(/Desktop/);
    expect((q('texts-import') as HTMLButtonElement).disabled).toBe(true);
    // on: an import (as the setup runs it) turns it on
    await act(async () => {
      await importTexts(user, { messagesDb: await chatDb(), contactsVcf: VCF });
    });
    unmount!();
    await mount();
    expect(statusText()).toMatch(/^On · 1 person, 1 conversation · updated /);
    expect(q('settings-texts-switch')?.getAttribute('aria-checked')).toBe('true');
    expect(q('settings-texts-update')).not.toBeNull();
    const ana = (await db.people.where('userId').equals(user.id).first())!;
    expect(ana.strength).toBeGreaterThan(0);
    // off: kept and hidden from closeness
    await click('settings-texts-switch');
    expect(statusText()).toBe('Off · kept, left out of closeness and paths');
    expect(q('settings-texts-update')).toBeNull();
    expect((await db.people.get(ana.id))!.strength).toBe(0);
    expect(await db.textThreads.count()).toBe(1);
    // on again, with no setup: what was kept comes back
    await click('settings-texts-switch');
    expect(statusText()).toMatch(/^On · 1 person/);
    expect((await db.people.get(ana.id))!.strength).toBe(ana.strength);
    // removed: what Orbit took is deleted
    await click('settings-texts-remove');
    expect(document.querySelector('[data-testid="settings-texts-confirm"]')).not.toBeNull();
    await click('settings-texts-confirm-remove');
    expect(statusText()).toBe('Removed · nothing from your texts is kept');
    expect(q('settings-texts-switch')?.getAttribute('aria-checked')).toBe('false');
    expect(await db.textThreads.count()).toBe(0);
    expect(await db.touchpoints.filter((t) => t.refTable === 'texts').count()).toBe(0);
  });
});

import type { User } from '@orbit/core';
import { readiness } from '@orbit/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { wipeDatabase } from '../../db/schema';
import { createLocalUser } from '../../engine/account';
import { loadContact } from '../../engine/notify';
import { readinessLine } from '../agent/snapshot';
import { execute } from '../registry';
import { makeCtx } from './helpers';

let user: User;
beforeEach(async () => {
  await wipeDatabase();
  user = await createLocalUser({ fullName: 'Ana Ruiz', firstName: 'Ana', timezone: 'Europe/London' });
});

describe('save_phone (plan 40)', () => {
  it('reads a number without a country code in the student own country, and keeps it as E.164', async () => {
    const env = await execute('save_phone', { phone: '07911 123456' }, makeCtx(user));
    expect(env.summary).toBe('Saved +447911123456. Orbit will text it when your network is in.');
    expect(env.href).toBe('/settings/profile#phone');
    expect(await loadContact(user)).toMatchObject({ phone: '+447911123456', country: 'GB', smsOn: true });
  });
  it('a number with its country code wins over the guess, and a broken one is refused in plain words', async () => {
    await execute('save_phone', { phone: '+1 (415) 555-0123' }, makeCtx(user));
    expect((await loadContact(user)).phone).toBe('+14155550123');
    const bad = await execute('save_phone', { phone: '555 01' }, makeCtx(user));
    expect(bad.summary).toMatch(/^That number doesn't look complete/);
    expect((await loadContact(user)).phone).toBe('+14155550123');
  });
});

describe('the chat knows where setup stands (plan 40)', () => {
  it('a line while it runs, with how the student will hear; none once ready', () => {
    const r = readiness({
      linkedin: { status: 'active', stage: 'chats' },
      google: { status: 'active', phase: 'recent' },
      pending: 3,
      counts: { people: 812 },
    });
    const line = readinessLine({
      readiness: r,
      notify: {
        readiness: r,
        contact: { email: 'a@x.edu', phone: null, country: null, emailOn: true, smsOn: false },
        notifiedAt: null,
        emailAvailable: true,
        smsAvailable: true,
      },
    })!;
    expect(line).toMatch(/^Setup still running \(\d+%, syncing\): LinkedIn connections done \(812 people\);/);
    expect(line).toContain('Told when done: by email. Phone on file: no.');
    expect(
      readinessLine({
        readiness: readiness({ google: { status: 'active', phase: 'complete' }, pending: 0 }),
      }),
    ).toBeUndefined();
    expect(readinessLine(undefined)).toBeUndefined();
  });
});

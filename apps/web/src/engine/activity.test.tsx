import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { User } from '@orbit/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityLine } from '../components/ActivityLine';
import { db, wipeDatabase } from '../db/schema';
import { createLocalUser } from './account';
import {
  activityCounts,
  activityLine,
  activityProblems,
  countActivity,
  endActivity,
  itemText,
  liveActivities,
  progressActivity,
  resetActivityForTests,
  STALE_MS,
  startActivity,
} from './activity';
import { LINKEDIN_SIGNED_OUT } from './linkedinLive';

const NOW = Date.parse('2026-10-20T15:00:00.000Z');

describe('the activity store', () => {
  beforeEach(() => resetActivityForTests());

  it('registers, moves and ends an item', () => {
    startActivity('enrich', 'Reading LinkedIn profiles', { total: 40, now: NOW });
    progressActivity('enrich', 12, { now: NOW + 1000 });
    const [a] = liveActivities(NOW + 2000);
    expect(itemText(a!)).toBe('Reading LinkedIn profiles · 12 of 40');
    endActivity('enrich');
    expect(liveActivities(NOW + 3000)).toEqual([]);
  });

  it('shows one line: the newest item', () => {
    startActivity('replies', 'Checking for replies', { now: NOW });
    startActivity('photos', 'Fetching profile photos', { now: NOW + 500 });
    const line = activityLine(liveActivities(NOW + 600), [], undefined, NOW + 600);
    expect(line).toEqual({ state: 'running', text: 'Fetching profile photos' });
  });

  it('drops an item with no progress for ten minutes, and logs it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    startActivity('stuck', 'Reading your LinkedIn', { now: NOW });
    startActivity('fresh', 'Checking for replies', { now: NOW + STALE_MS });
    const left = liveActivities(NOW + STALE_MS + 1000);
    expect(left.map((a) => a.id)).toEqual(['fresh']);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('counts with no total, and is idle with when the replies were checked', () => {
    expect(itemText({ text: 'Reading your LinkedIn connections', done: 1240 })).toBe(
      'Reading your LinkedIn connections · 1,240',
    );
    expect(activityLine([], [], new Date(NOW - 2 * 60_000).toISOString(), NOW)).toEqual({
      state: 'idle',
      text: 'Up to date · checked replies 2 min ago',
    });
    expect(activityLine([], [], undefined, NOW).text).toBe('Up to date');
  });

  it('quiet background work stays off the line', () => {
    startActivity('photos', 'Fetching profile photos', { now: NOW, quiet: true });
    expect(activityLine(liveActivities(NOW), [], undefined, NOW)).toEqual({
      state: 'idle',
      text: 'Up to date',
    });
    expect(liveActivities(NOW).map((a) => a.id)).toEqual(['photos']);
  });

  it('a problem shows with its fix, ahead of work in progress', () => {
    startActivity('replies', 'Checking for replies', { now: NOW });
    const p = [
      { id: 'x', text: 'LinkedIn signed you out', fix: 'Sign in again', link: '/settings/integrations' },
    ];
    expect(activityLine(liveActivities(NOW), p, undefined, NOW)).toEqual({
      state: 'problem',
      text: 'LinkedIn signed you out',
      fix: { text: 'Sign in again', link: '/settings/integrations' },
    });
  });

  it('never uses a dash in what it says', () => {
    startActivity('a', 'Fetching company logos', { total: 6, now: NOW });
    for (const t of [
      itemText(liveActivities(NOW)[0]!),
      activityLine([], [], new Date(NOW - 3 * 3_600_000).toISOString(), NOW).text,
    ])
      expect(t).not.toMatch(/[–—]/);
  });
});

describe("today's counts and the problems", () => {
  let user: User;
  beforeEach(async () => {
    await wipeDatabase();
    user = await createLocalUser({ fullName: 'Alex Rivera', email: 'alex@umich.edu', school: 'Michigan' });
  });

  it('reads the counts from the rows the readers keep', async () => {
    const now = new Date(NOW);
    const day = now.toISOString().slice(0, 10);
    await db.kv.put({
      key: `enrich:budget:${user.id}`,
      value: { day, used: { profile: 9, view: 3, search: 2, company: 4 } },
    });
    await db.kv.put({ key: `photos:day:${user.id}`, value: { day, used: 18 } });
    await db.kv.put({ key: `logos:day:${user.id}`, value: { day, used: 2 } });
    await countActivity(user.id, 'repliesChecked', 1, now);
    await countActivity(user.id, 'repliesChecked', 1, now);
    await countActivity(user.id, 'notes', 1, now);
    const c = await activityCounts(user, now);
    expect(c).toMatchObject({ profiles: 12, searches: 2, photos: 18, logos: 6, repliesChecked: 2, notes: 1 });
    expect(c.profilesOf).toBe(45);
    // yesterday's counters do not carry over
    const tomorrow = new Date(NOW + 86_400_000);
    expect(await activityCounts(user, tomorrow)).toMatchObject({ profiles: 0, photos: 0, repliesChecked: 0 });
  });

  it('LinkedIn signed out is a problem with Sign in again', async () => {
    await db.integrations.put({
      id: 'li',
      userId: user.id,
      provider: 'linkedin_live',
      externalAccountId: 'acc',
      status: 'active',
      scopes: [],
      syncState: {},
      lastError: LINKEDIN_SIGNED_OUT,
      connectedAt: new Date(NOW).toISOString(),
    });
    const ps = await activityProblems(user, new Date(NOW));
    expect(ps[0]).toMatchObject({ text: 'LinkedIn signed you out', fix: 'Sign in again' });
  });
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('the dot', () => {
  it('breathes only while something runs, and the breath stops for reduced motion', async () => {
    const css = readFileSync(join(__dirname, '../styles/index.css'), 'utf8');
    const reduced = css.split('@media (prefers-reduced-motion: reduce)').slice(1);
    expect(reduced.some((block) => /\.breathe\s*\{\s*animation:\s*none/.test(block))).toBe(true);
    resetActivityForTests();
    startActivity('replies', 'Checking for replies');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <ActivityLine />
        </MemoryRouter>,
      );
    });
    const dot = host.querySelector('[data-testid="activity-dot"]')!;
    expect(dot.className).toContain('breathe');
    expect(host.querySelector('[data-testid="activity-text"]')?.textContent).toBe('Checking for replies');
    await act(async () => endActivity('replies'));
    await act(() => new Promise((r) => setTimeout(r, 2100)));
    expect(host.querySelector('[data-testid="activity-dot"]')!.className).not.toContain('breathe');
    await act(async () => root.unmount());
  });
});

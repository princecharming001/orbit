import { describe, expect, it } from 'vitest';
import { progressLabel, readiness } from '../sync/readiness';

const keys = (r: ReturnType<typeof readiness>) => r.steps.map((s) => `${s.key}:${s.state}`);

describe('readiness: is Orbit ready yet', () => {
  it('nothing connected is nothing to wait for', () => {
    const r = readiness({ pending: 0 });
    expect(r.state).toBe('nothing');
    expect(r.steps).toEqual([]);
  });

  it('walks LinkedIn and email through every stage, in order', () => {
    const at = (stage: 'relations' | 'chats' | 'done', phase: 'recent' | 'deep' | 'complete', pending = 0) =>
      readiness({
        linkedin: { status: 'active', stage, syncedAt: stage === 'done' ? '2026-11-11T00:00:00Z' : null },
        google: { status: 'active', phase, done: 400, total: 1000 },
        pending,
        counts: { people: 812, messages: 3100, ties: 640 },
      });
    const start = at('relations', 'recent', 5);
    expect(start.state).toBe('syncing');
    expect(keys(start)).toEqual([
      'linkedin_people:working',
      'linkedin_messages:waiting',
      'email_recent:working',
      'email_older:waiting',
      'network:working',
    ]);
    expect(start.steps[0]!.detail).toBe('812 people so far');
    expect(start.headline).toBe('Reading your LinkedIn');

    // the people and the recent mail are in: usable, still finishing
    const mid = at('chats', 'deep', 2);
    expect(mid.state).toBe('usable');
    expect(mid.steps.find((s) => s.key === 'email_older')).toMatchObject({
      state: 'working',
      detail: '400 of 1,000',
      share: 0.4,
    });
    expect(mid.headline).toBe('Ready to use, still finishing');
    expect(mid.progress).toBeGreaterThan(start.progress);

    // every source done, but the network is still being mapped: not ready yet
    expect(at('done', 'complete', 3).state).toBe('usable');
    const done = at('done', 'complete', 0);
    expect(done.state).toBe('ready');
    expect(done.progress).toBe(1);
    expect(done.headline).toBe('Orbit is ready');
    expect(done.steps.at(-1)).toMatchObject({ key: 'network', state: 'done', detail: '640 ties' });
  });

  it('only what was connected has steps', () => {
    const emailOnly = readiness({ google: { status: 'active', phase: 'complete' }, pending: 0 });
    expect(keys(emailOnly)).toEqual(['email_recent:done', 'email_older:done', 'network:done']);
    expect(emailOnly.state).toBe('ready');
    const linkedinOnly = readiness({ linkedin: { status: 'active', stage: 'chats' }, pending: 1 });
    expect(keys(linkedinOnly)[0]).toBe('linkedin_people:done');
    expect(linkedinOnly.state).toBe('usable');
    // a link taken away or parked is not waited on
    expect(readiness({ linkedin: { status: 'revoked' }, pending: 0 }).state).toBe('nothing');
  });

  it('a source that needs the student says so, and the rest still counts', () => {
    const r = readiness({
      google: { status: 'needs_reauth', phase: 'recent' },
      linkedin: { status: 'active', stage: 'done', syncedAt: 'x' },
      pending: 0,
    });
    expect(r.state).toBe('problem');
    expect(r.headline).toBe('Google needs you to sign in again');
    expect(r.steps.find((s) => s.key === 'linkedin_people')!.state).toBe('done');
  });

  it('a total Gmail underestimated never reads "500 of 251", and the percentage stays between 1 and 99 until ready', () => {
    const r = readiness({ google: { status: 'active', phase: 'deep', done: 500, total: 251 }, pending: 0 });
    expect(r.steps.find((s) => s.key === 'email_older')!.detail).toBe('500 so far');
    expect(progressLabel(r)).toMatch(/^\d{1,2}%$/);
    expect(progressLabel(readiness({ google: { status: 'active', phase: 'recent' }, pending: 9 }))).not.toBe(
      '0%',
    );
  });

  it('a Texts step shows when texts are on and never holds up "ready" (plan 43)', () => {
    const done = { status: 'active', phase: 'complete' } as const;
    const base = readiness({ google: done, pending: 0 });
    const waiting = readiness({ google: done, pending: 0, texts: { state: 'on' } });
    expect(base.state).toBe('ready');
    expect(waiting.state).toBe('ready');
    expect(waiting.progress).toBe(1);
    expect(waiting.headline).toBe(base.headline);
    expect(keys(waiting)).toEqual([...keys(base), 'texts:waiting']);
    expect(waiting.steps.at(-1)).toMatchObject({ optional: true, label: 'Texts' });
    const imported = readiness({
      google: { status: 'active', phase: 'recent' },
      pending: 3,
      texts: { state: 'on', people: 12, importedAt: '2026-11-10T00:00:00Z' },
    });
    const without = readiness({ google: { status: 'active', phase: 'recent' }, pending: 3 });
    expect(imported.state).toBe(without.state);
    expect(imported.progress).toBe(without.progress);
    expect(imported.steps.at(-1)).toMatchObject({ key: 'texts', state: 'done', detail: '12 people' });
    // off, or never set up: no step at all
    expect(keys(readiness({ google: done, pending: 0, texts: { state: 'off' } }))).toEqual(keys(base));
    // texts alone are nothing to wait for
    expect(readiness({ pending: 0, texts: { state: 'on' } }).state).toBe('nothing');
  });

  it('never an em dash or an exclamation mark in what it says', () => {
    const all = [
      readiness({ pending: 0 }),
      readiness({
        linkedin: { status: 'error' },
        google: { status: 'active', phase: 'deep', done: 3, total: 9 },
        pending: 4,
      }),
      readiness({ google: { status: 'active', phase: 'complete' }, pending: 0, counts: { ties: 5 } }),
    ];
    for (const r of all) expect(JSON.stringify(r)).not.toMatch(/[—–!]/);
  });
});

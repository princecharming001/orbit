import type { User } from '@orbit/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../db/schema';
import { loadDemo } from './demo';
import { connectLinkedInLive } from './linkedinLive';
import { addStyleSample, applyStylePreset, learnStyle, sampleCounts, updateStyle } from './style';

let user: User;

beforeAll(async () => {
  user = await loadDemo({ reset: true });
}, 90_000);

describe('the student voice', () => {
  it('learns from sent email and, once LinkedIn is connected, from LinkedIn messages too', async () => {
    const before = await learnStyle(user);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.sources.email).toBeGreaterThan(0);
    expect(before.sources.linkedin ?? 0).toBe(0);
    await connectLinkedInLive(user);
    const after = await learnStyle(user);
    expect(after.ok && after.sources.linkedin).toBeGreaterThan(0);
    expect((await sampleCounts(user)).linkedinAvailable).toBe(true);
    // connecting runs the sample student's whole LinkedIn sync (83 connections): seconds of work on a busy machine
  }, 20_000);

  it('keeps what the student set by hand when it learns again', async () => {
    await updateStyle(user, {
      greetingPatterns: ['Hello {first},'],
      avoid: ['pick your brain'],
      notes: 'never mention GPA',
      avgMessageWords: 60,
    });
    const r = await learnStyle(user);
    expect(r.ok).toBe(true);
    const card = (await db.styles.get(user.id))!.card;
    expect(card.custom).toBe(true);
    expect(card.greetingPatterns[0]).toBe('Hello {first},');
    expect(card.avoid).toEqual(['pick your brain']);
    expect(card.notes).toBe('never mention GPA');
    expect(card.avgMessageWords).toBe(60);
  });

  it('pasted examples count, and a preset starts over but keeps the never-say list', async () => {
    const r = await addStyleSample(user, 'Hey Sam, thanks so much for the intro, really appreciate it!');
    expect(r.ok).toBe(true);
    expect((await sampleCounts(user)).pasted).toBe(1);
    expect((await addStyleSample(user, 'hi')).ok).toBe(false);
    const card = await applyStylePreset(user, 'formal');
    expect(card.greetingPatterns[0]).toBe('Dear {first},');
    expect(card.avoid).toEqual(['pick your brain']);
    expect((await db.settings.get(user.id))?.tonePreset).toBe('formal');
  });
});

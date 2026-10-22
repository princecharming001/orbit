import { defaultStyleCard, type StyleCard } from '@orbit/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/schema';
import { applyCoachFeedback, sentForCoach } from './coach';
import { changesFromLlm, interpretFeedback } from './coachTuning';
import { currentStyleCard, styleTuningLog, tuneStyle, undoStyleTuning } from './style';

const card = (over: Partial<StyleCard> = {}): StyleCard => ({
  ...defaultStyleCard('warm', 'Alex'),
  avgMessageWords: 60,
  ...over,
});
const read = (text: string, c = card()) => interpretFeedback(text, c);

describe('reading feedback by rule', () => {
  it('shorter and longer change the length', () => {
    expect(read('Shorter').changes).toEqual([{ kind: 'length', words: 40 }]);
    expect(read('way too long').changes).toEqual([{ kind: 'length', words: 30 }]);
    expect(read('a bit longer please').changes).toEqual([{ kind: 'length', words: 80 }]);
    expect(read('keep it to 50 words').changes).toEqual([{ kind: 'length', words: 50 }]);
  });
  it('casual and formal change the tone and contractions', () => {
    expect(read('More casual').changes).toEqual([{ kind: 'formality', value: 0.15, contractions: true }]);
    expect(read('less formal').changes[0]).toMatchObject({ kind: 'formality', contractions: true });
    const formal = read('More formal', card({ formality: 0.5 })).changes[0];
    expect(formal).toEqual({ kind: 'formality', value: 0.75, contractions: false });
    expect(read('no contractions').changes).toEqual([{ kind: 'contractions', on: false }]);
  });
  it('exclamation marks and emoji', () => {
    expect(read('No exclamation marks').changes).toEqual([{ kind: 'exclamations', on: false }]);
    expect(read('use exclamation points').changes).toEqual([{ kind: 'exclamations', on: true }]);
    expect(read('stop using emoji').changes).toEqual([{ kind: 'emoji', on: false }]);
  });
  it('greetings and sign-offs', () => {
    expect(read('Open with Hey').changes).toEqual([{ kind: 'greeting', pattern: 'Hey {first},' }]);
    expect(read('use hello instead of hi').changes).toEqual([
      { kind: 'greeting', pattern: 'Hello {first},' },
    ]);
    expect(read('Different greeting').changes).toEqual([{ kind: 'greeting', pattern: 'Hey {first},' }]);
    expect(read('sign off with cheers').changes).toEqual([{ kind: 'signoff', word: 'Cheers' }]);
    expect(read('Different sign-off').changes).toEqual([{ kind: 'signoff', word: 'Thanks' }]);
    expect(read("don't open with hey", card({ greetingPatterns: ['Hey {first},'] })).changes).toEqual([
      { kind: 'greeting', pattern: 'Hi {first},' },
    ]);
  });
  it('never say X goes to the avoid list, keeping the student’s words', () => {
    expect(read('Never say "I hope this email finds you well"').changes).toEqual([
      { kind: 'avoid', phrase: 'I hope this email finds you well' },
    ]);
    expect(read("don't use Circle Back").changes).toEqual([{ kind: 'avoid', phrase: 'Circle Back' }]);
    expect(read('no "synergy"').changes).toEqual([{ kind: 'avoid', phrase: 'synergy' }]);
  });
  it('structure becomes a note for drafts', () => {
    expect(read('Get to the ask faster').changes).toEqual([
      { kind: 'note', text: 'Get to the ask within the first two sentences.' },
    ]);
  });
  it('several asks in one go, with the rest left over', () => {
    const r = read(
      'shorter, more casual and never say "pick your brain". Mention I am first-gen when it fits',
    );
    expect(r.changes.map((c) => c.kind)).toEqual(['length', 'formality', 'avoid']);
    expect(r.unmatched).toEqual(['Mention I am first-gen when it fits']);
  });
  it("Claude's reading becomes the same changes", () => {
    expect(
      changesFromLlm({
        avgMessageWords: 45,
        formality: null,
        contractions: null,
        exclamations: false,
        emoji: null,
        greeting: 'Hey',
        signoff: 'cheers,',
        avoid: ['as a student'],
        note: 'mention the club I run',
      }),
    ).toEqual([
      { kind: 'length', words: 45 },
      { kind: 'exclamations', on: false },
      { kind: 'greeting', pattern: 'Hey {first},' },
      { kind: 'signoff', word: 'Cheers' },
      { kind: 'avoid', phrase: 'as a student' },
      { kind: 'note', text: 'Mention the club I run.' },
    ]);
  });
});

const user = { id: 'coach-user', firstName: 'Alex' };

describe('the tuning log', () => {
  beforeEach(async () => {
    await db.styles.delete(user.id);
    await db.kv.delete(`styleTuning:${user.id}`);
    await db.styles.put({ userId: user.id, card: card(), updatedAt: new Date().toISOString() });
  });
  it('logs each change with what it was, survives a reload, and undoes one entry on its own', async () => {
    const r = await applyCoachFeedback(user, 'shorter, never say "circle back"', 'cold_email');
    expect(r.entries.map((e) => e.summary)).toEqual(['about 40 words, was 60', 'never say "circle back"']);
    await tuneStyle(user, [{ kind: 'avoid', phrase: 'synergy' }], { by: 'coach', said: 'Fix this' });
    const log = await styleTuningLog(user.id);
    expect(log.map((e) => e.summary)).toEqual([
      'never say "synergy"',
      'never say "circle back"',
      'about 40 words, was 60',
    ]);
    expect(log[2]).toMatchObject({ by: 'you', said: 'shorter, never say "circle back"', type: 'cold_email' });
    // undo the older phrase: the newer one stays
    await undoStyleTuning(user, log[1]!.id);
    expect((await currentStyleCard(user)).avoid).toEqual(['synergy']);
    await undoStyleTuning(user, log[2]!.id);
    expect((await currentStyleCard(user)).avgMessageWords).toBe(60);
    expect((await styleTuningLog(user.id)).filter((e) => e.undoneAt)).toHaveLength(2);
    expect(await undoStyleTuning(user, log[2]!.id)).toBe(false);
  });
  it('a change the card already has is not logged; words no rule understands go to the notes', async () => {
    const r = await applyCoachFeedback(user, 'about 60 words');
    expect(r.entries).toEqual([]);
    const n = await applyCoachFeedback(user, 'mention that I run the product club');
    expect(n.entries[0]!.summary).toBe('note for drafts: "Mention that I run the product club."');
    expect((await currentStyleCard(user)).notes).toMatch(/Mention that I run the product club\.$/);
    expect((await currentStyleCard(user)).custom).toBe(true);
  });
});

describe('sent messages, as the coach reads them', () => {
  it('sorts them by kind and works out replies, follow-ups and gaps', async () => {
    const uid = 'coach-sent';
    const day = (d: number) => new Date(Date.UTC(2026, 9, d, 14)).toISOString();
    const base = {
      userId: uid,
      status: 'sent' as const,
      generatedBy: 'template' as const,
      createdAt: day(1),
    };
    await db.outbound.bulkPut([
      {
        ...base,
        id: 'o1',
        personId: 'p1',
        chatId: 'c1',
        channel: 'gmail',
        kind: 'outreach',
        bodyDraft: 'Hi',
        bodyFinal: 'Hi Sarah,\n\nI saw your post. Would you have 15 minutes?\n\nBest,\nAlex',
        subject: 'Your post',
        sentAt: day(1),
      },
      {
        ...base,
        id: 'o2',
        personId: 'p1',
        chatId: 'c1',
        channel: 'gmail',
        kind: 'bump',
        bodyDraft: 'Hi Sarah,\n\nIn case it got buried.\n\nBest,\nAlex',
        sentAt: day(3),
      },
      {
        ...base,
        id: 'o3',
        personId: 'p2',
        chatId: 'c2',
        channel: 'linkedin',
        kind: 'outreach',
        bodyDraft: 'Hi Sam, saw your talk. 15 minutes? Alex',
        sentAt: day(2),
      },
      {
        ...base,
        id: 'o4',
        personId: 'p3',
        channel: 'gmail',
        kind: 'thank_you',
        bodyDraft: 'Thanks!',
        sentAt: day(2),
      },
    ]);
    await db.chats.bulkPut([
      {
        id: 'c1',
        userId: uid,
        personId: 'p1',
        stage: 'outreach_sent',
        stageEnteredAt: day(1),
        source: 'manual',
        goalTags: [],
        bumpCount: 1,
        priority: 2,
        createdAt: day(1),
        updatedAt: day(1),
      },
      {
        id: 'c2',
        userId: uid,
        personId: 'p2',
        stage: 'outreach_sent',
        stageEnteredAt: day(2),
        source: 'manual',
        goalTags: [],
        bumpCount: 0,
        priority: 2,
        createdAt: day(1),
        updatedAt: day(1),
      },
    ]);
    await db.touchpoints.put({
      id: 't1',
      userId: uid,
      personId: 'p2',
      kind: 'linkedin_in',
      occurredAt: day(4),
      refTable: 'x',
      refId: 'x',
      weight: 1,
    });
    const out = await sentForCoach(uid, new Date(Date.UTC(2026, 9, 20)));
    expect(out.map((m) => [m.id, m.type, m.replied, m.followedUp])).toEqual([
      ['o1', 'cold_email', false, true],
      ['o3', 'linkedin_note', true, false],
      ['o2', 'follow_up', false, false],
    ]);
    expect(out.find((m) => m.id === 'o2')!.gapDays).toBeCloseTo(2);
  });
});

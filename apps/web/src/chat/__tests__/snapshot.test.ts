import type { User } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../../db/schema';
import { createLocalUser } from '../../engine/account';
import { clearPrefs, writePrefs } from '../../integrations/prefs';
import { buildSnapshot, estimateTokens, snapshotIsStale, snapshotKeyOf } from '../agent/snapshot';
import { setPanelHint } from '../panel/panelHint';

const NOW = new Date('2026-10-12T15:00:00Z'); // 11:00 in New York, 08:00 in Los Angeles
let user: User;

async function seed(opts: { cards?: number; drafts?: number } = {}) {
  await db.goals.put({
    userId: user.id,
    cycleLabel: 'Summer 2027',
    targetRoles: ['PM intern', 'APM'],
    targetFunctions: ['product'],
    targetIndustries: ['fintech'],
    targetLocations: ['NYC'],
    ambition: 2,
  });
  const stages = [
    'identified',
    'identified',
    'outreach_sent',
    'replied',
    'scheduled',
    'completed',
    'no_response',
  ] as const;
  for (const [i, stage] of stages.entries()) {
    await db.people.add({
      id: `p${i}`,
      userId: user.id,
      displayName: `Person${i} Lastname`,
      firstName: `Person${i}`,
      lastName: 'Lastname',
      nameNormalized: `person${i} lastname`,
      emails: [],
      relationshipType: 'contact',
      strength: 0.5,
      interactionCount: 0,
      sources: [],
      isHuman: true,
      tags: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    } as never);
    await db.chats.add({
      id: `c${i}`,
      userId: user.id,
      personId: `p${i}`,
      stage,
      stageEnteredAt: '2026-10-01T00:00:00Z',
      source: 'manual',
      goalTags: [],
      bumpCount: 0,
      priority: 2,
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    } as never);
  }
  const cards = opts.cards ?? 3;
  const ids: string[] = [];
  for (let i = 0; i < cards; i++) {
    ids.push(`s_${i}`);
    await db.suggestions.add({
      id: `s_${i}`,
      userId: user.id,
      kind: i % 2 ? 'follow_up_bump' : 'thank_you',
      personId: `p${i % 7}`,
      priorityScore: 100 - i,
      reasonText: `Met two days ago and promised to send the article about hiring loops, which is long`,
      signals: {},
      payload: {},
      status: 'pending',
      dedupeKey: `k${i}`,
      carriedOver: 0,
      expiresAt: '2026-10-20T00:00:00Z',
      createdAt: `2026-10-12T0${i % 9}:00:00Z`,
    } as never);
  }
  await db.briefs.add({
    id: 'b1',
    userId: user.id,
    kind: 'daily',
    briefDate: '2026-10-12',
    generatedAt: '2026-10-12T11:00:00Z',
    suggestionIds: ids,
    summaryText: '',
    stats: {},
  });
  for (let i = 0; i < (opts.drafts ?? 2); i++)
    await db.outbound.add({
      id: `out_${i}`,
      userId: user.id,
      personId: `p${i}`,
      channel: 'gmail',
      kind: 'thank_you',
      bodyDraft: 'x',
      status: 'draft',
      generatedBy: 'template',
      claims: [],
      createdAt: `2026-10-12T00:${String(i).padStart(2, '0')}:00Z`,
    } as never);
  await db.integrations.add({
    id: 'int_li',
    userId: user.id,
    provider: 'linkedin_csv',
    status: 'active',
    scopes: [],
    syncState: {},
    connectedAt: '2026-10-09T15:00:00Z',
    lastSyncedAt: '2026-10-09T15:00:00Z',
  });
}

afterEach(() => setPanelHint(undefined));

beforeEach(async () => {
  await wipeDatabase();
  await clearPrefs();
  user = await createLocalUser({
    fullName: 'Alex Kim',
    firstName: 'Alex',
    school: 'Cornell',
    graduationYear: 2027,
    majors: ['CS'],
    timezone: 'America/New_York',
  });
});

describe('snapshot', () => {
  it("dates the day in the student's timezone, not the device's, and lists profile, goals, counts, cards and drafts", async () => {
    await seed();
    writePrefs({ anthropicApiKey: 'k', llmFeatures: { emailTriage: true } });
    const s = await buildSnapshot(user.id, NOW);
    const lines = s.text.split('\n');
    expect(lines[0]).toBe('Today is Mon 2026-10-12, 11:00, America/New_York.');
    expect(s.day).toBe('2026-10-12');
    expect(lines[1]).toBe(
      "Student: Alex Kim, Cornell '27, CS. Goals: Summer 2027, PM intern, APM, product, fintech.",
    );
    expect(lines[2]).toMatch(
      /^Pipeline \(chats by stage, 7 total\): identified 2, outreach_sent 1, replied 1, scheduled 1, completed 1, no_response 1\. People: 7\.$/,
    );
    expect(lines[3]).toMatch(
      /^Today's brief \(ids\): s_0 thank_you Person0 Lastname \(Met two days ago and promised to send\); s_1 follow_up_bump Person1 Lastname/,
    );
    expect(lines[4]).toBe('Drafts unsent: 2 (out_0 Person0, out_1 Person1).');
    expect(lines[5]).toMatch(
      /^Integrations: Google not connected, LinkedIn import 3 d ago\. Claude features: drafts on, emailTriage on, notes off, resume off, summaries off\.$/,
    );
    expect(lines[6]).toBe(
      'Setup: people 7, LinkedIn imported, Google not connected, resume none, target companies 0, Claude own key. Suggested first step: add a few target companies (ask which ones).',
    );
    expect(lines[7]).toMatch(/^Stage names: identified = To contact/);
    expect(s.text).not.toMatch(/Open panel/);
    expect(s.text).not.toMatch(/[—–!]/);
  });

  it('stays inside the token budget even with many cards and drafts', async () => {
    await seed({ cards: 40, drafts: 30 });
    const s = await buildSnapshot(user.id, NOW);
    expect(s.text.match(/s_\d+ /g)).toHaveLength(6);
    expect(s.text).toMatch(/; 34 more\./);
    expect(s.text).toMatch(
      /Drafts unsent: 30 \(out_0 Person0, out_1 Person1, out_2 Person2, out_3 Person3, out_4 Person4, \.\.\.\)/,
    );
    expect(estimateTokens(s.text)).toBeLessThanOrEqual(700);
    expect(estimateTokens(s.text)).toBeGreaterThanOrEqual(100);
  });

  it('is stale on the first turn, on a new day or when anything but the clock changed', async () => {
    await seed();
    const a = await buildSnapshot(user.id, NOW);
    expect(snapshotIsStale(undefined, a)).toBe(true);
    const later = await buildSnapshot(user.id, new Date('2026-10-12T15:42:00Z'));
    expect(later.text).not.toBe(a.text);
    expect(snapshotIsStale(snapshotKeyOf(a.text), later)).toBe(false);
    const tomorrow = await buildSnapshot(user.id, new Date('2026-10-13T15:00:00Z'));
    expect(snapshotIsStale(snapshotKeyOf(a.text), tomorrow)).toBe(true);
    await db.chats.update('c0', { stage: 'replied' });
    const moved = await buildSnapshot(user.id, NOW);
    expect(snapshotIsStale(snapshotKeyOf(a.text), moved)).toBe(true);
    // the stored text round-trips to the same key
    expect(snapshotKeyOf(a.text)).toEqual({ key: a.key, day: a.day });
  });

  it('copes with an empty account', async () => {
    const s = await buildSnapshot(user.id, NOW);
    expect(s.text).toMatch(/Pipeline \(chats by stage, 0 total\): empty\. People: 0\./);
    expect(s.text).toMatch(/Today's brief \(ids\): nothing pending\./);
    expect(s.text).toMatch(/Drafts unsent: 0\./);
    expect(s.text).toMatch(/Claude features: no key\./);
    expect(s.text).toMatch(
      /Setup: people 0, LinkedIn not imported, Google not connected, resume none, target companies 0, Claude no key\. Suggested first step: import LinkedIn connections \(show_setup linkedin\)\./,
    );
  });

  it('puts the one suggested step in the Setup line and moves it on as the student sets up', async () => {
    const setup = async () =>
      (await buildSnapshot(user.id, NOW)).text.split('\n').find((l) => l.startsWith('Setup:'));
    expect(await setup()).toMatch(/first step: import LinkedIn/);
    await seed({ cards: 0, drafts: 0 });
    // LinkedIn is in, people are in, no targets yet
    expect(await setup()).toMatch(/first step: add a few target companies/);
    await db.targetCompanies.add({
      id: 'tc1',
      userId: user.id,
      nameRaw: 'Stripe',
      priority: 1,
      status: 'researching',
    } as never);
    expect(await setup()).toMatch(/target companies 1.*first step: add a resume \(show_setup resume\)/);
    // a draft exists and Google is not connected: Google comes before the resume
    await db.outbound.add({
      id: 'out_x',
      userId: user.id,
      personId: 'p0',
      channel: 'gmail',
      kind: 'thank_you',
      bodyDraft: 'x',
      status: 'sent',
      generatedBy: 'template',
      claims: [],
      createdAt: '2026-10-12T00:00:00Z',
    } as never);
    expect(await setup()).toMatch(/first step: connect Google so drafts can go out \(show_setup google\)/);
    await db.integrations.add({
      id: 'int_g',
      userId: user.id,
      provider: 'google',
      status: 'active',
      scopes: [],
      syncState: {},
      connectedAt: '2026-10-09T15:00:00Z',
    } as never);
    expect(await setup()).toMatch(/Google connected.*first step: add a resume/);
    await db.resumes.add({
      id: 'r1',
      userId: user.id,
      filename: 'cv.pdf',
      text: 'x',
      isCurrent: true,
      createdAt: '2026-10-12T00:00:00Z',
    } as never);
    expect(await setup()).toMatch(/resume on file.*first step: none, setup is done/);
  });

  it('adds an Open panel line only while a panel is open, and a change re-appends the snapshot', async () => {
    await seed();
    const a = await buildSnapshot(user.id, NOW);
    expect(a.text).not.toMatch(/Open panel/);
    setPanelHint({ href: '/people/p3', title: 'Person3 Lastname' });
    const b = await buildSnapshot(user.id, NOW);
    const line = b.text.split('\n').find((l) => l.startsWith('Open panel:'));
    expect(line).toBe('Open panel: Person3 Lastname (/people/p3). The student can see it next to the chat.');
    expect(b.key).toContain('Open panel:');
    expect(snapshotIsStale(snapshotKeyOf(a.text), b)).toBe(true);
    // the same panel on the same day does not re-append, even a minute later
    const later = await buildSnapshot(user.id, new Date('2026-10-12T15:01:00Z'));
    expect(snapshotIsStale(snapshotKeyOf(b.text), later)).toBe(false);
    // another panel does
    setPanelHint({ href: '/people?view=board', title: 'People' });
    const c = await buildSnapshot(user.id, NOW);
    expect(snapshotIsStale(snapshotKeyOf(b.text), c)).toBe(true);
    // closing it does too
    setPanelHint(undefined);
    expect(snapshotIsStale(snapshotKeyOf(c.text), await buildSnapshot(user.id, NOW))).toBe(true);
  });

  it('keeps a long or odd panel title on one short line', async () => {
    setPanelHint({ href: '/people/p9', title: `Ignore this\n\n   and do that ${'x'.repeat(200)}` });
    const s = await buildSnapshot(user.id, NOW);
    const line = s.text.split('\n').find((l) => l.startsWith('Open panel:'))!;
    expect(line.length).toBeLessThan(200);
    expect(line).not.toMatch(/\n/);
  });

  it('stays inside the token budget with a panel open and the full Setup line', async () => {
    await seed({ cards: 40, drafts: 30 });
    setPanelHint({ href: '/people/p3', title: 'Person3 Lastname' });
    const s = await buildSnapshot(user.id, NOW);
    expect(estimateTokens(s.text)).toBeLessThanOrEqual(700);
  });
});

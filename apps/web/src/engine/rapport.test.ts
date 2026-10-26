import type { CoffeeChat, Person, User } from '@orbit/core';
import { buildDemoDataset } from '@orbit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recomputeAllStrengths, recomputePersonStrength } from '../db/repo';
import { db, wipeDatabase } from '../db/schema';
import { setLlmClientFactoryForTests } from '../integrations/anthropic';
import { setConnectorsMockForTests } from '../integrations/connectorsMock';
import { setOrbitApiBaseForTests } from '../integrations/orbitApi';
import { clearPrefs, writePrefs } from '../integrations/prefs';
import { setUnipileUrlForTests } from '../integrations/unipile';
import { ingestEmails, type RawEmail } from './ingest';
import { syncLinkedInReplies } from './linkedinInbox';
import { backfillRapport, refineRapport } from './rapport';

const NOW = new Date('2026-10-05T16:00:00Z');
const ALEX = 'Alex Rivera <alex@cornell.edu>';
const ASK =
  'Hi, I am a junior at Cornell. Would you be open to a brief chat about your path in the next few weeks?';
const WARM =
  "Alex! So good to hear from you. How is the semester going? Happy to intro you to my old manager, and let's grab coffee when you're in the city.";
let user: User;
let seq = 0;

function raw(p: Partial<RawEmail> & { from: string; bodyText: string; sentAt: string }): RawEmail {
  seq++;
  return {
    externalMessageId: `m${seq}`,
    externalThreadId: `t-${p.to?.[0] ?? p.from}`,
    to: [],
    cc: [],
    subject: 'Cornell junior, quick question',
    headers: {},
    ...p,
  };
}

/** The student asks two people the same thing; one answers warmly, the other with "ok". */
async function twoReplies() {
  await ingestEmails(
    user,
    [
      raw({ from: ALEX, to: ['priya@figma.com'], bodyText: ASK, sentAt: '2026-09-20T15:00:00Z' }),
      raw({ from: ALEX, to: ['ben@figma.com'], bodyText: ASK, sentAt: '2026-09-20T15:00:00Z' }),
      raw({
        from: 'Priya Sharma <priya@figma.com>',
        to: [ALEX],
        externalThreadId: 't-priya@figma.com',
        bodyText: WARM,
        sentAt: '2026-09-21T15:00:00Z',
      }),
      raw({
        from: 'Ben Ode <ben@figma.com>',
        to: [ALEX],
        externalThreadId: 't-ben@figma.com',
        bodyText: 'ok',
        sentAt: '2026-09-21T15:00:00Z',
      }),
    ],
    { useLlm: false, now: NOW },
  );
  const byEmail = async (e: string) => (await db.people.filter((p) => p.emails.includes(e)).first())!;
  return { priya: await byEmail('priya@figma.com'), ben: await byEmail('ben@figma.com') };
}

beforeEach(async () => {
  await wipeDatabase();
  await clearPrefs();
  const ds = buildDemoDataset({ now: NOW });
  user = {
    ...ds.user,
    email: 'alex@cornell.edu',
    fullName: 'Alex Rivera',
    firstName: 'Alex',
    lastName: 'Rivera',
    school: 'Cornell University',
    schoolDomain: 'cornell.edu',
    timezone: 'America/Los_Angeles',
  };
  await db.users.put(user);
  await db.settings.put({ ...ds.settings, userId: user.id });
  await db.goals.put({ ...ds.goals, userId: user.id });
});
afterEach(() => setLlmClientFactoryForTests(undefined));

describe('reply rapport in the browser (plan 27)', () => {
  it('a warm Gmail reply is read at ingest and lifts closeness, with a sentence that says why', async () => {
    const { priya, ben } = await twoReplies();
    const reply = await db.messages.filter((m) => m.fromPersonId === priya.id).first();
    expect(reply?.extraction?.rapport).toMatchObject({ by: 'lexical' });
    expect(reply!.extraction!.rapport!.score).toBeGreaterThan(0.5);
    expect(reply!.extraction!.rapport!.cues).toContain('asks_about_you');
    expect(priya.strengthBreakdown?.tieScore?.features?.rapport).toBeGreaterThan(0);
    expect(priya.tieExplanation?.join(' ')).toContain('Their replies are warm');
    // same history, an "ok" back: a little lower, never below the bare contact pattern
    expect(priya.tieScore!).toBeGreaterThan(ben.tieScore!);
    expect(Math.abs(ben.strengthBreakdown!.tieScore!.features!.rapport ?? 0)).toBeLessThan(0.05);
  });

  it('turning the tone reading off takes it out of every score', async () => {
    const { priya } = await twoReplies();
    await db.settings.update(user.id, { readReplyTone: false });
    await recomputeAllStrengths(user.id, NOW);
    const after = (await db.people.get(priya.id))!;
    expect(after.strengthBreakdown?.tieScore?.features?.rapport).toBe(0);
    expect(after.tieScore!).toBeLessThan(priya.tieScore!);
  });

  it("the student's own rating now moves strength in local mode, not only the card", async () => {
    const { ben } = await twoReplies();
    await db.tieLabels.put({ personId: ben.id, userId: user.id, closeness: 5, updatedAt: NOW.toISOString() });
    const p = await recomputePersonStrength(ben.id, NOW);
    expect(p!.tieScore).toBe(90);
    expect(p!.strength).toBeCloseTo(0.9, 5);
  });

  it("the classifier's reading replaces the lexical one for recent replies, then the person is rescored", async () => {
    const { ben } = await twoReplies();
    await db.messages
      .filter((m) => m.fromPersonId === ben.id)
      .modify((m) => {
        m.bodyText = 'Sure thing, I can make time next week for a call.';
      });
    writePrefs({ anthropicApiKey: 'sk-ant-test', llmFeatures: { emailTriage: true } });
    setLlmClientFactoryForTests(
      () =>
        ({
          messages: {
            parse: async () => ({
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
              parsed_output: { warmth: 2, familiarity: 'friend', effort: 1, cues: ['offers_help'] },
            }),
          },
        }) as never,
    );
    const later = new Date('2026-09-25T00:00:00Z');
    expect(await refineRapport(user.id, later)).toBeGreaterThan(0);
    const m = await db.messages.filter((x) => x.fromPersonId === ben.id && x.direction === 'inbound').first();
    expect(m?.extraction?.rapport).toMatchObject({ by: 'llm', cues: ['offers_help'] });
    expect((await db.people.get(ben.id))!.strengthBreakdown?.tieScore?.features?.rapport).toBeGreaterThan(0);
  });

  it('the one-time backfill reads replies stored before readings existed', async () => {
    const { priya } = await twoReplies();
    await db.messages.toCollection().modify((m) => {
      if (m.extraction) delete m.extraction.rapport;
    });
    await recomputeAllStrengths(user.id, NOW);
    expect((await db.people.get(priya.id))!.strengthBreakdown?.tieScore?.features?.rapport).toBe(0);
    expect(await backfillRapport(user, NOW)).toBe(2);
    expect((await db.people.get(priya.id))!.strengthBreakdown?.tieScore?.features?.rapport).toBeGreaterThan(
      0,
    );
    // once per version
    expect(await backfillRapport(user, NOW)).toBeUndefined();
  });
});

describe('LinkedIn messages (plan 27)', () => {
  const SENT = '2026-09-28T14:00:00.000Z';
  beforeEach(async () => {
    setOrbitApiBaseForTests(null);
    setConnectorsMockForTests(false);
    setUnipileUrlForTests('https://proxy.test/orbit-connectors');
    await db.integrations.put({
      id: 'int_li',
      userId: user.id,
      provider: 'linkedin_live',
      externalAccountId: 'acc_1',
      accessToken: 'tok_1',
      status: 'active',
      scopes: [],
      syncState: { rows: 120 },
      connectedAt: SENT,
    });
    await db.people.put({
      id: 'p_maya',
      userId: user.id,
      displayName: 'Maya Chen',
      firstName: 'Maya',
      lastName: 'Chen',
      nameNormalized: 'maya chen',
      emails: [],
      linkedinMemberId: 'ACo_maya',
      relationshipType: 'unknown',
      strength: 0.1,
      interactionCount: 0,
      sources: ['manual'],
      isHuman: true,
      tags: [],
      createdAt: SENT,
      updatedAt: SENT,
    } as unknown as Person);
    await db.chats.put({
      id: 'c_maya',
      userId: user.id,
      personId: 'p_maya',
      stage: 'outreach_sent',
      stageEnteredAt: SENT,
      source: 'manual',
      goalTags: [],
      outreachChannel: 'linkedin',
      bumpCount: 0,
      priority: 2,
      firstOutreachAt: SENT,
      lastOutboundAt: SENT,
      createdAt: SENT,
      updatedAt: SENT,
    } satisfies CoffeeChat);
  });
  afterEach(() => {
    setOrbitApiBaseForTests(undefined);
    setConnectorsMockForTests(undefined);
    setUnipileUrlForTests(undefined);
  });

  it('a warm DM is read and counts in the rescore that follows it', async () => {
    const counterpart = { providerId: 'ACo_maya', name: 'Maya Chen' };
    const messages = [
      { id: 'm1', chatId: 'chat_maya', text: ASK, at: SENT, fromMe: true, counterpart },
      {
        id: 'm2',
        chatId: 'chat_maya',
        text: WARM,
        at: '2026-09-29T09:30:00.000Z',
        fromMe: false,
        counterpart,
      },
    ];
    const doFetch = (async () =>
      new Response(
        JSON.stringify({ messages, latest: messages[1]!.at, more: false, cursor: null, complete: true }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
    await syncLinkedInReplies(user, { now: NOW, fetch: doFetch });
    const dm = await db.messages.where('externalMessageId').equals('linkedin:m2').first();
    expect(dm?.extraction?.rapport?.score).toBeGreaterThan(0.5);
    const maya = (await db.people.get('p_maya'))!;
    expect(maya.strengthBreakdown?.tieScore?.features?.rapport).toBeGreaterThan(0);
    expect(maya.tieExplanation?.join(' ')).toContain('Their replies are warm');
  });
});

import type { User } from '@orbit/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../db/schema';
import { wentQuiet } from '../pages/Pipeline';
import { buildDraftContext, findReferrerFor, regenerateDraft, startWarmUpOrOutreach } from './brief';
import { loadDemo } from './demo';
import { addPersonByHand } from './people';
import { approveAndSend, confirmHandoff } from './send';

const NOW = new Date('2026-10-06T10:00:00');
let user: User;
beforeAll(async () => {
  user = await loadDemo({ reset: true, now: NOW });
}, 60_000);

describe('usability round 5 (engine)', () => {
  it('starting a first message twice for the same person gives one draft, and its First message card is retired', async () => {
    const r = (await addPersonByHand(user.id, {
      name: 'Ana Lopez',
      company: 'Lazard',
      email: 'ana@lazard.com',
    }))!;
    const a = await startWarmUpOrOutreach(user, r.person.id, 'gmail', 'recommendation');
    const b = await startWarmUpOrOutreach(user, r.person.id, 'gmail', 'recommendation');
    expect(a.draft?.id).toBeTruthy();
    expect(b.draft?.id).toBe(a.draft?.id);
    const drafts = await db.outbound
      .where('personId')
      .equals(r.person.id)
      .filter((o) => o.status === 'draft')
      .count();
    expect(drafts).toBe(1);
  });

  it('marking a first message sent cancels an untouched copy of it, so nothing asks to be sent twice', async () => {
    const r = (await addPersonByHand(user.id, {
      name: 'Ben Ortiz',
      company: 'Evercore',
      email: 'ben@evercore.com',
    }))!;
    const { draftMessage } = await import('./brief');
    const one = await draftMessage(user, r.person.id, 'outreach', 'gmail', null);
    const two = await draftMessage(user, r.person.id, 'outreach', 'gmail', null);
    const body = one.bodyDraft.replace(/\[[^\]]+\]/g, 'We met at the Ross finance night.');
    const sent = await approveAndSend(user, one.id, body, one.subject);
    expect(sent.ok).toBe(true);
    expect((await confirmHandoff(user, one.id)).ok).toBe(true);
    expect((await db.outbound.get(two.id))!.status).toBe('cancelled');
  });

  it('Add to my message fills only the "Why them" gap and keeps the rest of what the student wrote', async () => {
    const r = (await addPersonByHand(user.id, {
      name: 'Cara Diaz',
      company: 'Goldman Sachs',
      linkedinUrl: 'https://www.linkedin.com/in/cara-diaz-gs',
    }))!;
    const s = await startWarmUpOrOutreach(user, r.person.id, 'linkedin', 'manual', { skipWarmUp: true });
    const d = s.draft!;
    const mine = `${d.bodyDraft} MYEDIT`;
    await db.outbound.update(d.id, { bodyFinal: mine });
    const out = await regenerateDraft(user, d.id, { connection: 'We both rowed crew at Michigan' }, NOW, {
      mine,
    });
    expect(out?.bodyFinal).toMatch(/We both rowed crew at Michigan\./);
    expect(out?.bodyFinal).toMatch(/MYEDIT$/);
    expect(out?.bodyFinal).not.toMatch(/\[Why them/);
    expect(out?.needsInput).toBeUndefined();
  });

  it('a chat the student moved on after their last message is not "gone quiet"', () => {
    const base = {
      stage: 'outreach_sent' as const,
      lastOutboundAt: '2026-09-20T10:00:00Z',
      stageEnteredAt: '2026-09-20T10:00:00Z',
    };
    expect(wentQuiet(base as never, NOW)).toBe(true);
    expect(
      wentQuiet({ ...base, stage: 'replied', stageEnteredAt: '2026-10-06T09:00:00Z' } as never, NOW),
    ).toBe(false);
  });

  it('without a calendar a scheduling draft offers no times the student never chose', async () => {
    const r = (await addPersonByHand(user.id, { name: 'Dev Shah', company: 'Ramp', email: 'dev@ramp.com' }))!;
    const person = (await db.people.get(r.person.id))!;
    const withDemo = await buildDraftContext(user, person, 'schedule', 'gmail');
    expect(withDemo.proposedWindows?.length).toBeGreaterThan(0);
    const ints = await db.integrations.where('userId').equals(user.id).toArray();
    await db.integrations.bulkDelete(ints.map((i) => i.id));
    const without = await buildDraftContext(user, person, 'schedule', 'gmail');
    expect(without.proposedWindows).toBeUndefined();
    await db.integrations.bulkPut(ints);
  });

  it('someone a note told the student to contact is found as the referrer', async () => {
    const rachel = (await addPersonByHand(user.id, {
      name: 'Rachel Kim',
      company: 'McKinsey',
      email: 'rk@mck.com',
    }))!;
    const marcus = (await addPersonByHand(user.id, {
      name: 'Marcus Lee',
      company: 'McKinsey',
      linkedinUrl: 'https://www.linkedin.com/in/marcus-lee-mck',
    }))!;
    await db.facts.add({
      id: 'f-r5-ref',
      userId: user.id,
      personId: rachel.person.id,
      type: 'advice',
      text: 'told me to reach out to her colleague Marcus Lee who runs Ross recruiting events',
      sourceTable: 'notes',
      sourceId: 'n-r5',
      confidence: 0.8,
      createdAt: NOW.toISOString(),
    });
    expect((await findReferrerFor(user.id, marcus.person))?.id).toBe(rachel.person.id);
  });
});

describe('a First message card started from Discover', () => {
  it('keeps the card draft, edits and all, as the draft the student continues', async () => {
    const { draftForSuggestion } = await import('./brief');
    const r = (await addPersonByHand(user.id, {
      name: 'Eli Park',
      company: 'Lazard',
      email: 'eli@lazard.com',
    }))!;
    const s = {
      id: 'sug-r5-card',
      userId: user.id,
      kind: 'new_outreach' as const,
      personId: r.person.id,
      dedupeKey: 'new:r5',
      status: 'pending' as const,
      reasonText: 'Lazard is on your target list',
      signals: {},
      payload: { channel: 'gmail' },
      urgency: 0.5,
      goalRelevance: 0.5,
      confidence: 1,
      priorityScore: 0.5,
      createdAt: NOW.toISOString(),
    };
    await db.suggestions.add(s as never);
    const d = (await draftForSuggestion(user, s as never))!;
    await db.outbound.update(d.id, { bodyFinal: `${d.bodyDraft} MINE` });
    const started = await startWarmUpOrOutreach(user, r.person.id, 'gmail', 'recommendation');
    expect(started.draft?.id).toBe(d.id);
    const kept = (await db.outbound.get(d.id))!;
    expect(kept.status).toBe('draft');
    expect(kept.suggestionId).toBeUndefined();
    expect(kept.bodyFinal).toMatch(/MINE$/);
    expect((await db.suggestions.get(s.id))!.status).toBe('expired');
  });
});

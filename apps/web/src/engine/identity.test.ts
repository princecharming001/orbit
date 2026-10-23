/**
 * One person across sources in this browser (plan 17 §A): merging moves everything kept about a person, local
 * resolution honours the student's "not the same" and the same-mailbox proof like the server does, and a Contacts
 * card's numbers find their person.
 */
import type { Person } from '@orbit/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, wipeDatabase } from '../db/schema';
import { mergePeople, upsertPerson } from './people';

const U = 'u1';
const NOW = '2026-10-20T12:00:00.000Z';

function person(id: string, displayName: string, over: Partial<Person> = {}): Person {
  const [firstName = '', ...rest] = displayName.split(' ');
  return {
    id,
    userId: U,
    displayName,
    firstName,
    lastName: rest.join(' '),
    nameNormalized: displayName.toLowerCase(),
    emails: [],
    relationshipType: 'unknown',
    strength: 0,
    interactionCount: 0,
    sources: ['gmail'],
    isHuman: true,
    tags: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

beforeEach(async () => {
  await wipeDatabase();
});

/** Every value in a row, however deep, that equals `id`. */
function mentions(row: unknown, id: string, path = ''): string[] {
  if (row === id) return [path];
  if (Array.isArray(row)) return row.flatMap((x, i) => mentions(x, id, `${path}[${i}]`));
  if (row && typeof row === 'object')
    return Object.entries(row).flatMap(([k, v]) => mentions(v, id, path ? `${path}.${k}` : k));
  return [];
}

describe('mergePeople', () => {
  it('leaves nothing pointing at the merged person in any table that keeps people', async () => {
    const S = 'p_survivor';
    const M = 'p_merged';
    const X = 'p_other';
    await db.people.bulkAdd([
      person(S, 'Liz Chen', {
        primaryEmail: 'lizchen@gmail.com',
        emails: ['lizchen@gmail.com'],
        tags: ['a'],
      }),
      person(M, 'Elizabeth Chen', {
        sources: ['linkedin_csv'],
        linkedinUrl: 'https://www.linkedin.com/in/elizabeth-chen-12',
        linkedinSlug: 'elizabeth-chen-12',
        linkedinMemberId: 'ACoAA9',
        photoUrl: 'https://media.licdn.com/liz.jpg',
        headline: 'PM at Stripe',
        currentOrganizationRaw: 'Stripe',
        currentTitle: 'PM',
        fieldSources: { currentTitle: 'linkedin_csv', headline: 'linkedin_csv' },
        phones: ['+15551234567'],
        tags: ['b'],
      }),
      person(X, 'Daniel Kim'),
    ]);
    // one row in every table with a person field (seeded generically from the schema), and the rows that list people
    const personFields = (t: (typeof db.tables)[number]) =>
      [t.schema.primKey, ...t.schema.indexes]
        .map((i) => i.name)
        .filter((n) => /person/i.test(n) && !n.includes('+'));
    let seeded = 0;
    for (const t of db.tables) {
      if (t.name === 'people') continue;
      const fields = personFields(t);
      if (!fields.length) continue;
      const row: Record<string, unknown> = { userId: U };
      if (t.schema.primKey.name && !fields.includes(t.schema.primKey.name))
        row[t.schema.primKey.name] = `${t.name}_1`;
      for (const f of fields) row[f] = M;
      if (t.name === 'touchpoints')
        Object.assign(row, { refTable: 'messages', refId: 'm1', kind: 'email_in' });
      if (t.name === 'edges')
        Object.assign(row, { personAId: M, personBId: X, type: 'co_tenure', weight: 1 });
      if (t.name === 'textThreads')
        Object.assign(row, {
          id: M,
          handles: ['+15551234567'],
          inCount: 1,
          outCount: 1,
          firstAt: NOW,
          lastAt: NOW,
          recent: [],
        });
      if (t.name === 'affiliations')
        Object.assign(row, { kind: 'employment', nameRaw: 'Stripe', isCurrent: true });
      await t.put(row);
      seeded++;
    }
    expect(seeded).toBeGreaterThanOrEqual(15);
    await db.threads.put({
      id: 'th1',
      userId: U,
      externalThreadId: 'g1',
      messageCount: 1,
      participantEmails: [],
      participantPersonIds: [M, S],
      isNetworking: true,
      introduction: { introducerId: X, introducedIds: [M], messageId: 'm1', at: NOW },
    });
    await db.events.put({
      id: 'ev1',
      userId: U,
      externalEventId: 'e1',
      startAt: NOW,
      endAt: NOW,
      status: 'confirmed',
      attendees: [],
      attendeePersonIds: [M],
    });
    await db.notes.put({
      id: 'n1',
      userId: U,
      source: 'manual',
      occurredAt: NOW,
      rawText: 'coffee with Liz',
      attendees: [],
      personIds: [M],
      matchStatus: 'auto',
      createdAt: NOW,
      extraction: {
        summary: '',
        facts: [{ about: M, type: 'role', text: 'leads payments', confidence: 0.8 }],
        actionItems: [],
        offers: [],
        hooks: [],
        warmth: 'warm',
        suggestedNextStep: '',
      },
    } as never);
    await db.chats.put({
      id: 'c_other',
      userId: U,
      personId: X,
      referrerPersonId: M,
      stage: 'outreach_sent',
      stageEnteredAt: NOW,
      source: 'manual',
      goalTags: [],
      bumpCount: 0,
      priority: 2,
      createdAt: NOW,
      updatedAt: NOW,
    } as never);
    await db.suggestions.put({
      id: 'sg_merge',
      userId: U,
      kind: 'confirm_merge',
      personId: X,
      priorityScore: 0.2,
      reasonText: '',
      signals: {},
      payload: { mergeId: 'mrg_x', otherPersonId: M },
      status: 'open',
      dedupeKey: 'merge:mrg_x',
      carriedOver: 0,
      expiresAt: NOW,
      createdAt: NOW,
    } as never);
    await db.merges.bulkPut([
      // the student said Elizabeth Chen is not Daniel Kim: that answer must survive the merge
      {
        id: 'mrg_no',
        userId: U,
        personAId: X,
        personBId: M,
        score: 0.7,
        features: {},
        status: 'rejected',
        createdAt: NOW,
      },
      {
        id: 'mrg_this',
        userId: U,
        personAId: S,
        personBId: M,
        score: 0.9,
        features: {},
        status: 'pending',
        createdAt: NOW,
      },
    ]);
    await db.introRequests.put({ id: 'ir1', userId: U, targetPersonId: M, introducerPersonId: X });
    await db.tieLabels.put({ personId: M, userId: U, closeness: 4, updatedAt: NOW });

    await mergePeople(U, S, M);

    expect(await db.people.get(M)).toBeUndefined();
    const left: string[] = [];
    for (const t of db.tables) {
      if (t.name === 'audit' || t.name === 'feedback') continue;
      for (const row of await t.toArray()) {
        // the card about these two is the record of this merge
        if (t.name === 'merges' && (row as { id: string }).id === 'mrg_this') continue;
        for (const at of mentions(row, M)) left.push(`${t.name}.${at}`);
      }
    }
    expect(left).toEqual([]);
    const s = (await db.people.get(S))!;
    expect(s).toMatchObject({
      displayName: 'Liz Chen',
      primaryEmail: 'lizchen@gmail.com',
      phones: ['+15551234567'],
      linkedinSlug: 'elizabeth-chen-12',
      linkedinMemberId: 'ACoAA9',
      photoUrl: 'https://media.licdn.com/liz.jpg',
      headline: 'PM at Stripe',
      currentOrganizationRaw: 'Stripe',
    });
    expect(s.sources.sort()).toEqual(['gmail', 'linkedin_csv']);
    expect(s.tags.sort()).toEqual(['a', 'b']);
    expect(await db.textThreads.get(S)).toMatchObject({ personId: S, handles: ['+15551234567'] });
    expect(await db.tieLabels.get(S)).toMatchObject({ closeness: 4 });
    expect(await db.merges.get('mrg_no')).toMatchObject({ personAId: X, personBId: S, status: 'rejected' });
    expect((await db.threads.get('th1'))!.participantPersonIds).toEqual([S]);
    // a tie between the merged person and someone else is now the survivor's
    expect(await db.edges.where('personAId').equals(S).count()).toBe(1);
  });

  it('keeps one copy of what both records had (a touch, an employer) and drops a tie between them', async () => {
    await db.people.bulkAdd([person('s', 'Ana Ruiz'), person('m', 'Ana Ruiz', { sources: ['imessage'] })]);
    for (const pid of ['s', 'm'])
      await db.touchpoints.add({
        id: `tp_${pid}`,
        userId: U,
        personId: pid,
        kind: 'email_in',
        occurredAt: NOW,
        refTable: 'messages',
        refId: 'm1',
        weight: 1,
      });
    await db.affiliations.bulkAdd(
      ['s', 'm'].map((pid) => ({
        id: `af_${pid}`,
        userId: U,
        personId: pid,
        kind: 'employment' as const,
        nameRaw: 'Stripe',
        isCurrent: true,
        source: 'gmail' as const,
      })),
    );
    await db.edges.add({
      id: 'e1',
      userId: U,
      personAId: 's',
      personBId: 'm',
      type: 'co_tenure',
      weight: 1,
      evidence: {},
    });
    await mergePeople(U, 's', 'm');
    expect(await db.touchpoints.where('personId').equals('s').count()).toBe(1);
    expect(await db.affiliations.where('personId').equals('s').count()).toBe(1);
    expect(await db.edges.count()).toBe(0);
  });
});

describe('local resolution follows the same rules as the server', () => {
  it('never matches a pair the student said are two people', async () => {
    await db.people.bulkAdd([
      person('dk', 'Daniel Kim', { primaryEmail: 'dkim@stripe.com', emails: ['dkim@stripe.com'] }),
      person('dk2', 'Daniel Kim', { sources: ['linkedin_csv'], currentOrganizationRaw: 'Stripe' }),
    ]);
    await db.merges.add({
      id: 'mrg1',
      userId: U,
      personAId: 'dk',
      personBId: 'dk2',
      score: 0.95,
      features: {},
      status: 'rejected',
      createdAt: NOW,
    });
    // the same CSV row again: it belongs to dk2, and dk is never offered for it
    const r = await upsertPerson({
      userId: U,
      firstName: 'Daniel',
      lastName: 'Kim',
      companyRaw: 'Stripe',
      linkedinUrl: 'https://www.linkedin.com/in/daniel-kim-2',
      personId: 'dk2',
      source: 'linkedin_csv',
    });
    expect(r.person.id).not.toBe('dk');
    expect(await db.merges.filter((m) => m.status === 'pending').count()).toBe(0);
  });

  it('merges a LinkedIn-only namesake into the owner of the address that writes under that name', async () => {
    await db.people.bulkAdd([
      person('liz', 'Liz Chen', { primaryEmail: 'lizchen@gmail.com', emails: ['lizchen@gmail.com'] }),
      person('eli', 'Elizabeth Chen', {
        sources: ['linkedin_csv'],
        linkedinSlug: 'elizabeth-chen-12',
        linkedinUrl: 'https://www.linkedin.com/in/elizabeth-chen-12',
        currentOrganizationRaw: 'Stripe',
      }),
    ]);
    await db.touchpoints.add({
      id: 'tp_eli',
      userId: U,
      personId: 'eli',
      kind: 'linkedin_connected',
      occurredAt: NOW,
      refTable: 'linkedin',
      refId: 'c1',
      weight: 0.2,
    } as never);
    const r = await upsertPerson({
      userId: U,
      email: 'Liz.Chen@gmail.com',
      displayName: 'Elizabeth Chen',
      source: 'calendar',
    });
    expect(r.person.id).toBe('liz');
    expect(await db.people.get('eli')).toBeUndefined();
    expect(await db.people.get('liz')).toMatchObject({ linkedinSlug: 'elizabeth-chen-12' });
    expect(await db.touchpoints.get('tp_eli')).toMatchObject({ personId: 'liz' });
  });

  it('files numbers on the person and finds them by number; a namesake with other Contacts numbers is someone else', async () => {
    const a = await upsertPerson({
      userId: U,
      displayName: 'Ana Ruiz',
      phones: ['+15551110000'],
      phonesVerified: true,
      source: 'imessage',
    });
    expect(a.person.phones).toEqual(['+15551110000']);
    // the same number under a nickname: the same person
    const again = await upsertPerson({
      userId: U,
      displayName: 'Ana R',
      phones: ['+15551110000'],
      phonesVerified: true,
      email: 'ana@stripe.com',
      source: 'imessage',
    });
    expect(again).toMatchObject({ created: false });
    expect(again.person.id).toBe(a.person.id);
    expect((await db.people.get(a.person.id))!.emails).toContain('ana@stripe.com');
    // another card called Ana Ruiz with its own number: a second person, and not even a question
    const other = await upsertPerson({
      userId: U,
      displayName: 'Ana Ruiz',
      phones: ['+15552220000'],
      phonesVerified: true,
      source: 'imessage',
    });
    expect(other.created).toBe(true);
    expect(await db.merges.count()).toBe(0);
  });
});

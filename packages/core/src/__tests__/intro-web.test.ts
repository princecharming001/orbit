import { describe, expect, it } from 'vitest';
import {
  buildIntroWeb,
  describeIntroChain,
  type IntroSources,
  introChain,
  introDescendants,
  introStories,
} from '../graph/introWeb';

const person = (id: string, extra: { hiddenAt?: string; isHuman?: boolean } = {}) => ({
  id,
  isHuman: extra.isHuman ?? true,
  hiddenAt: extra.hiddenAt,
});
const NAMES: Record<string, string> = {
  priya: 'Priya',
  mei: 'Mei',
  sam: 'Sam',
  ana: 'Ana',
  leo: 'Leo',
  kim: 'Kim',
};
const nameOf = (id: string) => NAMES[id] ?? id;

/** Priya introduced the student to Mei by email; Mei's chat names her as referrer for Sam; Leo suggested Kim. */
const sources = (): IntroSources => ({
  people: ['priya', 'mei', 'sam', 'ana', 'leo', 'kim'].map((id) => person(id)),
  edges: [
    {
      personAId: 'mei',
      personBId: 'priya',
      type: 'introduced_by',
      evidence: { introducerId: 'priya', at: '2026-03-01T10:00:00Z' },
    },
    // a co-worker edge is not an introduction
    { personAId: 'ana', personBId: 'priya', type: 'co_tenure', evidence: {} },
  ],
  chats: [
    { personId: 'sam', referrerPersonId: 'mei', createdAt: '2026-04-02T10:00:00Z' },
    { personId: 'priya', createdAt: '2026-01-02T10:00:00Z' },
  ],
  facts: [
    {
      personId: 'kim',
      type: 'connection',
      sourceTable: 'suggested_by',
      sourceId: 'leo',
      occurredAt: '2026-05-05T10:00:00Z',
      createdAt: '2026-05-05T10:00:00Z',
    },
    // a connection fact from a note is not a referral
    {
      personId: 'ana',
      type: 'connection',
      sourceTable: 'notes',
      sourceId: 'n1',
      createdAt: '2026-05-05T10:00:00Z',
    },
  ],
});

describe('intro web', () => {
  it('builds chains only from recorded introductions, referrals and suggestions', () => {
    const web = buildIntroWeb(sources());
    expect(web.links.map((l) => `${l.fromId}>${l.toId}:${l.kind}`)).toEqual([
      'priya>mei:intro',
      'mei>sam:referral',
      'leo>kim:suggested',
    ]);
    expect([...web.members].sort()).toEqual(['kim', 'leo', 'mei', 'priya', 'sam']);
    expect(web.members.has('ana')).toBe(false);
    expect(web.roots).toEqual(['priya', 'leo']);
    expect(web.generation.get('priya')).toBe(1);
    expect(web.generation.get('mei')).toBe(2);
    expect(web.generation.get('sam')).toBe(3);
    expect(web.root.get('sam')).toBe('priya');
    expect(web.root.get('kim')).toBe('leo');
    expect(web.depth).toBe(3);
  });

  it('one link per pair: an email intro also recorded on the chat stays one intro, dated by the earliest record', () => {
    const s = sources();
    s.chats!.push({
      personId: 'mei',
      referrerPersonId: 'priya',
      introducedAt: '2026-02-27T09:00:00Z',
      createdAt: '2026-03-02T10:00:00Z',
    });
    s.threads = [
      {
        introduction: {
          introducerId: 'priya',
          introducedIds: ['mei'],
          messageId: 'm1',
          at: '2026-03-01T10:00:00Z',
        },
      },
    ];
    const web = buildIntroWeb(s);
    const links = web.links.filter((l) => l.toId === 'mei');
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ fromId: 'priya', kind: 'intro', at: '2026-02-27T09:00:00Z' });
  });

  it('leaves out hidden people, self links and links that would close a loop', () => {
    const s = sources();
    s.people = s.people.map((p) => (p.id === 'leo' ? person('leo', { hiddenAt: '2026-06-01' }) : p));
    s.chats!.push({ personId: 'priya', referrerPersonId: 'sam', createdAt: '2026-06-01T10:00:00Z' });
    s.chats!.push({ personId: 'mei', referrerPersonId: 'mei', createdAt: '2026-06-01T10:00:00Z' });
    const web = buildIntroWeb(s);
    expect(web.members.has('leo')).toBe(false);
    expect(web.members.has('kim')).toBe(false);
    // sam > priya came after priya > mei > sam: it would make a loop, so it is not drawn
    expect(web.links.some((l) => l.fromId === 'sam')).toBe(false);
    expect(web.links.some((l) => l.fromId === l.toId)).toBe(false);
    expect(web.roots).toEqual(['priya']);
  });

  it('a person introduced twice hangs from the earliest introducer; both real links are kept', () => {
    const s = sources();
    s.chats!.push({ personId: 'sam', referrerPersonId: 'priya', createdAt: '2026-05-01T10:00:00Z' });
    const web = buildIntroWeb(s);
    expect(web.parent.get('sam')?.fromId).toBe('mei');
    expect(web.links.filter((l) => l.toId === 'sam')).toHaveLength(2);
    expect(web.generation.get('sam')).toBe(3);
  });

  it('walks chains up and down', () => {
    const web = buildIntroWeb(sources());
    expect(introChain(web, 'sam')).toEqual(['priya', 'mei', 'sam']);
    expect(introChain(web, 'ana')).toEqual([]);
    expect(introDescendants(web, 'priya')).toEqual(['mei', 'sam']);
    expect(introDescendants(web, 'sam')).toEqual([]);
  });

  it('describes a chain in plain words', () => {
    const web = buildIntroWeb(sources());
    expect(describeIntroChain(web, 'sam', nameOf)).toBe(
      'Priya introduced you to Mei, who referred you to Sam.',
    );
    // the first person in a chain: follow it down
    expect(describeIntroChain(web, 'priya', nameOf)).toBe(
      'Priya introduced you to Mei, who referred you to Sam.',
    );
    expect(describeIntroChain(web, 'kim', nameOf)).toBe('Leo suggested you talk to Kim.');
    expect(describeIntroChain(web, 'ana', nameOf)).toBe('');
  });

  it('lists several people introduced by the same person in one sentence', () => {
    const s = sources();
    s.chats!.push({ personId: 'ana', referrerPersonId: 'mei', createdAt: '2026-04-03T10:00:00Z' });
    s.facts!.push({
      personId: 'leo',
      type: 'connection',
      sourceTable: 'suggested_by',
      sourceId: 'mei',
      createdAt: '2026-04-04T10:00:00Z',
    });
    const web = buildIntroWeb(s);
    expect(describeIntroChain(web, 'mei', nameOf)).toBe(
      'Priya introduced you to Mei, who referred you to Sam and Ana and suggested you talk to Leo.',
    );
    expect(introStories(web, nameOf).map((x) => x.text)).toEqual([
      'Priya introduced you to Mei, who referred you to Sam and Ana.',
      'Priya introduced you to Mei, who suggested you talk to Leo, who suggested you talk to Kim.',
    ]);
  });

  it('is empty without introductions', () => {
    const web = buildIntroWeb({ people: [person('a'), person('b')] });
    expect(web.links).toEqual([]);
    expect(web.depth).toBe(0);
    expect(introStories(web, nameOf)).toEqual([]);
  });
});

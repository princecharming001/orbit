import { describe, expect, it } from 'vitest';
import { fillFunnelText, funnelFor, funnelReply, LINK_REPLY, parseFunnels, type ReplyFunnel } from './funnel';

const f = (over: Partial<ReplyFunnel>): ReplyFunnel => ({
  id: 'g1',
  name: 'Recruiters',
  personIds: ['11111111-1111-1111-1111-111111111111'],
  interested: 'link',
  createdAt: '2026-11-10T00:00:00.000Z',
  ...over,
});

describe('a group funnel', () => {
  it('the newest group that names someone is theirs', () => {
    const a = f({ id: 'a' });
    const b = f({ id: 'b', createdAt: '2026-11-11T00:00:00.000Z' });
    expect(funnelFor([a, b], '11111111-1111-1111-1111-111111111111')?.id).toBe('b');
    expect(funnelFor([a], 'someone-else')).toBeUndefined();
  });
  it('a booking link group answers with the link, filled in and signed', () => {
    const text = funnelReply(f({}), { first: 'Priya', link: 'https://cal.com/maya/15', signOff: 'Maya' })!;
    expect(text).toContain('Hi Priya,');
    expect(text).toContain('https://cal.com/maya/15');
    expect(text.endsWith('Best,\nMaya')).toBe(true);
    expect(LINK_REPLY).toContain('{link}');
  });
  it('no link, no booking reply: Orbit offers times instead', () => {
    expect(funnelReply(f({}), { first: 'Priya' })).toBeUndefined();
    expect(funnelReply(f({ interested: 'slots' }), { first: 'Priya', link: 'x' })).toBeUndefined();
  });
  it('the student own words, with an unknown first name and company', () => {
    const own = f({ interested: 'own', reply: 'Hi {first}, thanks. Is {company} hiring PMs this spring?' });
    expect(funnelReply(own, {})).toBe('Hi there, thanks. Is hiring PMs this spring?');
    expect(fillFunnelText('Hey {first} , great', { first: 'Sam' })).toBe('Hey Sam, great');
  });
  it('the server takes only clean rows', () => {
    expect(parseFunnels('x')).toEqual({ error: 'replyFunnels must be a list' });
    expect(
      parseFunnels([
        { id: 'a', name: 'n', personIds: ['bad', 'AAAAAAAA-1111-1111-1111-111111111111'], interested: 'own' },
      ]),
    ).toEqual([
      {
        id: 'a',
        name: 'n',
        personIds: ['aaaaaaaa-1111-1111-1111-111111111111'],
        interested: 'own',
        reply: undefined,
        followUp: undefined,
        createdAt: new Date(0).toISOString(),
      },
    ]);
    expect(parseFunnels([{ id: 'a', name: 'n', personIds: [], interested: 'maybe' }])).toEqual({
      error: 'interested is slots, link or own',
    });
  });
});

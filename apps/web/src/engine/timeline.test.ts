import { describe, expect, it } from 'vitest';
import { conversationCounts, groupTimeline, type TimelineEntry } from './timeline';

const li = (at: string, inbound: boolean): TimelineEntry => ({
  at,
  text: inbound ? 'LinkedIn message from Shubh' : 'LinkedIn message to Shubh',
  icon: 'in',
  kind: inbound ? 'linkedin_in' : 'linkedin_out',
});

describe('a person timeline folds a back-and-forth into one conversation', () => {
  it('messages days apart on one channel are one row with counts, newest first', () => {
    const rows = groupTimeline(
      [
        li('2026-03-03T20:42:00Z', true),
        li('2026-03-03T20:57:00Z', false),
        li('2026-03-06T13:13:00Z', true),
        li('2026-03-07T19:05:00Z', false),
      ],
      'Shubh',
    );
    expect(rows).toHaveLength(1);
    const c = rows[0]!;
    expect(c.type).toBe('conversation');
    if (c.type !== 'conversation') return;
    expect(c.text).toBe('LinkedIn conversation with Shubh');
    expect([c.from, c.at]).toEqual(['2026-03-03T20:42:00Z', '2026-03-07T19:05:00Z']);
    expect([c.theirs, c.yours]).toEqual([2, 2]);
    expect(c.entries.map((e) => e.at)).toEqual([
      '2026-03-07T19:05:00Z',
      '2026-03-06T13:13:00Z',
      '2026-03-03T20:57:00Z',
      '2026-03-03T20:42:00Z',
    ]);
    expect(conversationCounts(c, 'Shubh')).toBe('4 messages, 2 from Shubh and 2 from you');
  });

  it('a long silence starts a new conversation, and a lone message stays a message', () => {
    const rows = groupTimeline(
      [
        li('2026-01-02T10:00:00Z', false),
        li('2026-03-03T20:42:00Z', true),
        li('2026-03-04T09:00:00Z', false),
      ],
      'Shubh',
    );
    expect(rows.map((r) => r.type)).toEqual(['conversation', 'entry']);
    expect(rows[1]!.text).toBe('LinkedIn message to Shubh');
  });

  it('another channel in between ends the conversation; emails and meetings stay their own rows', () => {
    const rows = groupTimeline(
      [
        li('2026-03-03T10:00:00Z', true),
        li('2026-03-03T11:00:00Z', false),
        { at: '2026-03-03T12:00:00Z', text: 'Email to Shubh: Hello', icon: '↗', kind: 'email_out' },
        li('2026-03-03T13:00:00Z', true),
        li('2026-03-03T14:00:00Z', false),
        { at: '2026-03-03T15:00:00Z', text: 'Text', icon: 'T', kind: 'text_in' },
        { at: '2026-03-03T16:00:00Z', text: 'Text', icon: 'T', kind: 'text_out' },
      ],
      'Shubh',
    );
    expect(rows.map((r) => (r.type === 'conversation' ? r.text : r.kind))).toEqual([
      'Texts with Shubh',
      'LinkedIn conversation with Shubh',
      'email_out',
      'LinkedIn conversation with Shubh',
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  callAppOfUrl,
  matchCallToEvent,
  meetCodeFromUrl,
  meetEntriesToText,
  meetParticipantName,
  parseVtt,
  transcriptText,
  vttToText,
  zoomMeetingIdFromUrl,
  zoomSummaryText,
} from '../notes/callNotes';

const ZOOM_VTT = `WEBVTT

1
00:00:01.120 --> 00:00:04.560
Alex Kim: Thanks for making the time today.

2
00:00:05.000 --> 00:00:09.240
Maya Chen: Of course. Happy to talk about the payments team.

3
00:00:09.300 --> 00:00:12.000
Maya Chen: We are hiring two new grads in March.

4
00:00:12.500 --> 00:00:15.000
Alex Kim: That is great to hear.
`;

describe('parseVtt', () => {
  it('reads Zoom cues with their speakers and start times', () => {
    const lines = parseVtt(ZOOM_VTT);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toEqual({ speaker: 'Alex Kim', text: 'Thanks for making the time today.', start: 1.12 });
    expect(lines[2]!.speaker).toBe('Maya Chen');
  });

  it('reads voice tags, CRLF, a BOM, NOTE blocks and cues with no speaker', () => {
    const vtt =
      '﻿WEBVTT\r\n\r\nNOTE made by a test\r\n\r\n00:01.000 --> 00:02.000\r\n<v Maya Chen>Hello <b>there</b> &amp; welcome\r\n\r\n00:03.000 --> 00:04.000\r\njust words, no name\r\n';
    expect(parseVtt(vtt)).toEqual([
      { speaker: 'Maya Chen', text: 'Hello there & welcome', start: 1 },
      { speaker: undefined, text: 'just words, no name', start: 3 },
    ]);
  });

  it('does not take a time or a number as a speaker', () => {
    const lines = parseVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n10: 30 is when we start\n');
    expect(lines[0]!.speaker).toBeUndefined();
  });

  it('is empty for nothing', () => {
    expect(parseVtt(undefined)).toEqual([]);
    expect(parseVtt('WEBVTT\n')).toEqual([]);
  });
});

describe('transcriptText', () => {
  it('joins a speaker’s cues in a row into one turn', () => {
    expect(vttToText(ZOOM_VTT)).toBe(
      [
        'Alex Kim: Thanks for making the time today.',
        'Maya Chen: Of course. Happy to talk about the payments team. We are hiring two new grads in March.',
        'Alex Kim: That is great to hear.',
      ].join('\n'),
    );
  });

  it('stops at the limit and says so', () => {
    const text = transcriptText(
      Array.from({ length: 50 }, (_, i) => ({ speaker: i % 2 ? 'A' : 'B', text: 'word '.repeat(20) })),
      500,
    );
    expect(text.length).toBeLessThan(600);
    expect(text).toMatch(/The rest of the transcript is longer than Orbit keeps\.\)$/);
  });
});

describe('join links', () => {
  it('knows Zoom and Meet links and nothing else', () => {
    expect(callAppOfUrl('https://us02web.zoom.us/j/85012345678?pwd=abc')).toBe('zoom');
    expect(callAppOfUrl('https://zoom.us/my/maya')).toBe('zoom');
    expect(callAppOfUrl('https://meet.google.com/abc-defg-hij')).toBe('google_meet');
    expect(callAppOfUrl('https://teams.microsoft.com/l/meetup-join/x')).toBeUndefined();
    expect(callAppOfUrl('https://evilzoom.us/j/85012345678')).toBeUndefined();
    expect(callAppOfUrl('not a url')).toBeUndefined();
    expect(callAppOfUrl(undefined)).toBeUndefined();
  });

  it('reads the Zoom meeting id', () => {
    expect(zoomMeetingIdFromUrl('https://us02web.zoom.us/j/85012345678?pwd=abc')).toBe('85012345678');
    expect(zoomMeetingIdFromUrl('https://zoom.us/w/850123456?tk=x')).toBe('850123456');
    expect(zoomMeetingIdFromUrl('https://acme.zoom.us/wc/join/85012345678')).toBe('85012345678');
    expect(zoomMeetingIdFromUrl('https://zoom.us/my/maya')).toBeUndefined();
    expect(zoomMeetingIdFromUrl('https://meet.google.com/abc-defg-hij')).toBeUndefined();
  });

  it('reads the Meet code', () => {
    expect(meetCodeFromUrl('https://meet.google.com/abc-defg-hij?authuser=0')).toBe('abc-defg-hij');
    expect(meetCodeFromUrl('https://meet.google.com/ABC-DEFG-HIJ')).toBe('abc-defg-hij');
    expect(meetCodeFromUrl('https://meet.google.com/lookup/xyz')).toBeUndefined();
    expect(meetCodeFromUrl('https://zoom.us/j/85012345678')).toBeUndefined();
  });
});

describe('matchCallToEvent', () => {
  const ev = {
    id: 'ev1',
    startAt: '2026-11-10T15:00:00.000Z',
    endAt: '2026-11-10T15:30:00.000Z',
    attendees: [{ name: 'Maya Chen', email: 'maya@stripe.com' }],
  };
  const rec = (joinId: string | undefined, startAt: string, topic = 'Meeting') => ({
    joinId,
    startAt,
    topic,
  });

  it('takes the recording with the event’s own Zoom meeting id', () => {
    const got = matchCallToEvent(
      [rec('11111111111', '2026-11-10T15:01:00Z'), rec('85012345678', '2026-11-10T15:04:00Z')],
      { ...ev, conferenceUrl: 'https://zoom.us/j/85012345678' },
      'zoom',
    );
    expect(got?.joinId).toBe('85012345678');
  });

  it('never takes another meeting when the link has an id, nor the same id on another day', () => {
    const withLink = { ...ev, conferenceUrl: 'https://zoom.us/j/85012345678' };
    expect(matchCallToEvent([rec('11111111111', '2026-11-10T15:00:00Z')], withLink, 'zoom')).toBeUndefined();
    expect(matchCallToEvent([rec('85012345678', '2026-11-03T15:00:00Z')], withLink, 'zoom')).toBeUndefined();
  });

  it('matches a Meet code', () => {
    const got = matchCallToEvent(
      [rec('abc-defg-hij', '2026-11-10T14:58:00Z')],
      { ...ev, conferenceUrl: 'https://meet.google.com/abc-defg-hij' },
      'google_meet',
    );
    expect(got?.joinId).toBe('abc-defg-hij');
  });

  it('without an id, takes the one in the time window that names someone on the invite', () => {
    const got = matchCallToEvent(
      [
        rec('1', '2026-11-10T15:00:00Z', 'Team standup'),
        rec('2', '2026-11-10T15:10:00Z', 'Coffee with Maya'),
        rec('3', '2026-11-10T19:00:00Z', 'Maya again, much later'),
      ],
      { ...ev, conferenceUrl: 'https://zoom.us/my/alex' },
      'zoom',
    );
    expect(got?.joinId).toBe('2');
  });

  it('without an id or a name, takes the closest in time, and nothing outside the window', () => {
    expect(
      matchCallToEvent([rec('1', '2026-11-10T15:20:00Z'), rec('2', '2026-11-10T15:02:00Z')], ev, 'zoom')
        ?.joinId,
    ).toBe('2');
    expect(matchCallToEvent([rec('1', '2026-11-10T17:00:00Z')], ev, 'zoom')).toBeUndefined();
  });
});

describe('Meet transcript entries', () => {
  it('are speaker-labelled, in time order, with unknown people as Someone', () => {
    const text = meetEntriesToText(
      [
        { participant: 'p/2', text: 'Glad to help.', startTime: '2026-11-10T15:00:05Z' },
        { participant: 'p/1', text: 'Thanks for the time.', startTime: '2026-11-10T15:00:01Z' },
        { participant: 'p/9', text: 'Hi all.', startTime: '2026-11-10T15:00:09Z' },
        { participant: 'p/1', text: '  ', startTime: '2026-11-10T15:00:10Z' },
      ],
      { 'p/1': 'Alex Kim', 'p/2': 'Maya Chen' },
    );
    expect(text).toBe('Alex Kim: Thanks for the time.\nMaya Chen: Glad to help.\nSomeone: Hi all.');
  });

  it('names each kind of participant', () => {
    expect(meetParticipantName({ signedinUser: { displayName: 'Maya Chen' } })).toBe('Maya Chen');
    expect(meetParticipantName({ anonymousUser: { displayName: 'Guest' } })).toBe('Guest');
    expect(meetParticipantName({ phoneUser: { displayName: '+1 555' } })).toBe('+1 555');
    expect(meetParticipantName({})).toBeUndefined();
  });
});

describe('zoomSummaryText', () => {
  it('reads the overview, the details and the next steps', () => {
    expect(
      zoomSummaryText({
        summary_overview: 'Alex and Maya talked about the payments team.',
        summary_details: [{ label: 'Hiring', summary: 'Two new grads in March.' }],
        next_steps: ['Alex sends his resume'],
      }),
    ).toBe(
      'Alex and Maya talked about the payments team.\n\nHiring: Two new grads in March.\n\nNext steps:\n- Alex sends his resume',
    );
  });

  it('prefers the newer summary_content, and is undefined for an empty answer', () => {
    expect(zoomSummaryText({ summary_content: '## Summary\nGood talk.', summary_overview: 'x' })).toBe(
      '## Summary\nGood talk.',
    );
    expect(zoomSummaryText({})).toBeUndefined();
    expect(zoomSummaryText(undefined)).toBeUndefined();
  });
});

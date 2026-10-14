import type { TieHistory, TieMessage } from '../../scoring/tieScore';

/** Synthetic touch histories for the tie-score anchors (plan 16 §3.7), relative to `now`. */

const DAY = 86_400_000;
const HOUR = 3_600_000;

export const empty = (extra: Partial<TieHistory> = {}): TieHistory => ({
  name: 'Sam',
  messages: [],
  meetings: [],
  intros: 0,
  shared: { sameSchool: false, overlappingEmployer: false, sameCity: false },
  linkedinConnected: false,
  noteWarmth: [],
  mutualScores: [],
  ...extra,
});

export const at = (now: Date, daysAgo: number, hoursLater = 0) =>
  new Date(now.getTime() - daysAgo * DAY + hoursLater * HOUR).toISOString();

export const msg = (
  now: Date,
  daysAgo: number,
  direction: 'in' | 'out',
  threadId: string,
  extra: Partial<TieMessage> = {},
): TieMessage => ({
  at: at(now, daysAgo),
  direction,
  channel: 'email',
  threadParticipants: 2,
  threadId,
  automated: false,
  ...extra,
});

/** A4: weekly two-way email for six months (they answer within about five hours), three 1:1s, last contact 3 days ago. */
function a4(now: Date, shiftDays: number): TieHistory {
  const messages: TieMessage[] = [];
  for (let w = 0; w < 26; w++) {
    const d = shiftDays + 3 + 7 * w;
    messages.push(msg(now, d + 0.2, 'out', `t${w}`));
    messages.push(msg(now, d, 'in', `t${w}`, { isReplyLatencyHours: 4.8 }));
  }
  return empty({
    messages,
    meetings: [30, 90, 150].map((d) => ({ at: at(now, shiftDays + d), attendees: 2 })),
  });
}

export interface Anchor {
  id: string;
  history: (now: Date) => TieHistory;
  /** inclusive score range */
  range: [number, number];
}

export const ANCHORS: Anchor[] = [
  {
    id: 'A1',
    history: (now) => empty({ linkedinConnected: true, connectedAt: at(now, 300) }),
    range: [8, 15],
  },
  { id: 'A2', history: (now) => empty({ messages: [msg(now, 10, 'out', 'cold')] }), range: [3, 10] },
  {
    id: 'A3',
    history: (now) =>
      empty({
        messages: [
          msg(now, 14.5, 'out', 't'),
          msg(now, 14.25, 'in', 't', { isReplyLatencyHours: 6 }),
          msg(now, 14, 'out', 't'),
        ],
      }),
    range: [30, 45],
  },
  { id: 'A4', history: (now) => a4(now, 0), range: [85, 95] },
  { id: 'A5', history: (now) => a4(now, 730), range: [35, 55] },
  {
    id: 'A6',
    history: (now) =>
      empty({ messages: Array.from({ length: 10 }, (_, i) => msg(now, 5 + 18 * i, 'out', `cold${i}`)) }),
    range: [0, 20],
  },
  {
    id: 'A7',
    history: (now) =>
      empty({
        meetings: [{ at: at(now, 30), attendees: 2 }],
        messages: [msg(now, 29.8, 'out', 'thx'), msg(now, 29.5, 'in', 'thx', { isReplyLatencyHours: 7 })],
      }),
    range: [45, 60],
  },
  {
    id: 'A8',
    history: (now) =>
      empty({
        linkedinConnected: true,
        connectedAt: at(now, 400),
        shared: {
          sameSchool: true,
          overlappingEmployer: false,
          sameCity: false,
          school: 'Cornell University',
        },
      }),
    range: [15, 25],
  },
];

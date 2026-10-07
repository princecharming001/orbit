import { describe, expect, it } from 'vitest';
import { possibleIntroduction, readIntroduction } from '../pipeline/introductions';
import type { EmailMessage } from '../types';
import { ROSTER, ROSTER_PEOPLE, STUDENT_EMAIL } from './fixtures/intro-corpus';

const address = (k: string) => (k === 'me' ? STUDENT_EMAIL : ROSTER[k]!.email);

function msg(from: string, to: string[], cc: string[], subject: string, body: string): EmailMessage {
  return {
    id: `m_${from}`,
    userId: 'u',
    threadId: 't',
    externalMessageId: 'x',
    direction: from === 'me' ? 'outbound' : 'inbound',
    fromEmail: address(from),
    fromPersonId: from === 'me' ? undefined : from,
    toEmails: to.map(address),
    ccEmails: cc.map(address),
    subject,
    bodyText: body,
    sentAt: '2026-10-05T16:00:00Z',
    headers: {},
    isAutomated: false,
  };
}

const read = (m: EmailMessage) =>
  readIntroduction(m, ROSTER_PEOPLE, [STUDENT_EMAIL], { studentNames: ['Alex', 'Alex Rivera'] });

/** Soft introductions with none of the introducing cues: the reader leaves them, the fallback asks. */
const SOFT = [
  msg(
    'lena',
    ['me'],
    ['sam'],
    'Sam at Contoso',
    'Hi Alex,\n\nSam spent the last few years as an analytics lead at Contoso and mentors students on the side. Worth a conversation before your applications go in.\n\nLena',
  ),
  msg(
    'priya',
    ['me'],
    ['ana'],
    'Fraud',
    'Alex, Ana ran the fraud models team at Stripe for three years. She is generous with students and knows the interview loop well.\n\nPriya',
  ),
  msg(
    'kofi',
    ['me'],
    ['marcus'],
    'Rates desk',
    'Hi Alex, Marcus led the rates desk at Goldman until this spring. Worth a conversation if you are serious about trading.\n\nKofi',
  ),
];

describe('the fallback question: "Did Lena introduce you to Sam?"', () => {
  it('asks about a soft introduction the cues leave, naming the sender and the new person', () => {
    for (const m of SOFT) {
      const r = read(m);
      expect(r.kind, m.bodyText).toBe('none');
      const q = possibleIntroduction(m, r, { senderKnown: true });
      expect(q, m.bodyText).toMatchObject({
        introducerId: m.fromPersonId,
        personIds: [ROSTER_PEOPLE.find((p) => p.emails.includes(m.ccEmails[0]!))!.id],
        messageId: m.id,
        at: m.sentAt,
      });
      expect(q!.score).toBeGreaterThanOrEqual(4);
    }
  });

  it('never asks when the sender is not someone the student knows, or the person is not new', () => {
    const m = SOFT[0]!;
    const r = read(m);
    expect(possibleIntroduction(m, r, { senderKnown: false })).toBeUndefined();
    expect(possibleIntroduction(m, r, { senderKnown: true, knownIds: ['sam'] })).toBeUndefined();
  });

  it('never asks about an introduction, a reply inside one, or the student’s own mail', () => {
    const intro = msg(
      'lena',
      ['me'],
      ['sam'],
      'Intro',
      'Alex, meet Sam. Sam runs analytics at Contoso.\n\nLena',
    );
    const ri = read(intro);
    expect(ri.kind).toBe('introduction');
    expect(possibleIntroduction(intro, ri, { senderKnown: true })).toBeUndefined();
    const reply = msg(
      'sam',
      ['me'],
      ['lena'],
      'Re: Intro',
      'Thanks for the intro, Lena! Alex, Tuesday at 2pm?',
    );
    const rr = read(reply);
    expect(rr.kind).toBe('intro_reply');
    expect(possibleIntroduction(reply, rr, { senderKnown: true })).toBeUndefined();
    const own = msg(
      'me',
      ['sam'],
      ['lena'],
      'Analytics',
      'Sam ran analytics at Contoso, worth a conversation.',
    );
    expect(possibleIntroduction(own, read(own), { senderKnown: true })).toBeUndefined();
  });

  it('stays quiet on ordinary group threads: logistics, shared work, an offer for later, a copy for the paperwork', () => {
    const ordinary = [
      msg(
        'lena',
        ['me'],
        ['sam'],
        'Club budget',
        'Sam signed off on the club budget. You can order the shirts.\n\nLena',
      ),
      msg(
        'ines',
        ['me'],
        ['kai'],
        'Your first week',
        'Kai will be your onboarding buddy for the first two weeks.\n\nInes',
      ),
      msg(
        'tom',
        ['me', 'nadia'],
        [],
        'Practice case',
        'Nadia, can you run the practice case with Alex on Thursday?',
      ),
      msg(
        'olu',
        ['me'],
        ['chris'],
        'Offer',
        "Congrats on the offer! I've cc'd Chris from our HR team for the paperwork.",
      ),
      msg(
        'lena',
        ['me'],
        ['tom'],
        'McKinsey',
        'Would you like me to introduce you to someone at McKinsey? Tom and I were just talking about who might be a good fit.',
      ),
      msg(
        'priya',
        ['me'],
        ['ana'],
        'Offsite',
        'Ana and I are running the offsite on Thursday. The agenda is attached.',
      ),
      msg(
        'mark',
        ['me'],
        ['will'],
        'Portfolio',
        'Will looked at your portfolio over lunch. He liked the case study.',
      ),
    ];
    for (const m of ordinary) {
      const r = read(m);
      expect(r.kind, m.bodyText).toBe('none');
      expect(possibleIntroduction(m, r, { senderKnown: true }), m.bodyText).toBeUndefined();
    }
  });

  it('explains its evidence', () => {
    const r = read(SOFT[0]!);
    const sam = r.possible.find((p) => p.personId === 'sam')!;
    expect(sam.cues).toEqual(
      expect.arrayContaining([
        '+1 named',
        '+1 a new thread',
        '+1 says who they are',
        '+1 someone to talk to',
      ]),
    );
  });
});

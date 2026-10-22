import { describe, expect, it } from 'vitest';
import {
  applyStyleChange,
  COACH_TYPES,
  type CoachMessage,
  type CoachType,
  coachSample,
  coachTypeOf,
  messageContent,
  revertStyleChange,
  reviewMessage,
  reviewOutreach,
} from '../drafts/coach';
import { LINKEDIN_NOTE_TARGET } from '../drafts/templates';
import { defaultStyleCard } from '../style/card';

const NOW = new Date('2026-10-22T14:00:00Z');
const USER = {
  firstName: 'Alex',
  lastName: 'Rivera',
  fullName: 'Alex Rivera',
  school: 'Cornell University',
  gradYear: 2028,
  majors: ['Computer Science'],
  cycleLabel: 'Summer 2027 internship',
  targetFunctions: ['product'],
  timezone: 'America/New_York',
};
const sampleOf = (type: CoachType, card = defaultStyleCard('warm', 'Alex')) =>
  coachSample(type, { user: USER, styleCard: card, now: NOW });
const msg = (type: CoachType, body: string, over: Partial<CoachMessage> = {}): CoachMessage => ({
  id: Math.random().toString(36).slice(2),
  type,
  body,
  ...over,
});
const ids = (m: CoachMessage) => reviewMessage(m).map((h) => h.id);

const GOOD_COLD = `Hi Sarah,

I'm a junior at Cornell studying CS, and I saw your post on how Notion rebuilt onboarding for new teams. The part about cutting setup to one screen changed how I think about our club's app.

Would you have 15 minutes in the next couple of weeks to tell me how you ended up in product there?

Thanks,
Alex`;

describe('coach types', () => {
  it('maps sent messages to the kind of outreach', () => {
    expect(coachTypeOf({ kind: 'outreach', channel: 'gmail', body: 'x' })).toBe('cold_email');
    expect(coachTypeOf({ kind: 'first_touch', channel: 'gmail', body: 'x' })).toBe('cold_email');
    expect(coachTypeOf({ kind: 'outreach', channel: 'linkedin', body: 'short note' })).toBe('linkedin_note');
    expect(coachTypeOf({ kind: 'outreach', channel: 'linkedin', body: 'x'.repeat(400) })).toBe(
      'linkedin_message',
    );
    expect(
      coachTypeOf({ kind: 'outreach', channel: 'linkedin', body: 'short', handoffVia: 'linkedin_compose' }),
    ).toBe('linkedin_message');
    expect(coachTypeOf({ kind: 'reply', channel: 'gmail', body: 'x' })).toBe('reply');
    expect(coachTypeOf({ kind: 'schedule', channel: 'linkedin', body: 'x' })).toBe('reply');
    expect(coachTypeOf({ kind: 'bump', channel: 'gmail', body: 'x' })).toBe('follow_up');
    expect(coachTypeOf({ kind: 'thank_you', channel: 'gmail', body: 'x' })).toBeUndefined();
  });
  it('covers five kinds', () => {
    expect(COACH_TYPES.map((t) => t.id)).toEqual([
      'cold_email',
      'linkedin_note',
      'linkedin_message',
      'reply',
      'follow_up',
    ]);
  });
});

describe('the sample message', () => {
  it('is written by the draft engine for every kind, to Sarah Chen at Notion', () => {
    for (const t of COACH_TYPES) {
      const s = sampleOf(t.id);
      expect(s.body).toMatch(/Sarah/);
      expect(s.body).not.toMatch(/\[|\]/);
    }
    expect(sampleOf('cold_email').subject).toBeTruthy();
    expect(sampleOf('linkedin_note').chars).toBeLessThanOrEqual(LINKEDIN_NOTE_TARGET);
    expect(sampleOf('reply').body).toMatch(/\d(am|pm)\b/);
    expect(sampleOf('follow_up').body).toMatch(/note|following up/i);
  });
  it('follows the card: greeting, sign-off, contractions and never-say', () => {
    const card = {
      ...defaultStyleCard('warm', 'Alex'),
      greetingPatterns: ['Hey {first},'],
      signoffs: ['Cheers,\nAlex'],
      contractions: false,
      custom: true,
    };
    const s = sampleOf('cold_email', card);
    expect(s.body.startsWith('Hey Sarah,')).toBe(true);
    expect(s.body).toMatch(/Cheers,\nAlex$/);
    expect(s.body).not.toMatch(/I'm/);
  });
  it('the engine sample passes its own review on the hard rules', () => {
    for (const t of COACH_TYPES) {
      const r = reviewOutreach(t.id, [], sampleOf(t.id));
      expect(r.basis).toBe('sample');
      const hard = r.findings.filter((f) => f.severity === 'high').map((f) => f.id);
      expect(hard, t.id).toEqual([]);
    }
  });
});

describe('messageContent', () => {
  it('drops the greeting and the sign-off block', () => {
    expect(messageContent('Hi Sarah,\n\nOne line here.\n\nThanks,\nAlex')).toBe('One line here.');
    expect(messageContent('Hi Sarah, one line here. Thanks, Alex')).toBe('one line here.');
  });
});

describe('the review of one message', () => {
  it('a good cold email has nothing to fix', () => {
    expect(ids(msg('cold_email', GOOD_COLD, { subject: "Cornell '28, your onboarding post" }))).toEqual([]);
  });
  it('flags a long cold email and offers a length fix', () => {
    const long = `Hi Sarah,\n\n${'I saw your post on onboarding and it was great to read. '.repeat(16)}Would you have 15 minutes?\n\nBest,\nAlex`;
    const h = reviewMessage(msg('cold_email', long, { subject: 'Your onboarding post' })).find(
      (x) => x.id === 'too_long',
    )!;
    expect(h).toBeTruthy();
    expect(h.fix?.change).toEqual({ kind: 'length', words: 80 });
  });
  it('flags a LinkedIn note over 200 characters and a DM over 300', () => {
    const note = `Hi Sarah, I saw your post on onboarding at Notion. ${'It really stuck with me. '.repeat(8)}Could we talk for 15 minutes?`;
    expect(ids(msg('linkedin_note', note))).toContain('too_long');
    const dm = `Hi Sarah, thanks for connecting. I saw your post on onboarding. ${'It really stuck with me and I keep thinking about it. '.repeat(6)}Would you have 15 minutes?\n\nThanks,\nAlex`;
    expect(ids(msg('linkedin_message', dm))).toContain('too_long');
  });
  it('quotes the throwaway opener and offers to never say it', () => {
    const body = `Hi Sarah,\n\nI hope this email finds you well. I saw your post on onboarding.\n\nWould you have 15 minutes next week?\n\nBest,\nAlex`;
    const h = reviewMessage(msg('cold_email', body, { subject: 'Your onboarding post' })).find(
      (x) => x.id === 'throwaway_opener',
    )!;
    expect(h.quote).toBe('I hope this email finds you well.');
    expect(h.severity).toBe('high');
    expect(h.fix?.change).toEqual({ kind: 'avoid', phrase: 'I hope this email finds you well' });
    const name = `Hi Sarah,\n\nMy name is Alex and I am a junior at Cornell. I saw your post.\n\nWould you have 15 minutes?\n\nBest,\nAlex`;
    expect(ids(msg('cold_email', name, { subject: 'Your post' }))).toContain('throwaway_opener');
  });
  it('flags no reason to write to this person', () => {
    const body = `Hi Sarah,\n\nI am a junior at Cornell interested in product management.\n\nWould you have 15 minutes to chat?\n\nBest,\nAlex`;
    expect(ids(msg('cold_email', body, { subject: 'Cornell junior' }))).toContain('no_specific_reason');
  });
  it('flags a vague ask, a big ask, a missing ask and several asks', () => {
    const vague = `Hi Sarah,\n\nI saw your post on onboarding. I would love to pick your brain about product.\n\nBest,\nAlex`;
    const v = reviewMessage(msg('cold_email', vague, { subject: 'Your post' })).find(
      (x) => x.id === 'vague_ask',
    )!;
    expect(v.quote).toBe('I would love to pick your brain about product.');
    expect(v.fix?.change).toEqual({ kind: 'avoid', phrase: 'pick your brain' });
    const big = `Hi Sarah,\n\nI saw your post on onboarding. Could you refer me for the PM internship?\n\nBest,\nAlex`;
    expect(ids(msg('cold_email', big, { subject: 'Your post' }))).toContain('big_ask');
    const none = `Hi Sarah,\n\nI saw your post on onboarding and really enjoyed it. I am a junior at Cornell.\n\nBest,\nAlex`;
    expect(ids(msg('cold_email', none, { subject: 'Your post' }))).toContain('no_ask');
    const many = `Hi Sarah,\n\nI saw your post on onboarding. How did you get into PM? What does your day look like? Would you have 15 minutes?\n\nBest,\nAlex`;
    expect(ids(msg('cold_email', many, { subject: 'Your post' }))).toContain('many_asks');
  });
  it('flags a generic, long or missing subject', () => {
    expect(ids(msg('cold_email', GOOD_COLD, { subject: 'Networking request' }))).toContain('subject');
    expect(ids(msg('cold_email', GOOD_COLD, { subject: 'Quick question' }))).toContain('subject');
    expect(
      ids(
        msg('cold_email', GOOD_COLD, {
          subject: 'Cornell junior interested in product management hoping to learn about your path',
        }),
      ),
    ).toContain('subject');
    expect(ids(msg('cold_email', GOOD_COLD))).toContain('subject');
  });
  it('flags a message all about me', () => {
    const body = `Hi Sarah,\n\nI saw your post. I am a junior at Cornell. I study CS and I lead my club. I built my own app. I am applying to PM roles and I want my first job to be in product. Would you have 15 minutes?\n\nBest,\nAlex`;
    expect(ids(msg('cold_email', body, { subject: 'Your post' }))).toContain('about_me');
  });
  it('flags links and attachments in a first message, not in a reply', () => {
    const body = `Hi Sarah,\n\nI saw your post on onboarding. I've attached my resume. Would you have 15 minutes?\n\nBest,\nAlex`;
    expect(ids(msg('cold_email', body, { subject: 'Your post' }))).toContain('link_in_first');
    const reply = `Hi Sarah,\n\nThank you! Here is my link: https://cal.com/alex. Does Tuesday at 2pm work?\n\nBest,\nAlex`;
    expect(ids(msg('reply', reply))).not.toContain('link_in_first');
  });
  it('flags follow-ups that come too soon or sound like a debt', () => {
    const body = `Hi Sarah,\n\nI haven't heard back, so following up on my note. Would you have 15 minutes?\n\nBest,\nAlex`;
    const hits = ids(msg('follow_up', body, { gapDays: 2 }));
    expect(hits).toContain('too_soon');
    expect(hits).toContain('guilt_bump');
    expect(
      ids(msg('follow_up', body.replace("I haven't heard back, so following", 'Following'), { gapDays: 7 })),
    ).toEqual([]);
  });
  it('flags a reply with no next step and too many exclamation marks', () => {
    const body = `Hi Sarah,\n\nThank you so much! That is amazing! I really appreciate it!\n\nBest,\nAlex`;
    const hits = ids(msg('reply', body));
    expect(hits).toContain('no_next_step');
    expect(hits).toContain('exclamations');
  });
});

describe('the review of a kind of outreach', () => {
  it('counts sent and replied, aggregates findings with the worst example, and notices missing follow-ups', () => {
    const opener = `Hi Sarah,\n\nI hope you are doing well. I saw your post on onboarding.\n\nWould you have 15 minutes?\n\nBest,\nAlex`;
    const sent = [
      msg('cold_email', opener, { subject: 'Your post', replied: true, ageDays: 20 }),
      msg('cold_email', opener, { subject: 'Your post', ageDays: 14 }),
      msg('cold_email', opener, { subject: 'Your post', ageDays: 10 }),
      msg('follow_up', 'Hi Sarah,\n\nIn case it got buried. Would you have 15 minutes?\n\nBest,\nAlex'),
    ];
    const r = reviewOutreach('cold_email', sent);
    expect(r.basis).toBe('sent');
    expect(r.sent).toBe(3);
    expect(r.replied).toBe(1);
    expect(r.replyRate).toBeCloseTo(1 / 3);
    const opening = r.findings.find((f) => f.id === 'throwaway_opener')!;
    expect(opening.count).toBe(3);
    expect(opening.quote).toBe('I hope you are doing well.');
    expect(r.findings.find((f) => f.id === 'no_follow_up')?.count).toBe(2);
    expect(r.findings[0]!.severity).toBe('high');
  });
  it('reviews the sample when nothing of that kind was sent', () => {
    const r = reviewOutreach('linkedin_note', [], { body: 'Hi Sarah, I hope you are doing well! Alex' });
    expect(r.basis).toBe('sample');
    expect(r.sent).toBe(0);
    expect(r.replyRate).toBeUndefined();
    expect(r.findings.map((f) => f.id)).toContain('throwaway_opener');
  });
});

describe('style changes', () => {
  const card = { ...defaultStyleCard('warm', 'Alex'), avgMessageWords: 60 };
  it('says what changed and what it was', () => {
    expect(applyStyleChange(card, { kind: 'length', words: 40 }, 'Alex')).toEqual({
      patch: { avgMessageWords: 40 },
      summary: 'about 40 words, was 60',
    });
    expect(
      applyStyleChange(card, { kind: 'formality', value: 0.8, contractions: false }, 'Alex')?.summary,
    ).toBe('tone formal, was friendly; contractions off');
    expect(applyStyleChange(card, { kind: 'greeting', pattern: 'Hey {first},' }, 'Alex')?.summary).toBe(
      'greeting "Hey Sarah,", was "Hi Sarah,"',
    );
    expect(applyStyleChange(card, { kind: 'signoff', word: 'Cheers' }, 'Alex')?.patch.signoffs?.[0]).toBe(
      'Cheers,\nAlex',
    );
    expect(applyStyleChange(card, { kind: 'exclamations', on: false }, 'Alex')?.patch).toEqual({
      exclamationsPerMessage: 0,
    });
  });
  it('does nothing when the card already says so', () => {
    expect(applyStyleChange(card, { kind: 'length', words: 60 }, 'Alex')).toBeUndefined();
    const withAvoid = { ...card, avoid: ['pick your brain'] };
    expect(applyStyleChange(withAvoid, { kind: 'avoid', phrase: 'Pick your brain' }, 'Alex')).toBeUndefined();
  });
  it('undoing a list change removes only that item', () => {
    const a = applyStyleChange(card, { kind: 'avoid', phrase: 'circle back' }, 'Alex')!;
    const after = { ...card, ...a.patch, avoid: [...(a.patch.avoid ?? []), 'synergy'] };
    expect(revertStyleChange(after, { kind: 'avoid', phrase: 'circle back' }, {}).avoid).toEqual(['synergy']);
    const n = applyStyleChange(card, { kind: 'note', text: 'One ask per message.' }, 'Alex')!;
    const noted = { ...card, ...n.patch };
    expect(noted.notes).toBe('Warm preset.\nOne ask per message.');
    expect(revertStyleChange(noted, { kind: 'note', text: 'One ask per message.' }, {}).notes).toBe(
      'Warm preset.',
    );
  });
});

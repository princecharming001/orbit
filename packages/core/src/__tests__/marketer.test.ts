/**
 * Who is selling to the student. Strict on purpose: someone real who asks for a call is never a marketer.
 */
import { describe, expect, it } from 'vitest';
import { marketerVerdict } from '../text/marketer';

const one = (text: string) => marketerVerdict([{ text }]);

describe('people who are selling', () => {
  it.each([
    [
      'an agency pitch on LinkedIn',
      'Hi Anish, thanks for connecting! We help SaaS founders book 20+ qualified meetings a month with done-for-you outbound. Worth a quick chat this week?',
    ],
    [
      'a dev shop',
      'Hello, I came across your profile. Our team of developers specializes in building MVPs for startups. Would love to show you our portfolio, do you have 15 minutes?',
    ],
    [
      'a tool with a free trial',
      'Our platform helps teams automate their reporting. You can start a free trial today, and pricing starts at $29.',
    ],
    [
      'who-handles-this plus a demo',
      'Are you the right person to speak with about recruiting software? I can book a demo for your team whenever suits.',
    ],
    [
      'a discount blast',
      'Black Friday special offer: 40% off all annual plans until Sunday. Use discount code ORBIT40.',
    ],
    [
      'saw your website, here is my service',
      'I was looking at your website and noticed a few things that could improve your conversion rate. We offer SEO services and link building for early companies.',
    ],
  ])('%s', (_what, text) => {
    const v = one(text);
    expect(v.marketer).toBe(true);
    expect(v.reasons.length).toBeGreaterThan(0);
    expect(v.reasons.join(' ')).not.toMatch(/[!—]/);
  });

  it('a mailing tool header settles it alone', () => {
    expect(marketerVerdict([{ text: 'Our November update is here.', unsubscribe: true }])).toEqual({
      marketer: true,
      reasons: ['Sent by a mailing tool'],
    });
  });

  it('one sign of selling, then a second message into silence', () => {
    const first = 'Hi, we help founders with their bookkeeping. Let me know if useful.';
    expect(one(first).marketer).toBe(false);
    expect(
      marketerVerdict([{ text: first }, { text: 'Hi again, any thoughts on the below?' }]).marketer,
    ).toBe(true);
  });
});

describe('people who are not', () => {
  it.each([
    [
      'an investor asking for a call',
      'Hey Anish, loved the demo day pitch. Would you have 15 minutes for a quick call next week? Here is my calendly.com/jane-vc link.',
    ],
    [
      'a recruiter',
      'Hi, I lead university recruiting at Stripe and came across your profile. Are you open to hearing more about our new grad roles?',
    ],
    [
      'a classmate',
      'yo are you going to the hackathon this weekend? we should team up, hop on a call tonight?',
    ],
    [
      'an alum offering help',
      'Happy to chat about my path into product. I have 20 minutes on Thursday if that works.',
    ],
    [
      'a founder asking for feedback',
      'We are building a tool for students and I would love to show you what we have. No pitch, just want your take.',
    ],
    ['a thank-you', 'Great meeting you at the mixer. Let me know if I can ever help with intros.'],
    [
      'an event invite from a friend',
      'We are hosting a dinner for founders on Friday, you should come. Limited seats so tell me soon.',
    ],
    ['nothing at all', ''],
  ])('%s', (_what, text) => {
    expect(one(text)).toEqual({ marketer: false, reasons: [] });
  });

  it('a real person who wrote twice with no reply is still a person', () => {
    expect(
      marketerVerdict([
        {
          text: 'Hi, I am a sophomore at Cal and saw you built Orbit. Could I ask you two questions about it?',
        },
        { text: 'Just following up in case this got buried. No worries if you are busy.' },
      ]).marketer,
    ).toBe(false);
  });

  it('no messages, no verdict', () => {
    expect(marketerVerdict([])).toEqual({ marketer: false, reasons: [] });
  });
});

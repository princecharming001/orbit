import { describe, expect, it } from 'vitest';
import { scoreDiscoverCandidate } from '../recommend/discover';
import {
  agoOf,
  dayOf,
  monthOf,
  mutualsLine,
  subjectLine,
  WHY_MAX,
  type WhyReason,
  type WhySignals,
  whyCard,
  whyFromReasons,
  whySummary,
  whyThem,
} from '../recommend/why';

const now = new Date('2026-10-06T10:00:00');
const texts = (s: Omit<WhySignals, 'now'>) => whyThem({ ...s, now }).map((x) => x.text);
const first = (s: Omit<WhySignals, 'now'>) => whyThem({ ...s, now })[0]!;

/** No em dash, no exclamation mark, no guessing words, no "undefined", every line a sentence. */
function wellWritten(rs: WhyReason[], summary?: string) {
  for (const t of [...rs.map((r) => r.text), ...(summary ? [summary] : [])]) {
    expect(t).not.toMatch(/—|!|\bmay\b|\bprobably\b|\bundefined\b|\bNaN\b|\bnull\b|\s,|\.\./);
    expect(t).toMatch(/^[A-Z0-9“]/);
    expect(t).toMatch(/[.…”]$/);
  }
}

describe('dates and small words', () => {
  it('names a month, with the year once it is more than eleven months back', () => {
    expect(monthOf('2026-09-01T12:00:00', now)).toBe('September');
    expect(monthOf('2025-11-01T12:00:00', now)).toBe('November');
    expect(monthOf('2025-10-01T12:00:00', now)).toBe('October 2025');
    expect(monthOf('not a date', now)).toBeUndefined();
  });

  it('names a day the same way, and how long ago in the unit a person would use', () => {
    expect(dayOf('2026-05-12T15:00:00', now)).toBe('May 12');
    expect(dayOf('2025-05-12T15:00:00', now)).toBe('May 12, 2025');
    expect(dayOf(undefined, now)).toBeUndefined();
    expect(agoOf('2026-10-03T10:00:00', now)).toBe('3 days ago');
    expect(agoOf('2026-09-01T10:00:00', now)).toBe('5 weeks ago');
    expect(agoOf('2026-05-12T10:00:00', now)).toBe('4 months ago');
    expect(agoOf('2025-08-01T10:00:00', now)).toBe('over a year ago');
    expect(agoOf('2023-08-01T10:00:00', now)).toBe('3 years ago');
  });

  it('shows a subject line short, without Re: or Fwd:, in quotes', () => {
    expect(subjectLine('Re: RE: Fwd: Coffee next week?')).toBe('“Coffee next week?”');
    expect(subjectLine('  ')).toBeUndefined();
    const long = subjectLine(
      'Cornell CS junior, a question about your post on idempotent payment retries and the API layer',
    )!;
    expect(long.length).toBeLessThanOrEqual(66);
    expect(long).toMatch(/^“Cornell CS junior, a question about your post on idempotent…”$/);
  });

  it('names the people you both know, as LinkedIn-style lists', () => {
    expect(mutualsLine(['Nitin'])).toBe('You both know Nitin');
    expect(mutualsLine(['Nitin', 'Ana', 'Lee', 'Sam', 'Max'])).toBe(
      'You both know Nitin, Ana, Lee and 2 others',
    );
  });
});

describe('each reason says something specific and true', () => {
  it('a role at a target company: the role, the company, where it is on the list, and the field', () => {
    const r = first({
      firstName: 'Maya',
      title: 'Product Manager',
      company: 'Stripe',
      since: '2023-03-01',
      goal: {
        company: { name: 'Stripe', priority: 1 },
        role: { title: 'Product Manager', function: 'product management' },
      },
    });
    expect(r.text).toBe(
      'Product Manager at Stripe since March 2023. Stripe is one of your top target companies, and this is the product management work you are aiming for.',
    );
    expect(r.clause).toBe('is a Product Manager at Stripe, one of your top target companies');
    expect(r.anchor).toBe('goal');
    // a second priority is "on your target list"; no start date, no "since"
    expect(first({ goal: { company: { name: 'Ramp', priority: 2 }, role: { title: 'Analyst' } } }).text).toBe(
      'Analyst at Ramp. Ramp is on your target list, and this is the kind of role you are aiming for.',
    );
  });

  it('a company on the list without the role, an alum in the field, the role in an industry on the list', () => {
    expect(texts({ title: 'Product Designer', goal: { company: { name: 'Stripe', priority: 1 } } })[0]).toBe(
      'Works at Stripe as a Product Designer. Stripe is one of your top target companies.',
    );
    const alum = whyThem({
      company: 'Acme',
      goal: { role: { title: 'Product Manager', function: 'product management' } },
      school: { name: 'UC Berkeley', gradYear: 2021, myGradYear: 2027, degree: 'BS' },
      now,
    });
    expect(alum[0]).toMatchObject({
      text: 'Went to UC Berkeley, like you, and is now a Product Manager at Acme, the product management work you are aiming for.',
      clause: 'is a fellow UC Berkeley alum, now a Product Manager at Acme',
      anchor: 'goal',
    });
    // the school's own line adds the class year without saying the school again as news
    expect(alum[1]!.text).toBe('Graduated from UC Berkeley (BS, class of 2021), 6 years ahead of you.');
    expect(alum.some((x) => /^Also went to/.test(x.text))).toBe(false);
    expect(
      first({ company: 'Plaid', goal: { role: { title: 'Product Manager' }, industry: 'Fintech' } }).text,
    ).toBe('Works as a Product Manager at Plaid, in fintech, one of the industries on your list.');
    // an acronym keeps its capitals
    expect(texts({ company: 'Scale', goal: { industry: 'AI' } })[0]).toBe(
      'Works in AI at Scale, one of the industries on your list.',
    );
    expect(texts({ company: 'Figma', goal: { role: { title: 'Software Engineer' } } })[0]).toBe(
      'Works as a Software Engineer at Figma, the kind of role you are aiming for.',
    );
  });

  it('the school: degree, major and year when known, and nothing more when not', () => {
    expect(
      texts({
        school: {
          name: 'UC Berkeley',
          degree: 'B.S.',
          program: 'Computer Science',
          gradYear: 2021,
        },
      })[0],
    ).toBe(
      'Also went to UC Berkeley (B.S. Computer Science, class of 2021), the same school and major as you.',
    );
    expect(texts({ school: { name: 'Cornell', gradYear: 2024, myGradYear: 2026 } })[0]).toBe(
      'Also went to Cornell (class of 2024), 2 years ahead of you.',
    );
    expect(texts({ school: { name: 'Cornell', gradYear: 2025, myGradYear: 2026 } })[0]).toBe(
      'Also went to Cornell (class of 2025), 1 year ahead of you.',
    );
    expect(texts({ school: { name: 'Cornell', gradYear: 2026, myGradYear: 2026 } })[0]).toBe(
      'Also went to Cornell (class of 2026), the same class year as you.',
    );
    expect(texts({ school: { name: 'Cornell' } })[0]).toBe('Also went to Cornell.');
  });

  it('people you both know: full names, how one of them knows this person, and a count from LinkedIn', () => {
    const one = whyThem({
      firstName: 'Amara',
      mutuals: {
        people: [
          {
            id: 'p1',
            name: 'Priya Shah',
            firstName: 'Priya',
            how: 'works with Amara at Stripe (since 2022)',
          },
        ],
      },
      now,
    });
    expect(one[0]).toMatchObject({
      kind: 'mutuals',
      text: 'Knows Priya Shah, whom you know well. Priya works with Amara at Stripe (since 2022).',
      clause: 'knows Priya, whom you know well',
      people: [{ id: 'p1', name: 'Priya Shah' }],
      anchor: 'tie',
    });
    const many = whyThem({
      mutuals: {
        people: ['Priya Shah', 'Sam Lee', 'Ana Ruiz', 'Lee Wong', 'Max Bauer'].map((name, i) => ({
          id: `m${i}`,
          name,
          firstName: name.split(' ')[0]!,
        })),
      },
      now,
    })[0]!;
    expect(many.text).toBe('Knows 5 people you know well, including Priya Shah, Sam Lee and Ana Ruiz.');
    expect(many.clause).toBe('knows 5 people you know well, including Priya and Sam');
    expect(many.people).toHaveLength(3);
    const two = first({ mutuals: { names: ['Nitin', 'Ana'] } });
    expect(two.text).toBe('Knows Nitin and Ana, both people you know well.');
    expect(two.clause).toBe('knows Nitin and Ana, two people you know well');
    // a count is not a reason to meet a stranger; people the student knows by name are
    const count = first({ mutuals: { count: 12 }, headline: 'PM at Ramp' });
    expect(count.text).toBe('LinkedIn shows 12 mutual connections between you.');
    expect(count.anchor).toBeUndefined();
    expect(count.clause).toBeUndefined();
    expect(first({ mutuals: { count: 1 } }).text).toBe('LinkedIn shows 1 mutual connection between you.');
    expect(whyThem({ mutuals: { names: ['A', 'B', 'C'] }, now })[0]!.strength).toBeGreaterThan(
      whyThem({ mutuals: { count: 40 }, now })[0]!.strength,
    );
  });

  it('who could introduce you: their full name and how they know this person, said once', () => {
    const r = whyThem({
      firstName: 'Amara',
      warmPath: {
        name: 'Lena',
        id: 'p9',
        fullName: 'Lena Novak',
        how: 'worked with Amara at Ramp (2021 to 2023)',
      },
      mutuals: {
        people: [
          {
            id: 'p9',
            name: 'Lena Novak',
            firstName: 'Lena',
            how: 'worked with Amara at Ramp (2021 to 2023)',
          },
          { id: 'p3', name: 'Rhea Iyer', firstName: 'Rhea' },
        ],
      },
      now,
    });
    expect(r.find((x) => x.kind === 'warm_path')).toMatchObject({
      text: 'Lena Novak, who worked with Amara at Ramp (2021 to 2023), could introduce you.',
      clause: 'is one introduction away through Lena',
      people: [{ id: 'p9', name: 'Lena Novak' }],
    });
    // the people line names both, but does not tell Lena's story twice
    expect(r.find((x) => x.kind === 'mutuals')!.text).toBe(
      'Knows Lena Novak and Rhea Iyer, both people you know well.',
    );
    expect(texts({ warmPath: { name: 'Ana' } })[0]).toBe(
      'Ana is your warmest way in and could introduce you.',
    );
    // the one person you both know is the introducer: one line
    const solo = texts({ warmPath: { name: 'Chaya' }, mutuals: { names: ['Chaya'] } });
    expect(solo.filter((t) => t.includes('Chaya'))).toHaveLength(1);
  });

  it('a friend at their company, by full name and linked', () => {
    expect(first({ colleague: { name: 'Sana Sato', company: 'Figma', id: 'p4' } })).toMatchObject({
      text: 'Sana Sato, whom you know well, also works at Figma and could introduce you.',
      clause: 'can be introduced by Sana, a colleague of theirs whom you know well',
      people: [{ id: 'p4', name: 'Sana Sato' }],
    });
  });

  it('what passed between you: dates, who wrote last, how many messages, the subject, never a body', () => {
    // they wrote first and the student has not answered
    const wrote = first({
      history: {
        theyWroteAt: '2026-05-12T15:00:00',
        talk: {
          fromThem: 1,
          fromYou: 0,
          channel: 'email',
          firstAt: '2026-05-12T15:00:00',
          lastAt: '2026-05-12T15:00:00',
          lastFrom: 'them',
          subject: 'Re: Your summer internship search',
        },
      },
    });
    expect(wrote.text).toBe(
      'Wrote to you by email on May 12 about “Your summer internship search”; you have not replied yet.',
    );
    expect(wrote.clause).toBe('wrote to you in May');
    expect(wrote.anchor).toBe('tie');
    // a conversation of three or more messages: how many, since when, and whose was last
    const talked = first({
      history: {
        repliedAt: '2026-09-22T09:00:00',
        talk: {
          fromThem: 2,
          fromYou: 1,
          channel: 'email',
          firstAt: '2026-09-02T09:00:00',
          lastAt: '2026-09-22T09:00:00',
          lastFrom: 'them',
          subject: 'Coffee chat follow up',
        },
      },
    });
    expect(talked.text).toBe(
      'You have written to each other three times by email since September about “Coffee chat follow up”; the last was their reply on September 22.',
    );
    // a recent reply waiting on the student is a reason to write now
    expect(talked.timely).toBe(true);
    // a single reply, with nothing more on record: only what is known
    expect(texts({ history: { repliedAt: '2025-03-12T10:00:00' } })[0]).toBe(
      'Replied to your message on March 12, 2025.',
    );
    expect(texts({ history: { metAt: '2026-06-02T10:00:00', meetings: 2 } })[0]).toBe(
      'You met on June 2, the last of 2 meetings with them, 4 months ago.',
    );
    expect(texts({ history: { metAt: '2026-06-02T10:00:00' } })[0]).toBe('You met on June 2, 4 months ago.');
    expect(
      texts({
        history: {
          wroteAt: '2026-09-02T10:00:00',
          talk: { fromThem: 0, fromYou: 2, channel: 'LinkedIn', lastFrom: 'you' },
        },
      })[0],
    ).toBe(
      'You messaged them on LinkedIn on September 2 (2 messages in all) and have not heard back; that was 4 weeks ago.',
    );
    expect(texts({ history: { connectedOn: '2024-05-02' } })[0]).toBe(
      'Connected with you on LinkedIn since May 2024, though you have not written to each other.',
    );
    // knowing each other a little: what is on record, never a bare claim when something is
    expect(
      texts({
        history: {
          knownALittle: true,
          touches: ['you were both on 3 email threads', 'they commented on 2 of your LinkedIn posts'],
          lastTouchAt: '2026-08-14T10:00:00',
        },
      })[0],
    ).toBe(
      'You already know each other a little: you were both on 3 email threads and they commented on 2 of your LinkedIn posts, most recently in August.',
    );
    expect(texts({ history: { knownALittle: true } })[0]).toBe(
      'You already know each other a little, from what Orbit has on record.',
    );
  });

  it('never quotes a message body: a line about a conversation holds at most its subject', () => {
    const body = 'Hi Alex, so glad you reached out. My cell is 555 0100 and I am free Tuesday.';
    const r = whyThem({
      history: {
        theyWroteAt: '2026-09-12T10:00:00',
        talk: { fromThem: 1, fromYou: 0, lastFrom: 'them', subject: 'Hello' },
      },
      now,
    });
    const all = r.map((x) => `${x.text} ${x.clause ?? ''}`).join(' ');
    for (const w of ['glad', '555', 'Tuesday']) expect(all).not.toContain(w);
    expect(all).not.toContain(body.slice(0, 20));
  });

  it('an employer on both résumés: their title and years, and when the student was there', () => {
    expect(
      texts({
        pastEmployers: [
          {
            name: 'Brex',
            mine: 'interned',
            theirs: 'before',
            theirTitle: 'Software Engineer',
            theirYears: '2019 to 2021',
            myYears: '2025',
          },
        ],
      })[0],
    ).toBe('Also worked at Brex (Software Engineer, 2019 to 2021), where you interned in 2025.');
    expect(
      texts({ pastEmployers: [{ name: 'Ramp', mine: 'interned', theirs: 'now', theirTitle: 'Analyst' }] })[0],
    ).toBe('Works at Ramp as an Analyst, where you interned.');
    expect(
      texts({
        firstName: 'Maya',
        pastEmployers: [{ name: 'Cornell AppDev', mine: 'now', theirs: 'now', theirTitle: 'Product Lead' }],
      })[0],
    ).toBe('You both work at Cornell AppDev; Maya is a Product Lead there.');
    expect(texts({ pastEmployers: [{ name: 'Goldman Sachs', mine: 'worked', theirs: 'before' }] })[0]).toBe(
      'Also worked at Goldman Sachs, where you worked.',
    );
  });

  it('the city: why it matters to the student', () => {
    expect(texts({ city: { name: 'New York', why: 'target' } })[0]).toBe(
      'Based in New York, one of the places you want to work.',
    );
    expect(texts({ city: { name: 'Ithaca', why: 'current' } })[0]).toBe(
      'Based in Ithaca, where you live now.',
    );
    expect(texts({ city: { name: 'Austin', why: 'home' } })[0]).toBe('Based in Austin, where you are from.');
  });

  it('a new role: a promotion, a move, the same switch the student is making, or a plain start', () => {
    const promoted = first({
      roleChange: {
        monthsAgo: 7,
        company: 'Stripe',
        title: 'Senior Product Manager',
        at: '2026-03-02T00:00:00',
        promoted: true,
        fromTitle: 'Product Manager',
      },
    });
    expect(promoted.text).toBe(
      'Was promoted to Senior Product Manager at Stripe in March, from Product Manager: a good moment to congratulate them and reconnect.',
    );
    expect(promoted.timely).toBe(true);
    expect(
      texts({
        roleChange: {
          monthsAgo: 3,
          company: 'Ramp',
          title: 'Product Manager',
          moved: true,
          at: '2026-07-01T00:00:00',
          fromCompany: 'McKinsey',
          sameSwitch: { from: 'consulting', to: 'product management' },
        },
      })[0],
    ).toBe(
      'Moved from consulting at McKinsey to product management at Ramp in July, the same switch you are trying to make.',
    );
    expect(
      texts({ roleChange: { monthsAgo: 3, company: 'Ramp', moved: true, fromCompany: 'Plaid' } })[0],
    ).toBe('Moved from Plaid to Ramp 3 months ago: a good moment to congratulate them.');
    expect(texts({ roleChange: { monthsAgo: 0 } })[0]).toBe('Started their current role this month.');
    // a year or more in the role is not a change worth a line
    expect(whyThem({ roleChange: { monthsAgo: 14 }, now }).some((x) => x.kind === 'role_change')).toBe(false);
  });

  it('says honestly when little is known, and never invents a line', () => {
    expect(whyThem({ now })).toEqual([{ kind: 'thin', text: 'Not much known about them yet.', strength: 0 }]);
    expect(texts({ headline: 'Engineer at Stripe' })).toEqual(['Only their LinkedIn headline so far.']);
    expect(texts({ title: 'Engineer', company: 'Stripe' })).toEqual(['Only their title and company so far.']);
    expect(texts({ school: { name: 'Cornell' } })).toEqual([
      'Also went to Cornell.',
      "That's all Orbit knows about them so far.",
    ]);
    // a field the account does not have is a line the card does not get, and a detail it does not have is left out
    const r = whyThem({ goal: { company: { name: 'Ramp' } }, school: { name: 'NYU' }, now });
    expect(r.map((x) => x.kind)).toEqual(['goal', 'school']);
    expect(r[0]!.text).toBe('Works at Ramp. Ramp is on your target list.');
    expect(r.some((x) => /mutual|introduce|replied|wrote|since|class of/i.test(x.text))).toBe(false);
  });

  it('orders the reasons by strength as before: the goal first, then who you both know, then the rest', () => {
    const r = whyThem({
      firstName: 'Maya',
      title: 'Product Manager',
      company: 'Google',
      goal: { company: { name: 'Google', priority: 1 }, role: { title: 'Product Manager', function: 'pm' } },
      mutuals: { names: ['Nitin', 'Ana'] },
      school: { name: 'Cornell' },
      city: { name: 'San Francisco', why: 'target' },
      roleChange: { monthsAgo: 2 },
      now,
    });
    expect(r.map((x) => x.kind)).toEqual(['goal', 'mutuals', 'school', 'role_change']);
    expect(r.map((x) => x.strength)).toEqual([100, 90, 70, 50]);
    expect(r.length).toBe(WHY_MAX);
    expect(r.some((x) => x.kind === 'thin')).toBe(false);
    wellWritten(r, whySummary(r, 'Maya'));
  });
});

describe('the summary: why this person, now, in one sentence', () => {
  const maya = whyThem({
    firstName: 'Maya',
    title: 'Software Engineer',
    company: 'Stripe',
    goal: { company: { name: 'Stripe', priority: 1 }, role: { title: 'Software Engineer' } },
    history: {
      repliedAt: '2026-09-22T09:00:00',
      talk: { fromThem: 1, fromYou: 1, channel: 'email', lastFrom: 'them', lastAt: '2026-09-22T09:00:00' },
    },
    school: { name: 'Cornell', gradYear: 2022, myGradYear: 2027 },
    city: { name: 'New York', why: 'target' },
    now,
  });

  it('leads with the strongest reason and joins the next one about them in particular', () => {
    const card = whyCard(maya, 'Maya');
    expect(card.summary).toBe(
      'Worth writing to now because Maya is a Software Engineer at Stripe, one of your top target companies, and replied to you in September.',
    );
    // the goal line is said in full by the summary; the reply keeps its own line for its dates
    expect(card.bullets.map((b) => b.kind)).toEqual(['history', 'school', 'city']);
    expect(card.bullets[0]!.text).toBe(
      'Replied to your email on September 22; you have not written back since.',
    );
    wellWritten(maya, card.summary);
  });

  it('prefers a reason to write now (a reply waiting on the student) over a stronger one that can wait', () => {
    const r = whyThem({
      firstName: 'Hannah',
      company: 'Figma',
      goal: { company: { name: 'Figma', priority: 1 }, role: { title: 'Product Manager' } },
      mutuals: { names: ['Zara', 'Priya', 'Mateo'] },
      history: {
        repliedAt: '2026-10-05T09:00:00',
        talk: {
          fromThem: 1,
          fromYou: 1,
          channel: 'email',
          lastFrom: 'them',
          subject: 'Your move from design to PM',
        },
      },
      now,
    });
    expect(r.map((x) => x.kind)).toEqual(['goal', 'mutuals', 'history']);
    const card = whyCard(r, 'Hannah');
    expect(card.summary).toBe(
      'Worth writing to now because Hannah is a Product Manager at Figma, one of your top target companies, and replied to you in October.',
    );
    expect(card.bullets.map((b) => b.text)).toEqual([
      'Knows Zara, Priya and Mateo, all three people you know well.',
      'Replied to your email on October 5 about “Your move from design to PM”; you have not written back since.',
    ]);
  });

  it('says what they do first, even when a way in leads', () => {
    const r = whyThem({
      firstName: 'Marcus',
      title: 'Product Designer',
      company: 'Ramp',
      goal: { company: { name: 'Ramp', priority: 2 } },
      warmPath: { name: 'Lena', fullName: 'Lena Novak', id: 'p9' },
      now,
    });
    expect(r[0]!.kind).toBe('warm_path');
    const card = whyCard(r, 'Marcus');
    expect(card.summary).toBe(
      'Worth writing to because Marcus works at Ramp, a company on your target list, and is one introduction away through Lena.',
    );
    // the introducer's line stays, with their full name to link
    expect(card.bullets[0]!.text).toBe('Lena Novak is your warmest way in and could introduce you.');
  });

  it('never joins a line that is true of thousands, and leaves a long second part to its own line', () => {
    const r = whyThem({
      firstName: 'Ana',
      goal: { company: { name: 'Figma', priority: 1 } },
      mutuals: { count: 30 },
      history: { connectedOn: '2024-01-01' },
      city: { name: 'New York', why: 'target' },
      now,
    });
    expect(whySummary(r, 'Ana')).toBe(
      'Worth writing to because Ana works at Figma, one of your top target companies.',
    );
    const long = whyThem({
      firstName: 'Bartholomew',
      company: 'Goldman Sachs Asset Management International',
      goal: {
        company: { name: 'Goldman Sachs Asset Management International', priority: 1 },
        role: { title: 'Vice President of Quantitative Investment Strategies' },
      },
      mutuals: {
        people: ['Alexandria Montgomery', 'Maximilian Featherstonehaugh', 'Christopher Abernathy', 'Dee'].map(
          (name, i) => ({ id: `m${i}`, name, firstName: name.split(' ')[0]! }),
        ),
      },
      now,
    });
    const s = whySummary(long, 'Bartholomew')!;
    expect(s.length).toBeLessThanOrEqual(230);
    expect(s).not.toContain('Alexandria');
  });

  it('has no summary when the lead is no reason on its own, and every line then shows', () => {
    const r = whyFromReasons([{ code: 'search', text: 'Product Manager in Fintech' }], {
      headline: 'Product at Plaid',
    });
    const card = whyCard(r, 'Jo');
    expect(card.summary).toBeUndefined();
    expect(card.bullets).toEqual(r);
    expect(whySummary([], 'Jo')).toBeUndefined();
  });

  it('falls back to "this person" without a first name, never an empty name', () => {
    expect(whySummary(whyThem({ goal: { company: { name: 'Ramp' } }, now }))).toBe(
      'Worth writing to because this person works at Ramp, a company on your target list.',
    );
  });
});

describe('a new person from a search: the same block, from the reasons the scorer wrote', () => {
  it("joins a role and a target company into one line, and keeps the scorer's sentences", () => {
    const r = whyFromReasons(
      [
        { code: 'mutuals', text: 'LinkedIn shows 4 mutual connections between you.' },
        {
          code: 'target_company',
          text: 'Works at Stripe. Stripe is one of your top target companies.',
          clause: 'works at Stripe, one of your top target companies',
          detail: 'one of your top target companies',
        },
        {
          code: 'function_match',
          text: 'Works as a Software Engineer at Stripe, the kind of role you are aiming for.',
        },
        { code: 'location', text: 'Based in New York, one of the places you want to work.' },
        { code: 'search', text: 'Cornell alumni at Stripe' },
      ],
      { title: 'Software Engineer', company: 'Stripe', headline: 'SWE at Stripe', mutualCount: 4 },
    );
    expect(r.map((x) => x.text)).toEqual([
      'Software Engineer at Stripe. Stripe is one of your top target companies, and this is the kind of role you are aiming for.',
      'Based in New York, one of the places you want to work.',
      'LinkedIn shows 4 mutual connections between you.',
      'Found by the search for Cornell alumni at Stripe.',
    ]);
    expect(r[0]).toMatchObject({
      anchor: 'goal',
      clause: 'is a Software Engineer at Stripe, one of your top target companies',
    });
    const plain = whyFromReasons(
      [
        { code: 'target_company', text: 'Works at Stripe. Stripe is on your target list.' },
        { code: 'search', text: 'Cornell alumni at Stripe' },
      ],
      { company: 'Stripe' },
      { filler: false },
    );
    expect(plain.map((x) => x.text)).toEqual(['Works at Stripe. Stripe is on your target list.']);
    const thin = whyFromReasons([{ code: 'search', text: 'Product Manager in Fintech' }], {
      headline: 'Product at Plaid',
    });
    expect(thin.map((x) => x.kind)).toEqual(['search', 'thin']);
    expect(thin[1]!.text).toBe('Only their LinkedIn headline so far.');
  });

  it('writes full sentences with the specifics from what it scored, and links the friend who works there', () => {
    const profile = {
      school: 'Cornell University',
      targetTitles: ['Software Engineer'],
      targetFunctions: ['swe'],
      industries: ['Fintech'],
      locations: ['New York'],
      homeLocations: [],
      targetCompanies: [{ name: 'Stripe', key: 'stripe', priority: 1 as const }],
      pastOrgs: [],
      outreach: [{ name: 'Ethan', title: 'Software Engineer', company: 'Anthropic', replied: true }],
      dismissed: [],
    };
    const s = scoreDiscoverCandidate(
      {
        name: 'Victor Thornton',
        title: 'Senior Software Engineer',
        company: 'Stripe',
        location: 'New York, NY',
        distance: 2,
        mutualCount: 3,
        schoolEvidence: true,
        colleague: { firstName: 'Maya', name: 'Maya Chen', strength: 0.7 },
      },
      profile,
    );
    const why = whyFromReasons(
      s.reasons,
      {
        title: 'Senior Software Engineer',
        company: 'Stripe',
        mutualCount: 3,
        colleague: { id: 'p2', name: 'Maya Chen' },
      },
      { filler: false },
    );
    expect(why.map((w) => w.text)).toEqual([
      'Went to Cornell University, like you, and now works at Stripe, one of your top target companies.',
      'Maya Chen, whom you know well, also works at Stripe and could introduce you.',
      'Has the same kind of role as Ethan at Anthropic, who replied to you.',
      'Works as a Senior Software Engineer at Stripe, the kind of role you are aiming for.',
    ]);
    expect(why[1]!.people).toEqual([{ id: 'p2', name: 'Maya Chen' }]);
    const card = whyCard(why, 'Victor');
    expect(card.summary).toBe(
      'Worth writing to because Victor is a fellow Cornell University alum at Stripe, one of your top target companies, and can be introduced by Maya, a colleague of theirs whom you know well.',
    );
    wellWritten(why, card.summary);
  });
});

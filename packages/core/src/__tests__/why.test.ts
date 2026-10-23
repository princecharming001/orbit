import { describe, expect, it } from 'vitest';
import { monthOf, mutualsLine, WHY_MAX, whyFromReasons, whyThem } from '../recommend/why';

const now = new Date('2026-10-06T10:00:00Z');

describe('why someone is suggested', () => {
  it('orders the reasons by strength: the goal first, then who you both know, then the rest', () => {
    const r = whyThem({
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
    expect(r[0]!.text).toBe('Product Manager at Google, on your target list');
    expect(r[1]!.text).toBe('You both know Nitin and Ana');
    expect(r[2]!.text).toBe('Went to Cornell, like you');
    expect(r[3]!.text).toBe('New in the role, 2 months');
    // four at most, the weakest (the city) left out, and no honest line when there is plenty
    expect(r.length).toBe(WHY_MAX);
    expect(r.some((x) => x.kind === 'thin')).toBe(false);
  });

  it('names the people you both know, and only counts when LinkedIn gives no names', () => {
    expect(mutualsLine(['Nitin'])).toBe('You both know Nitin');
    expect(mutualsLine(['Nitin', 'Ana'])).toBe('You both know Nitin and Ana');
    expect(mutualsLine(['Nitin', 'Ana', 'Lee'])).toBe('You both know Nitin, Ana and Lee');
    expect(mutualsLine(['Nitin', 'Ana', 'Lee', 'Sam', 'Max'])).toBe(
      'You both know Nitin, Ana, Lee and 2 others',
    );
    const count = whyThem({ mutuals: { count: 12 }, headline: 'PM at Ramp', now });
    expect(count[0]!.text).toBe('12 mutual connections on LinkedIn');
    const named = whyThem({ mutuals: { names: ['Nitin'], count: 12 }, headline: 'PM at Ramp', now });
    expect(named[0]!.text).toBe('You both know Nitin');
    // three named friends outrank a count of many
    expect(whyThem({ mutuals: { names: ['A', 'B', 'C'] }, now })[0]!.strength).toBeGreaterThan(
      whyThem({ mutuals: { count: 40 }, now })[0]!.strength,
    );
  });

  it('says honestly when little is known, and never invents a line', () => {
    expect(whyThem({ now })).toEqual([{ kind: 'thin', text: 'Not much known about them yet', strength: 0 }]);
    expect(whyThem({ headline: 'Engineer at Stripe', now }).map((x) => x.text)).toEqual([
      'Only their LinkedIn headline so far',
    ]);
    expect(whyThem({ title: 'Engineer', company: 'Stripe', now }).map((x) => x.text)).toEqual([
      'Only their title and company so far',
    ]);
    // one real reason: the card still says that is all
    const one = whyThem({ school: { name: 'Cornell' }, now });
    expect(one.map((x) => x.text)).toEqual([
      'Went to Cornell, like you',
      "That's all Orbit knows about them so far",
    ]);
    // a field the account does not have is a line the card does not get
    const r = whyThem({ goal: { company: { name: 'Ramp' } }, school: { name: 'NYU' }, now });
    expect(r.map((x) => x.kind)).toEqual(['goal', 'school']);
    expect(r.some((x) => /mutual|introduce|replied|wrote/i.test(x.text))).toBe(false);
  });

  it('writes each kind from its data: school year and program, past employers, the city, a reply, a move', () => {
    const texts = (s: Parameters<typeof whyThem>[0]) => whyThem(s).map((x) => x.text);
    expect(texts({ school: { name: 'Cornell', gradYear: 2024, myGradYear: 2026 }, now })[0]).toBe(
      "Cornell '24, 2 years ahead of you",
    );
    expect(texts({ school: { name: 'Cornell', gradYear: 2026, myGradYear: 2026 }, now })[0]).toBe(
      "Cornell '26, your class year",
    );
    expect(texts({ school: { name: 'Cornell', program: 'Computer Science' }, now })[0]).toBe(
      'Also studied Computer Science at Cornell',
    );
    expect(
      texts({ pastEmployers: [{ name: 'Goldman Sachs', mine: 'interned', theirs: 'before' }], now })[0],
    ).toBe('Also was at Goldman Sachs, like you');
    expect(texts({ pastEmployers: [{ name: 'Ramp', mine: 'interned', theirs: 'now' }], now })[0]).toBe(
      'Works at Ramp, where you interned',
    );
    expect(texts({ pastEmployers: [{ name: 'Cornell AppDev', mine: 'now', theirs: 'now' }], now })[0]).toBe(
      "You're both at Cornell AppDev",
    );
    expect(texts({ city: { name: 'New York', why: 'target' }, now })[0]).toBe(
      'In New York, where you want to work',
    );
    expect(texts({ city: { name: 'Austin', why: 'home' }, now })[0]).toBe('Also in Austin');
    expect(texts({ history: { repliedAt: '2026-03-12T10:00:00Z' }, now })[0]).toBe('Replied to you in March');
    expect(texts({ history: { repliedAt: '2025-03-12T10:00:00Z' }, now })[0]).toBe(
      'Replied to you in March 2025',
    );
    expect(texts({ history: { metAt: '2026-06-02T10:00:00Z' }, now })[0]).toBe('You met in June');
    expect(texts({ history: { theyWroteAt: '2026-06-02T10:00:00Z' }, now })[0]).toBe('Wrote to you in June');
    expect(texts({ history: { wroteAt: '2026-09-02T10:00:00Z' }, now })[0]).toBe(
      'You wrote to them in September',
    );
    expect(texts({ history: { connectedOn: '2024-05-02' }, now })[0]).toBe(
      'Connected on LinkedIn since 2024',
    );
    expect(texts({ history: { knownALittle: true }, now })[0]).toBe('You already know each other a little');
    expect(texts({ warmPath: { name: 'Ana' }, now })[0]).toBe('Ana could introduce you');
    expect(texts({ roleChange: { monthsAgo: 0 }, now })[0]).toBe('New in the role, this month');
    expect(texts({ roleChange: { monthsAgo: 3, company: 'Ramp', moved: true }, now })[0]).toBe(
      'Moved to Ramp 3 months ago',
    );
    // a year or more in the role is not a change worth a line
    expect(whyThem({ roleChange: { monthsAgo: 14 }, now }).some((x) => x.kind === 'role_change')).toBe(false);
    expect(texts({ colleague: { name: 'Sana', company: 'Figma' }, now })[0]).toBe(
      'Sana, whom you know, works at Figma too',
    );
    expect(texts({ goal: { company: { name: 'Stripe', priority: 1 } }, now })[0]).toBe(
      'Works at Stripe, at the top of your target list',
    );
    expect(texts({ goal: { role: { title: 'Software Engineer' } }, company: 'Figma', now })[0]).toBe(
      "Software Engineer at Figma, a role you're targeting",
    );
    expect(texts({ goal: { industry: 'fintech' }, now })[0]).toBe(
      'Works in fintech, an industry on your list',
    );
  });

  it("turns the scorer's reasons for a new person into the same block, a role and a target company joined", () => {
    const r = whyFromReasons(
      [
        { code: 'mutuals', text: '4 mutual connections on LinkedIn' },
        { code: 'target_company', text: 'Works at Stripe, on your target list' },
        { code: 'function_match', text: 'Works in software engineering (Software Engineer)' },
        { code: 'location', text: 'Based in New York, where you want to work' },
        { code: 'search', text: 'Cornell alumni at Stripe' },
      ],
      { title: 'Software Engineer', company: 'Stripe', headline: 'SWE at Stripe', mutualCount: 4 },
    );
    expect(r.map((x) => x.text)).toEqual([
      'Software Engineer at Stripe, on your target list',
      '4 mutual connections on LinkedIn',
      'Based in New York, where you want to work',
      'Found by the search: Cornell alumni at Stripe',
    ]);
    // an alum at a target company: one line says both, the company and the school are not said again
    const alum = whyFromReasons(
      [
        { code: 'alumni_target', text: 'Cornell alum at Stripe, on your target list' },
        { code: 'alumni', text: 'Went to Cornell, like you' },
        { code: 'target_company', text: 'Works at Stripe, on your target list' },
        { code: 'function_match', text: 'Works in software engineering (Staff Engineer)' },
      ],
      { title: 'Staff Engineer', company: 'Stripe' },
    );
    expect(alum.map((x) => x.text)).toEqual([
      'Cornell alum at Stripe, on your target list',
      'Works in software engineering (Staff Engineer)',
    ]);
    // only the search behind them: the card says so
    const thin = whyFromReasons([{ code: 'search', text: 'Product Manager in Fintech' }], {
      headline: 'Product at Plaid',
    });
    expect(thin.map((x) => x.kind)).toEqual(['search', 'thin']);
    expect(thin[1]!.text).toBe('Only their LinkedIn headline so far');
  });

  it('names a month, with the year once it is more than eleven months back', () => {
    expect(monthOf('2026-09-01', now)).toBe('September');
    expect(monthOf('2025-11-01', now)).toBe('November');
    expect(monthOf('2025-10-01', now)).toBe('October 2025');
    expect(monthOf('not a date', now)).toBeUndefined();
  });
});

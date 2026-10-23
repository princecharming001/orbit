import { describe, expect, it } from 'vitest';
import {
  BLOCKED_SOURCE_DOMAINS,
  carefulAllowed,
  isBlockedSource,
  isLinkedInCopy,
  sensitiveCategory,
  stripSensitiveSentences,
} from '../../../../../supabase/functions/_shared/research/guards';
import {
  aboutCompany,
  cityOf,
  companyAliases,
  identityCard,
  mentionsOrg,
  scorePage,
} from '../../../../../supabase/functions/_shared/research/identity';
import { identitySet } from './identitySet';

const dana = identityCard({
  name: 'Dana Liu',
  org: 'Meta',
  title: 'Product Manager',
  linkedinUrl: 'https://www.linkedin.com/in/dana-liu-4b2',
  emails: ['dana@gmail.com', 'dliu@meta.com'],
  profile: {
    location: 'San Francisco Bay Area',
    publicIdentifier: 'dana-liu-4b2',
    experience: [
      { title: 'Product Manager', company: 'Meta', current: true },
      { title: 'Associate PM', company: 'Dropbox' },
      { title: 'Intern', company: 'Block' },
      { title: 'Camp counselor', company: 'YMCA' },
    ],
    education: [{ school: 'Stanford University' }, { school: 'Lincoln High School' }],
  },
});

describe('the identity card', () => {
  it('takes the current employer and two before it, schools (not high school), city, slug and work domain', () => {
    expect(dana.employers.map((e) => e.name)).toEqual(['Meta', 'Dropbox', 'Block']);
    expect(dana.employers[0]!.aliases).toEqual(
      expect.arrayContaining(['Meta', 'Facebook', 'Meta Platforms']),
    );
    expect(dana.schools.map((s) => s.name)).toEqual(['Stanford University']);
    expect(dana.schools[0]!.aliases).toContain('Stanford');
    expect(dana.city).toBe('San Francisco');
    expect(dana.slug).toBe('dana-liu-4b2');
    // a public mail provider proves nothing; the work domain does
    expect(dana.domains).toEqual(['meta.com']);
    expect(dana.anchored).toBe(true);
  });

  it('knows nicknames both ways, and is unanchored with a name alone', () => {
    const dan = identityCard({ name: 'Daniel Okafor' });
    expect(dan.names).toEqual(expect.arrayContaining(['daniel okafor', 'dan okafor', 'danny okafor']));
    expect(dan.anchored).toBe(false);
    expect(identityCard({ name: 'Daniel Okafor', org: 'Stripe' }).anchored).toBe(true);
  });

  it('reads the city out of a LinkedIn location', () => {
    expect(cityOf('Greater Seattle Area')).toBe('Seattle');
    expect(cityOf('London, England, United Kingdom')).toBe('London');
    expect(cityOf('')).toBeUndefined();
  });
});

describe('the company alias table and whole-word matching', () => {
  it('Meta counts as Facebook, AWS as Amazon, J.P. Morgan as JPMorgan Chase', () => {
    expect(mentionsOrg('She leads growth at Facebook.', companyAliases('Meta'))).toBe(true);
    expect(mentionsOrg('An engineer on AWS Lambda.', companyAliases('Amazon'))).toBe(true);
    expect(mentionsOrg('An associate at J.P. Morgan.', companyAliases('JPMorgan Chase'))).toBe(true);
    expect(mentionsOrg('Spent years at Square on payments.', companyAliases('Block'))).toBe(true);
  });

  it('"metadata" is not Meta, "a block of time" is not Block, a wheelchair ramp is not Ramp', () => {
    expect(mentionsOrg('Notes on metadata and meta-analysis.', companyAliases('Meta'))).toBe(false);
    expect(mentionsOrg('book a block of time', companyAliases('Block'))).toBe(false);
    expect(mentionsOrg('volunteers built a ramp', companyAliases('Ramp'))).toBe(false);
    expect(mentionsOrg('Six weeks in the amazon rainforest.', companyAliases('Amazon'))).toBe(false);
    // as written, the company still counts
    expect(mentionsOrg('Dana joined Ramp in 2024.', companyAliases('Ramp'))).toBe(true);
    // the company's product is not the company: a namesake who built on the Plaid API never worked there
    expect(mentionsOrg('Built with the Plaid API and Yodlee.', companyAliases('Plaid'))).toBe(false);
    expect(mentionsOrg('A Figma plugin for icons, hosted on Google Cloud.', companyAliases('Figma'))).toBe(
      false,
    );
    expect(mentionsOrg('A Figma plugin for icons, hosted on Google Cloud.', companyAliases('Google'))).toBe(
      false,
    );
    expect(
      mentionsOrg('Integrated Plaid, Yodlee, and Finicity for bank linking.', companyAliases('Plaid')),
    ).toBe(false);
    expect(mentionsOrg('A dashboard built on Stripe and hosted on Google.', companyAliases('Stripe'))).toBe(
      false,
    );
    expect(mentionsOrg('Senior engineer at Plaid; I also use the Plaid API.', companyAliases('Plaid'))).toBe(
      true,
    );
    expect(mentionsOrg('She joined Plaid in 2023.', companyAliases('Plaid'))).toBe(true);
    expect(mentionsOrg("Stripe's payments team", companyAliases('Stripe'))).toBe(true);
    // whole words only: "Stripes" is not Stripe, "Googleplex tour" is not Google
    expect(mentionsOrg('Stripes and plaids for fall', companyAliases('Stripe'))).toBe(false);
    expect(mentionsOrg('A Googleplex tour', companyAliases('Google'))).toBe(false);
  });
});

describe('scoring a page', () => {
  it('needs the name and a second signal; the name alone is weak', () => {
    expect(
      scorePage({ url: 'https://a.example/x', title: 'Dana Liu at Facebook', text: '' }, dana),
    ).toMatchObject({
      strength: 'strong',
      signals: expect.arrayContaining(['name', 'employer']),
    });
    expect(
      scorePage({ url: 'https://a.example/x', title: 'Dana Liu', text: 'Stanford alum' }, dana).strength,
    ).toBe('strong');
    expect(
      scorePage({ url: 'https://a.example/x', title: 'Dana Liu', text: 'loves hiking' }, dana).strength,
    ).toBe('weak');
    // the city alone never makes a match
    expect(
      scorePage({ url: 'https://a.example/x', title: 'Dana Liu', text: 'a teacher in San Francisco' }, dana)
        .strength,
    ).toBe('weak');
    expect(
      scorePage({ url: 'https://a.example/x', title: 'Someone else', text: 'Meta' }, dana).strength,
    ).toBe('none');
  });

  it('LinkedIn and its copies are never strong; blocked sites are blocked', () => {
    const li = scorePage(
      { url: 'https://www.linkedin.com/in/dana-liu-4b2', title: 'Dana Liu - PM - Meta | LinkedIn', text: '' },
      dana,
    );
    expect(li).toMatchObject({ strength: 'weak', linkedinCopy: true });
    expect(
      scorePage({ url: 'https://rocketreach.co/dana-liu', title: 'Dana Liu, Meta', text: '' }, dana).strength,
    ).toBe('weak');
    const spokeo = scorePage(
      { url: 'https://www.spokeo.com/Dana-Liu', title: 'Dana Liu, Meta', text: '' },
      dana,
    );
    expect(spokeo).toMatchObject({ strength: 'weak', blocked: true });
  });

  it('a title giving them an employer they never had is a conflict', () => {
    const s = scorePage(
      {
        url: 'https://x.example',
        title: 'Dana Liu - Partner at Granite Law Group',
        text: 'She once visited Stanford.',
      },
      dana,
    );
    expect(s.conflict).toBe('Granite Law Group');
    expect(s.strength).toBe('weak');
  });

  it('a link to their LinkedIn or their work email ties a page to them; an address shaped like the name does not', () => {
    // a site named after the name is anyone's with that name, until it says something only they would
    expect(
      scorePage({ url: 'https://danaliu.com/about', title: 'About', text: 'I am Dana Liu.' }, dana).strength,
    ).toBe('weak');
    expect(
      scorePage(
        { url: 'https://danaliu.com/about', title: 'About', text: 'I am Dana Liu, a PM at Meta.' },
        dana,
      ).strength,
    ).toBe('strong');
    expect(
      scorePage(
        {
          url: 'https://talks.example/x',
          title: 'Dana Liu',
          text: 'Find me at linkedin.com/in/dana-liu-4b2',
        },
        dana,
      ).signals,
    ).toContain('slug');
    expect(
      scorePage({ url: 'https://talks.example/x', title: 'Dana Liu', text: 'write to dliu@meta.com' }, dana)
        .strength,
    ).toBe('strong');
  });

  it('company pages need the company as a whole word, never a blocked or copied page', () => {
    expect(aboutCompany({ url: 'https://ramp.com/blog', title: 'Ramp raises', text: '' }, 'Ramp')).toBe(true);
    expect(aboutCompany({ url: 'https://x.example', title: 'a ramp for the porch', text: '' }, 'Ramp')).toBe(
      false,
    );
    expect(aboutCompany({ url: 'https://www.zoominfo.com/c/ramp', title: 'Ramp', text: '' }, 'Ramp')).toBe(
      false,
    );
  });
});

describe('the 50-person labelled set (15 common names)', () => {
  const people = identitySet();

  it('has 50 people sharing 15 names, each with right and wrong pages', () => {
    expect(people).toHaveLength(50);
    expect(new Set(people.map((p) => p.input.name)).size).toBe(15);
    for (const p of people) {
      expect(p.pages.some((x) => x.label === 'right')).toBe(true);
      expect(p.pages.some((x) => x.label === 'wrong')).toBe(true);
    }
  });

  it('at least 98% of the pages scored strong are about the right person, and most right pages are found', () => {
    let strong = 0;
    let strongRight = 0;
    let right = 0;
    let found = 0;
    const misses: string[] = [];
    for (const p of people) {
      const card = identityCard(p.input);
      for (const page of p.pages) {
        const s = scorePage(page, card);
        if (page.label === 'right') right++;
        if (s.strength !== 'strong') {
          if (page.label === 'right') misses.push(`${p.input.name} ${page.why}`);
          continue;
        }
        strong++;
        if (page.label === 'right') {
          strongRight++;
          found++;
        } else misses.push(`WRONG kept: ${p.input.name} ${page.why}`);
      }
    }
    const precision = strongRight / strong;
    const recall = found / right;
    console.log(
      `identity set: ${strong} strong pages, precision ${(precision * 100).toFixed(1)}%, recall ${(recall * 100).toFixed(1)}%`,
    );
    expect(precision).toBeGreaterThanOrEqual(0.98);
    expect(recall).toBeGreaterThanOrEqual(0.95);
    // the only wrong page kept is the namesake at the same employer, which one page cannot settle
    expect(misses.filter((m) => m.startsWith('WRONG'))).toEqual([
      'WRONG kept: Michael Chen a namesake at the same employer: the case research cannot settle from one page',
    ]);
  });

  it('no wrong page of a namesake, a copy, a blocked site or an everyday word is ever strong', () => {
    for (const p of people) {
      const card = identityCard(p.input);
      for (const page of p.pages.filter((x) => x.label === 'wrong' && !x.why.includes('same employer')))
        expect(scorePage(page, card).strength, `${p.input.name}: ${page.why}`).not.toBe('strong');
    }
  });
});

describe('guards: what research never reads or writes', () => {
  it('blocks people-search, property, donation, court, crowdfunding, obituary and personal social sites', () => {
    for (const url of [
      'https://www.spokeo.com/x',
      'https://www.zillow.com/homedetails/1',
      'https://www.fec.gov/data/receipts/?contributor_name=x',
      'https://www.opensecrets.org/donor-lookup',
      'https://www.courtlistener.com/opinion/1',
      'https://www.gofundme.com/f/x',
      'https://www.legacy.com/us/obituaries/x',
      'https://www.facebook.com/dana',
      'https://www.instagram.com/dana',
      'https://m.facebook.com/dana',
      'javascript:alert(1)',
    ])
      expect(isBlockedSource(url), url).toBe(true);
    for (const url of [
      'https://github.com/dana',
      'https://dana.substack.com/p/x',
      'https://www.youtube.com/watch?v=1',
    ])
      expect(isBlockedSource(url), url).toBe(false);
    expect(isLinkedInCopy('https://www.linkedin.com/in/x')).toBe(true);
    expect(isLinkedInCopy('https://www.zoominfo.com/p/x')).toBe(true);
    expect(BLOCKED_SOURCE_DOMAINS.length).toBeGreaterThan(40);
  });

  it('never writes home finer than a city, pay, personality, health, family, religion, politics or legal matters', () => {
    const never: [string, string][] = [
      ['She lives at 1200 Market Street.', 'home'],
      ["Dana's home address is on file.", 'home'],
      ['His salary is $180k a year.', 'pay'],
      ['Her total compensation tops the band.', 'pay'],
      ['An introvert who prefers email.', 'personality'],
      ['Her communication style is direct.', 'personality'],
      ['An INTJ who loves systems.', 'personality'],
      ['Diagnosed with cancer in 2020.', 'health'],
      ['Married with two kids.', 'family'],
      ['A devout Catholic.', 'religion'],
      ['She donated to the campaign of a senator.', 'politics'],
      ['He was sued by a former employer.', 'legal'],
      ['Arrested in 2019.', 'legal'],
      ['On her H-1B status: pending.', 'immigration'],
      ['She was laid off in March.', 'job_loss'],
    ];
    for (const [text, cat] of never) expect(sensitiveCategory(text), text).toBe(cat);
  });

  it('leaves a lawyer’s practice, a health company and a growth line alone', () => {
    for (const text of [
      'A litigation associate at Cooley.',
      'Builds tools for Oscar Health.',
      'Spent 5 years to drive growth at Ramp.',
      'Leads the Seattle office.',
    ])
      expect(sensitiveCategory(text), text).toBeUndefined();
    expect(stripSensitiveSentences('Leads design at Figma. Married with two kids.')).toBe(
      'Leads design at Figma.',
    );
  });

  it('"careful" is company context only', () => {
    expect(carefulAllowed('Ramp cut 10% of staff in September.')).toBe(true);
    expect(carefulAllowed('The team was reorganized last month.')).toBe(true);
    expect(carefulAllowed('She is going through a divorce.')).toBe(false);
    expect(carefulAllowed('He was sued last year.')).toBe(false);
    expect(carefulAllowed('Her personal life has been hard.')).toBe(false);
  });
});

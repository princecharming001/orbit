import { describe, expect, it } from 'vitest';
import { brokenNeverRules, neverDoChecks } from '../drafts/neverDo';
import { validateDraft } from '../drafts/validate';
import {
  answeredCount,
  cleanAnswer,
  currentJobLabel,
  OWN_WORDS_QUESTIONS,
  ownWordsLines,
  parseCurrentJob,
} from '../ownWords';
import { buildDiscoverProfile, discoverQueries, scoreDiscoverCandidate } from '../recommend/discover';
import { parseWantToMeet, wantFit } from '../recommend/wantToMeet';

describe('the student own words (plan 24)', () => {
  it('keeps an answer trimmed and short, and nothing written as nothing', () => {
    expect(cleanAnswer('  Product roles.  \n\n\n\nBecause.  ')).toBe('Product roles.\n\nBecause.');
    expect(cleanAnswer('   ')).toBeUndefined();
    expect(cleanAnswer(42)).toBeUndefined();
    expect(cleanAnswer('x'.repeat(900))).toHaveLength(600);
  });

  it('tells a job link from the words around it', () => {
    expect(parseCurrentJob('Stripe, PM intern https://jobs.lever.co/stripe/123')).toEqual({
      url: 'https://jobs.lever.co/stripe/123',
      text: 'Stripe, PM intern',
    });
    expect(parseCurrentJob('www.figma.com/careers/456.')).toEqual({
      url: 'https://www.figma.com/careers/456',
    });
    expect(parseCurrentJob('Evercore, summer analyst')).toEqual({ text: 'Evercore, summer analyst' });
    expect(parseCurrentJob('  ')).toBeUndefined();
    expect(parseCurrentJob('javascript:alert(1)')).toEqual({ text: 'javascript:alert(1)' });
    expect(currentJobLabel({ url: 'https://boards.greenhouse.io/figma/jobs/123' })).toBe(
      'boards.greenhouse.io/figma/jobs',
    );
  });

  it('counts the answers and says them back with the never rule first', () => {
    const g = { aim: 'PM at fintechs', neverDo: 'Never mention my GPA.', currentJob: { text: 'Stripe' } };
    expect(answeredCount(g)).toBe(3);
    expect(ownWordsLines(g)).toEqual([
      'Never (their own rule, always follow it): Never mention my GPA.',
      'Going for: PM at fintechs',
      'Going for this job now: Stripe',
    ]);
    expect(ownWordsLines({})).toEqual([]);
  });

  it('asks every question in plain words, without dashes', () => {
    for (const q of Object.values(OWN_WORDS_QUESTIONS))
      for (const t of [q.label, q.placeholder, q.uses]) expect(t).not.toMatch(/[—–]/);
  });
});

describe('the never rules', () => {
  it('checks what a message can visibly break', () => {
    const rules = 'Never mention my GPA. No exclamation marks; never say "circle back", and no emojis.';
    expect(neverDoChecks(rules).length).toBeGreaterThanOrEqual(4);
    expect(brokenNeverRules('Hi Maya, my GPA is 3.9.', rules)).toEqual(['Never mention my GPA']);
    expect(brokenNeverRules('Hi Maya! Thanks.', rules)).toEqual(['No exclamation marks']);
    expect(brokenNeverRules('Happy to circle back next week.', rules)).toEqual(['Never say "circle back"']);
    expect(brokenNeverRules('Thanks 🙂', rules)).toEqual(['No emojis']);
    expect(brokenNeverRules('Hi Maya, thanks for the time.', rules)).toEqual([]);
  });

  it('holds a referral rule and a named thing, and leaves what cannot be checked alone', () => {
    expect(brokenNeverRules('Would you refer me?', "Don't ask for a referral")).toEqual([
      "Don't ask for a referral",
    ]);
    expect(brokenNeverRules('I worked at my dad’s company.', "Never mention my dad's company")).toHaveLength(
      1,
    );
    expect(neverDoChecks('Never sound desperate')).toEqual([]);
    expect(neverDoChecks('Never write to two people at the same company on the same day')).toEqual([]);
    expect(neverDoChecks(undefined)).toEqual([]);
  });
});

describe('a draft held to the never rules', () => {
  it('warns, without blocking, when a message breaks one', () => {
    const opts = { kind: 'outreach' as const, facts: [], allowedUrls: [], recipientFirstName: 'Maya' };
    const body = 'Hi Maya! My GPA is 3.9 and I would love 15 minutes.';
    const issues = validateDraft({ body, claims: [] }, { ...opts, neverDo: 'Never mention my GPA.' });
    expect(issues).toContainEqual({ code: 'never_do', detail: 'Never mention my GPA', blocking: false });
    expect(validateDraft({ body, claims: [] }, opts).some((i) => i.code === 'never_do')).toBe(false);
  });
});

describe('who the student wants to meet', () => {
  it('reads roles, levels, alumni and topic words', () => {
    const w = parseWantToMeet(
      'Engineers and PMs at payments companies, especially Cornell alumni a year or two in.',
    );
    expect(w.titles).toEqual(['Product Manager', 'Software Engineer']);
    expect(w.alumni).toBe(true);
    expect(w.levels).toContain('entry');
    expect(w.words).toContain('payments');
    expect(w.words).toContain('cornell');
    expect(parseWantToMeet('')).toEqual({ titles: [], levels: [], alumni: false, words: [] });
  });

  it('fits someone in a named role, more so with a second thing named', () => {
    const w = parseWantToMeet('PMs at payments companies');
    const pm = wantFit({ title: 'Product Manager', company: 'Stripe', headline: 'Payments at Stripe' }, w);
    const pmElse = wantFit({ title: 'Product Manager', company: 'Figma' }, w);
    const banker = wantFit({ title: 'Investment Banking Analyst', company: 'Evercore' }, w);
    expect(pm.roleHit).toBe(true);
    expect(pm.score).toBeGreaterThan(pmElse.score);
    expect(banker.score).toBe(0);
  });

  it('ranks Discover for them and says why', () => {
    const base = {
      user: { school: 'Cornell University' },
      goals: { targetFunctions: ['swe'], targetRoles: [], targetIndustries: [], targetLocations: [] },
      targetCompanies: [],
      resumeFacets: [],
    };
    const plain = buildDiscoverProfile(base);
    const want = buildDiscoverProfile({ ...base, goals: { ...base.goals, wantToMeet: 'Founders' } });
    expect(plain.wantToMeet).toBeUndefined();
    expect(want.wantToMeet?.titles).toEqual(['Founder']);
    expect(discoverQueries(want).some((q) => q.kind === 'want_to_meet' && q.title === 'Founder')).toBe(true);
    const founder = { name: 'Dana Lee', title: 'Founder', company: 'Acme', distance: 2 };
    const a = scoreDiscoverCandidate(founder, plain);
    const b = scoreDiscoverCandidate(founder, want);
    expect(b.fit).toBeGreaterThan(a.fit);
    expect(b.reasons.map((r) => r.text)).toContain('Founder at Acme, who you said you want to meet');
    expect(b.goalLink).toBe(true);
  });
});

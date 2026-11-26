import { describe, expect, it } from 'vitest';
import { bandOf, capsFor, FIT_WEIGHTS, fitOf, fitOnHundred, goalsOf, missingMustOf, partsOf } from './fit';
import type {
  EducationAnswer,
  ExperienceAnswer,
  FitAnswers,
  JobRequirement,
  LevelAnswer,
  RoleProfile,
  SkillAnswer,
} from './types';

const answers = (o: {
  skills?: { answer: SkillAnswer; need?: 'must' | 'nice' }[];
  experience?: ExperienceAnswer;
  education?: EducationAnswer;
  level?: LevelAnswer;
}): FitAnswers => ({
  skills: (o.skills ?? []).map((s, i) => ({ name: `S${i}`, need: s.need ?? 'must', answer: s.answer })),
  experience: { answer: o.experience ?? 'none' },
  education: { answer: o.education ?? 'unsaid' },
  level: { answer: o.level ?? 'at' },
  caps: [],
  reason: '',
  gaps: [],
});

const three = (answer: SkillAnswer) => [{ answer }, { answer }, { answer }];

describe('fitOf: the worked examples, out of 100', () => {
  it('nothing matches at all is a 0', () => {
    const f = fitOf(answers({ skills: three('none'), experience: 'none', education: 'no', level: 'far' }));
    expect(f.raw).toBe(0);
    expect(f.score).toBe(0);
    expect(f.band).toBe('out');
    expect(f.scale).toBe(100);
  });

  it('skills only listed, a related internship, education unsaid, at level is a 53', () => {
    const f = fitOf(
      answers({ skills: three('listed'), experience: 'related', education: 'unsaid', level: 'at' }),
    );
    expect(f.parts.education).toBeUndefined();
    expect(f.weights.education).toBeUndefined();
    expect(f.score).toBe(53);
    expect(f.band).toBe('stretch');
  });

  it('the same with a degree that fits is a 61', () => {
    const f = fitOf(
      answers({ skills: three('listed'), experience: 'related', education: 'fits', level: 'at' }),
    );
    expect(f.score).toBe(61);
  });

  it('skills shown in projects, related internship, degree fits, at level is a 78, a good fit', () => {
    const f = fitOf(
      answers({ skills: three('project'), experience: 'related', education: 'fits', level: 'at' }),
    );
    expect(f.score).toBe(78);
    expect(f.band).toBe('good');
  });

  it('everything shown in work at the same kind of role is a 100', () => {
    const f = fitOf(answers({ skills: three('work'), experience: 'same', education: 'fits', level: 'at' }));
    expect(f.score).toBe(100);
    expect(f.band).toBe('strong');
  });

  it('scores between the old steps: one skill moving from a project to work moves the score a little', () => {
    const base = answers({ skills: three('project'), experience: 'related', education: 'fits', level: 'at' });
    const more = structuredClone(base);
    more.skills[0]!.answer = 'work';
    const a = fitOf(base).score;
    const b = fitOf(more).score;
    expect(b).toBeGreaterThan(a);
    expect(b - a).toBeLessThan(5);
  });
});

describe('fitOf: parts and weights', () => {
  it('must skills count twice what nice skills do', () => {
    const p = partsOf(
      answers({
        skills: [
          { answer: 'work', need: 'must' },
          { answer: 'none', need: 'nice' },
        ],
      }),
    );
    expect(p.skills).toBeCloseTo(2 / 3);
  });

  it('a must-have skill shown nowhere costs points on top of its weight', () => {
    const shown = answers({
      skills: [
        { answer: 'work', need: 'must' },
        { answer: 'none', need: 'nice' },
      ],
      experience: 'same',
      level: 'at',
    });
    const missing = answers({
      skills: [
        { answer: 'none', need: 'must' },
        { answer: 'work', need: 'nice' },
      ],
      experience: 'same',
      level: 'at',
    });
    expect(missingMustOf(missing)).toBe(1);
    expect(fitOf(shown).score - fitOf(missing).score).toBeGreaterThan(FIT_WEIGHTS.missingMust);
  });

  it('a silent part is left out and the others share its weight in proportion', () => {
    const f = fitOf(answers({ skills: [], experience: 'same', education: 'unsaid', level: 'at' }));
    expect(f.parts.skills).toBeUndefined();
    expect(f.parts.education).toBeUndefined();
    expect(f.parts.goals).toBeUndefined();
    expect(f.weights.experience).toBeCloseTo(0.25 / 0.35);
    expect(f.weights.level).toBeCloseTo(0.1 / 0.35);
    expect(f.score).toBe(100);
    const sum = Object.values(f.weights).reduce((s, w) => s + (w ?? 0), 0);
    expect(sum).toBeCloseTo(1);
  });

  it('the weights are one constant', () => {
    const p = FIT_WEIGHTS.parts;
    expect(p.skills + p.experience + p.education + p.level + p.goals).toBeCloseTo(1);
  });

  it('bands', () => {
    expect([0, 49, 50, 64, 65, 79, 80, 100].map(bandOf)).toEqual([
      'out',
      'out',
      'stretch',
      'stretch',
      'good',
      'good',
      'strong',
      'strong',
    ]);
  });
});

describe('the goals part: the kind of work and the place the student is after', () => {
  const profile = (o: Partial<Pick<RoleProfile, 'kinds' | 'wants'>> = {}) => ({
    kinds: [{ title: 'Product manager', on: true }],
    wants: { levels: [], places: [], notPlaces: [], remote: false },
    ...o,
  });
  const job = (title: string, places = ['San Francisco, CA'], remote: 'remote' | 'on_site' = 'on_site') => ({
    title,
    places,
    remote,
  });

  it('the title the student ticked is 1, another kind of work is 0', () => {
    expect(goalsOf(job('Associate Product Manager'), profile())).toBe(1);
    expect(goalsOf(job('Accountant'), profile())).toBe(0);
  });

  it('the place counts a quarter when the student named one', () => {
    const wants = { levels: [], places: ['New York'], notPlaces: [], remote: false };
    expect(goalsOf(job('Product Manager'), profile({ wants }))).toBeCloseTo(0.75);
    expect(goalsOf(job('Product Manager', ['New York, NY']), profile({ wants }))).toBe(1);
  });

  it('nothing ticked and no place named: the part is left out', () => {
    expect(goalsOf(job('Product Manager'), profile({ kinds: [] }))).toBeUndefined();
  });

  it('a role that is the work the student is after scores above one that is not, all else the same', () => {
    const a = answers({ skills: three('project'), experience: 'related', education: 'fits', level: 'at' });
    const want = fitOf(a, { goals: goalsOf(job('Product Manager Intern'), profile()) });
    const other = fitOf(a, { goals: goalsOf(job('Sales Associate'), profile()) });
    expect(want.score - other.score).toBeGreaterThanOrEqual(10);
    expect(want.parts.goals).toBe(1);
  });
});

describe('rows kept from before the score went out of 100', () => {
  const old = { score: 8, raw: 8, parts: {}, weights: {}, caps: [], band: 'good' as const };
  it('are scored again from their answers', () => {
    const a = answers({ skills: three('project'), experience: 'related', education: 'fits', level: 'at' });
    expect(fitOnHundred(old, a)?.score).toBe(78);
  });
  it('without answers, carry the old number at ten times', () => {
    expect(fitOnHundred(old)).toMatchObject({ score: 80, band: 'strong', scale: 100 });
  });
  it('leave a score already out of 100 as it is', () => {
    const f = fitOf(answers({ skills: three('work'), experience: 'same', level: 'at' }));
    expect(fitOnHundred(f)).toBe(f);
  });
});

const perfect = () => answers({ skills: three('work'), experience: 'same', education: 'fits', level: 'at' });

describe('fitOf: caps', () => {
  const cases: [FitAnswers['caps'][number]['kind'], number][] = [
    ['degree', 30],
    ['years', 40],
    ['graduation', 40],
    ['sponsorship', 20],
    ['citizenship_no', 20],
    ['citizenship_ask', 50],
    ['place', 50],
    ['thin', 60],
  ];
  for (const [kind, cap] of cases)
    it(`${kind} holds a 100 down to ${cap}`, () => {
      const f = fitOf({ ...perfect(), caps: [{ kind, label: 'x' }] });
      expect(f.raw).toBe(100);
      expect(f.score).toBe(cap);
      expect(f.caps.map((c) => c.kind)).toEqual([kind]);
    });

  it('a posting with fewer than three requirements is thin and caps at 60: never a good fit on paper', () => {
    expect(fitOf(perfect(), { requirements: 2 }).score).toBe(60);
    expect(fitOf(perfect(), { requirements: 2 }).band).toBe('stretch');
    expect(fitOf(perfect(), { requirements: 2 }).caps[0]!.label).toBe('The posting says little');
    expect(fitOf(perfect(), { requirements: 3 }).score).toBe(100);
  });

  it('a cap never raises a low score', () => {
    const low = answers({ skills: three('none'), experience: 'none', education: 'no', level: 'far' });
    expect(fitOf({ ...low, caps: [{ kind: 'thin', label: 'x' }] }).score).toBe(0);
  });
});

// ---- more is never less (§6.7) ------------------------------------------------------------------------------------

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
const SKILL_ORDER: SkillAnswer[] = ['none', 'listed', 'project', 'work'];

describe('fitOf: adding a skill the posting asks for never lowers the score', () => {
  it('over 3,000 generated profiles, parts left out included', () => {
    const r = rng(44);
    let checked = 0;
    for (let n = 0; n < 3000; n++) {
      const skills = Array.from({ length: Math.floor(r() * 7) }, () => ({
        answer: pick(r, SKILL_ORDER),
        need: pick(r, ['must', 'nice'] as const),
      }));
      const a = answers({
        skills,
        experience: pick(r, ['same', 'related', 'projects', 'none'] as const),
        education: pick(r, ['fits', 'close', 'no', 'unsaid'] as const),
        level: pick(r, ['at', 'below', 'stretch', 'far'] as const),
      });
      if (r() < 0.3) a.caps = [{ kind: pick(r, ['thin', 'place', 'years'] as const), label: 'x' }];
      const reqs = { requirements: Math.floor(r() * 6) };
      const before = fitOf(a, reqs);
      for (let i = 0; i < a.skills.length; i++) {
        const at = SKILL_ORDER.indexOf(a.skills[i]!.answer);
        for (let up = at + 1; up < SKILL_ORDER.length; up++) {
          const more = structuredClone(a);
          more.skills[i]!.answer = SKILL_ORDER[up]!;
          const after = fitOf(more, reqs);
          expect(after.score).toBeGreaterThanOrEqual(before.score);
          expect(after.raw).toBeGreaterThanOrEqual(before.raw);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});

// ---- caps from facts -------------------------------------------------------------------------------------------------

const profile = (over: Partial<RoleProfile> = {}): RoleProfile => ({
  level: 'student',
  graduation: '2027-05',
  degree: 'bachelor',
  courses: [],
  experience: [],
  projects: [],
  skills: [],
  kinds: [],
  wants: { levels: [], places: [], notPlaces: [], remote: false },
  eligibility: {},
  sources: ['resume'],
  fullTimeMonths: 0,
  ...over,
});
const req = (r: Partial<JobRequirement>): JobRequirement => ({
  kind: 'skill',
  need: 'must',
  name: 'x',
  quote: 'q',
  ...r,
});

describe('capsFor', () => {
  it('a PhD the student is not working toward', () => {
    const c = capsFor([req({ kind: 'education', degree: 'phd', quote: 'PhD required' })], profile());
    expect(c).toEqual([{ kind: 'degree', quote: 'PhD required', label: 'Asks for a PhD' }]);
    expect(capsFor([req({ kind: 'education', degree: 'phd' })], profile({ degree: 'phd' }))).toEqual([]);
    expect(capsFor([req({ kind: 'education', degree: 'phd', need: 'nice' })], profile())).toEqual([]);
  });

  it('years three or more beyond theirs', () => {
    expect(capsFor([req({ kind: 'experience', years: 5 })], profile())[0]!.label).toBe('Asks for 5 years');
    expect(capsFor([req({ kind: 'experience', years: 2 })], profile())).toEqual([]);
    expect(capsFor([req({ kind: 'experience', years: 5 })], profile({ fullTimeMonths: 36 }))).toEqual([]);
  });

  it('a graduation window the student is outside', () => {
    const r = req({
      kind: 'eligibility',
      eligibility: 'graduation_window',
      gradFrom: '2026-01',
      gradTo: '2026-08',
    });
    expect(capsFor([r], profile())[0]).toMatchObject({ kind: 'graduation', label: 'For 2026 graduates' });
    expect(capsFor([r], profile({ graduation: '2026-05' }))).toEqual([]);
  });

  it('sponsorship only when the student said they need it', () => {
    const r = req({ kind: 'eligibility', eligibility: 'no_sponsorship' });
    expect(capsFor([r], profile())).toEqual([]);
    expect(capsFor([r], profile({ eligibility: { needsSponsorship: true } }))[0]!.kind).toBe('sponsorship');
    expect(
      capsFor([], profile({ eligibility: { needsSponsorship: true } }), {
        places: [],
        sponsorship: 'none',
      })[0]!.label,
    ).toBe('Does not sponsor visas');
  });

  it('citizenship: said no caps at 2, never asked caps at 5 and asks', () => {
    const r = req({ kind: 'eligibility', eligibility: 'citizenship' });
    expect(capsFor([r], profile({ eligibility: { usCitizen: false } }))[0]!.kind).toBe('citizenship_no');
    expect(capsFor([r], profile())[0]).toMatchObject({
      kind: 'citizenship_ask',
      label: 'Asks for US citizenship. Do you hold it?',
    });
    expect(capsFor([r], profile({ eligibility: { usCitizen: true } }))).toEqual([]);
  });

  it('on site in a place the student excluded', () => {
    const p = profile({ wants: { levels: [], places: [], notPlaces: ['Austin'], remote: false } });
    expect(capsFor([], p, { places: ['Austin, TX'], remote: 'on_site' })[0]!.label).toBe(
      'On site in Austin, TX',
    );
    expect(capsFor([], p, { places: ['Austin, TX'], remote: 'remote' })).toEqual([]);
    expect(capsFor([], p, { places: ['Austin, TX', 'New York, NY'], remote: 'on_site' })).toEqual([]);
  });

  it('an internship, for someone a year or more into full-time work', () => {
    const intern = { places: [], level: 'intern' as const };
    const cap = [{ kind: 'graduation', label: 'An internship, for current students' }];
    expect(capsFor([], profile({ level: 'early', fullTimeMonths: 30 }), intern)).toEqual(cap);
    expect(capsFor([], profile({ level: 'mid', fullTimeMonths: 60 }), intern)).toEqual(cap);
    expect(capsFor([], profile({ level: 'senior', fullTimeMonths: 100 }), intern)).toEqual(cap);
    // a student and someone just finishing are who an internship is for
    expect(capsFor([], profile({ level: 'student' }), intern)).toEqual([]);
    expect(capsFor([], profile({ level: 'new_grad' }), intern)).toEqual([]);
    // a role at any other level, or one that does not say, is never capped for this
    expect(capsFor([], profile({ level: 'mid' }), { places: [], level: 'entry' })).toEqual([]);
    expect(capsFor([], profile({ level: 'mid' }), { places: [] })).toEqual([]);
    // with a graduation window the posting names, the window's own words are kept
    const window = req({
      kind: 'eligibility',
      eligibility: 'graduation_window',
      gradFrom: '2027-12',
      gradTo: '2028-08',
    });
    expect(
      capsFor([window], profile({ level: 'mid', graduation: '2021-05' }), intern).map((c) => c.label),
    ).toEqual(['For 2027 to 2028 graduates']);
  });

  it('unknown is never a cap', () => {
    expect(capsFor([], profile(), { places: ['Austin'], remote: undefined })).toEqual([]);
  });

  it('no em dash or exclamation mark in any label', () => {
    const all = [
      ...capsFor(
        [
          req({ kind: 'education', degree: 'phd' }),
          req({ kind: 'experience', years: 8 }),
          req({ kind: 'eligibility', eligibility: 'citizenship' }),
          req({
            kind: 'eligibility',
            eligibility: 'graduation_window',
            gradFrom: '2025-01',
            gradTo: '2026-12',
          }),
        ],
        profile(),
      ),
    ];
    expect(all.length).toBe(4);
    for (const c of all) expect(c.label).not.toMatch(/[—–!]/);
  });
});

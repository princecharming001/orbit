import { describe, expect, it } from 'vitest';
import {
  extractStatements,
  groundHints,
  mayHoldFacts,
  memoryKey,
  quoteIsFrom,
  sensitiveTopic,
} from '../memory/extract';
import { functionsIn, industriesIn, locationsIn } from '../memory/vocab';
import { looksLikeCompany, looksLikeSchool } from '../resume/schools';

/** A statement, what Orbit must remember from it (a pattern on the memory text), and its kind. */
interface Case {
  say: string;
  memory: RegExp;
  kind: string;
  functions?: string[];
  industries?: string[];
  locations?: string[];
  organizations?: string[];
  school?: string;
  majors?: string[];
  graduationYear?: number;
  person?: string;
}

const POSITIVE: Case[] = [
  {
    say: "I'm targeting product manager internships at fintech startups in New York",
    memory: /^Targeting product manager internships at fintech startups in New York$/,
    kind: 'goal_detail',
    functions: ['pm'],
    industries: ['Fintech'],
    locations: ['New York City'],
    organizations: [],
  },
  { say: "I'm targeting PM roles", memory: /^Targeting PM roles$/, kind: 'goal_detail', functions: ['pm'] },
  {
    say: 'im recruiting for software engineering internships in SF or Seattle',
    memory: /^Recruiting for software engineering internships in SF or Seattle$/,
    kind: 'goal_detail',
    functions: ['swe'],
    locations: ['Seattle', 'San Francisco Bay Area'],
  },
  {
    say: 'I want to work in NYC',
    memory: /^Wants to work in NYC$/,
    kind: 'goal_detail',
    locations: ['New York City'],
  },
  {
    say: 'I want to work in fintech.',
    memory: /^Wants to work in fintech$/,
    kind: 'goal_detail',
    industries: ['Fintech'],
  },
  {
    say: "I'd like to break into investment banking",
    memory: /^Wants to break into investment banking$/,
    kind: 'goal_detail',
    functions: ['ib'],
  },
  {
    say: 'I want to be a product manager',
    memory: /^Wants to be a product manager$/,
    kind: 'goal_detail',
    functions: ['pm'],
  },
  {
    say: "I'm applying to Stripe and Ramp",
    memory: /^Applying to Stripe and Ramp$/,
    kind: 'goal_detail',
    organizations: ['Stripe', 'Ramp'],
  },
  {
    say: "I'm targeting Google, Meta and Apple for SWE internships this summer",
    memory: /^Targeting Google, Meta and Apple for SWE internships/,
    kind: 'goal_detail',
    functions: ['swe'],
    organizations: ['Google', 'Meta', 'Apple'],
  },
  {
    say: 'My goal is to land a data science internship at Spotify',
    memory: /^Goal: land a data science internship at Spotify$/,
    kind: 'goal_detail',
    functions: ['data'],
    organizations: ['Spotify'],
  },
  {
    say: "I'm interested in climate tech",
    memory: /^Interested in climate tech$/,
    kind: 'goal_detail',
    industries: ['Climate and energy'],
  },
  {
    say: "Right now I'm mostly focused on consulting roles in Chicago",
    memory: /^Focused on consulting roles in Chicago$/,
    kind: 'goal_detail',
    functions: ['consulting'],
    locations: ['Chicago'],
  },
  {
    say: "I'm a junior at Cornell studying CS",
    memory: /^Is a junior at Cornell studying CS$/,
    kind: 'note',
    school: 'Cornell',
    majors: ['CS'],
  },
  {
    say: "I'm a sophomore studying computer science at the University of Michigan",
    memory: /^Is a sophomore at University of Michigan studying Computer Science$/,
    kind: 'note',
    school: 'University of Michigan',
    majors: ['Computer Science'],
  },
  {
    say: "I'm a CS major at Berkeley",
    memory: /^Studies CS at Berkeley$/,
    kind: 'note',
    school: 'Berkeley',
    majors: ['CS'],
  },
  {
    say: "I'm majoring in economics and math at Penn",
    memory: /^Studies Economics and Math at Penn$/,
    kind: 'note',
    majors: ['Economics', 'Math'],
    school: 'Penn',
  },
  { say: 'I go to Georgia Tech', memory: /^Goes to Georgia Tech$/, kind: 'note', school: 'Georgia Tech' },
  { say: 'I graduate in May 2027', memory: /^Graduates in 2027$/, kind: 'note', graduationYear: 2027 },
  { say: "I'm class of 2026", memory: /^Graduates in 2026$/, kind: 'note', graduationYear: 2026 },
  {
    say: 'I interned at Amma Health Inc. last summer',
    memory: /^Interned at Amma Health Inc$/,
    kind: 'note',
  },
  {
    say: 'I worked at Stripe as a PM intern',
    memory: /^Worked at Stripe as a PM intern$/,
    kind: 'note',
  },
  {
    say: 'I was a software engineering intern at Google in 2025',
    memory: /^Worked at Google as a software engineering intern$/,
    kind: 'note',
  },
  { say: 'I did an internship at Ramp', memory: /^Interned at Ramp$/, kind: 'note' },
  {
    say: "Don't contact Maya Chen",
    memory: /^Does not want to contact Maya Chen$/,
    kind: 'constraint',
    person: 'Maya Chen',
  },
  {
    say: 'Please never email anyone at Goldman again',
    memory: /^Does not want to contact anyone at Goldman/,
    kind: 'constraint',
  },
  {
    say: "I don't want to reach out to Priya Patel",
    memory: /^Does not want to contact Priya Patel$/,
    kind: 'constraint',
    person: 'Priya Patel',
  },
  { say: 'I prefer morning calls', memory: /^Prefers morning calls$/, kind: 'preference' },
  {
    say: "I'd rather email than message people on LinkedIn",
    memory: /^Would rather email than message people on LinkedIn$/,
    kind: 'preference',
  },
  { say: 'I hate long cold emails', memory: /^Dislikes long cold emails$/, kind: 'preference' },
  { say: "I can't do calls on Fridays", memory: /^Cannot do calls on Fridays$/, kind: 'constraint' },
  { say: "I'm only available after 5pm", memory: /^Only available after 5pm$/, kind: 'constraint' },
  {
    say: "I'm studying abroad in Madrid until December",
    memory: /^Is studying abroad in Madrid until December$/,
    kind: 'constraint',
  },
  { say: "I'm not interested in banking", memory: /^Not interested in banking$/, kind: 'constraint' },
  {
    say: "I don't want to work in finance",
    memory: /^Does not want to work in finance$/,
    kind: 'constraint',
  },
  { say: 'I got an offer from Stripe!', memory: /^Got an offer from Stripe$/, kind: 'outcome' },
  {
    say: 'I have an interview with Ramp next week',
    memory: /^Has an interview with Ramp next week$/,
    kind: 'goal_detail',
  },
  { say: "We're raising a pre-seed round", memory: /^Raising a pre-seed round$/, kind: 'goal_detail' },
  { say: "I'm based in Boston", memory: /^Lives in Boston$/, kind: 'note' },
  {
    say: "I'm looking for a mentor in product management",
    memory: /^Looking for a mentor in product management$/,
    kind: 'goal_detail',
  },
  {
    say: 'Also, I want to move to Seattle after graduation',
    memory: /^Wants to move to Seattle after graduation$/,
    kind: 'preference',
    locations: ['Seattle'],
  },
  {
    say: 'I need to accept the Ramp offer by November 1',
    memory: /^Needs to accept the Ramp offer by November 1$/,
    kind: 'constraint',
  },
];

/** Things a student says that are not clear statements about themselves: nothing is stored. */
const NEGATIVE = [
  'my friend wants PM roles',
  'My roommate is targeting banking',
  "She's interning at Google this summer",
  'Should I target PM roles?',
  'Am I targeting the right companies?',
  'If I wanted to work in NYC, who should I talk to?',
  'Maybe I want to try consulting',
  "I'm thinking about PM",
  "I'm considering investment banking",
  'I might apply to Stripe',
  'Find PMs in New York',
  'Draft a message to Maya Chen',
  'What do you remember about me?',
  'remember that I prefer morning calls',
  "I'm looking for Sarah's email",
  "I'm looking at your draft",
  'I love it',
  'I like this one',
  "I can't find the button",
  "I'm free tomorrow at 3",
  "I'm busy today",
  "I'm a junior at heart",
  'My advisor said I should target PM',
  "I don't want to bother you",
  'Thanks, that looks great',
  'who should I email today',
  'I was diagnosed with ADHD last year',
  'My wife and I are moving to Seattle',
  'ok',
  'I worked with Maya on a project',
  "I'm studying for my midterms",
  'I think I want to do product',
  "I'd probably target consulting",
  'I want to get a job',
];

describe('statements the student makes about themselves (40+ cases)', () => {
  for (const c of POSITIVE) {
    it(c.say, () => {
      const r = extractStatements(c.say);
      expect(r.memories, JSON.stringify(r, null, 1)).toHaveLength(1);
      const m = r.memories[0]!;
      expect(m.text).toMatch(c.memory);
      expect(m.kind).toBe(c.kind);
      expect(quoteIsFrom(m.quote, c.say), `quote "${m.quote}"`).toBe(true);
      expect(m.text.length).toBeLessThanOrEqual(200);
      if (c.functions) expect(r.recruiting?.functions ?? []).toEqual(c.functions);
      if (c.industries) expect(r.recruiting?.industries ?? []).toEqual(c.industries);
      if (c.locations) expect([...(r.recruiting?.locations ?? [])].sort()).toEqual([...c.locations].sort());
      if (c.organizations) expect(r.recruiting?.organizations ?? []).toEqual(c.organizations);
      if (c.school) expect(r.profile?.school).toBe(c.school);
      if (c.majors) expect(r.profile?.majors).toEqual(c.majors);
      if (c.graduationYear) expect(r.profile?.graduationYear).toBe(c.graduationYear);
      if (c.person) expect(m.personName).toBe(c.person);
    });
  }
  it('has at least 40 statements and 30 negatives', () => {
    expect(POSITIVE.length).toBeGreaterThanOrEqual(40);
    expect(NEGATIVE.length).toBeGreaterThanOrEqual(30);
  });
});

describe('what is never stored', () => {
  for (const say of NEGATIVE) {
    it(say, () => {
      const r = extractStatements(say);
      expect(r.memories, JSON.stringify(r.memories)).toEqual([]);
      expect(r.recruiting).toBeUndefined();
    });
  }
});

describe('several statements in one message', () => {
  it('reads each clause, and the recruiting targets of all of them', () => {
    const r = extractStatements(
      "I'm a junior at Cornell and I'm targeting PM internships. I want to work in NYC or Boston. Who should I talk to first?",
    );
    expect(r.memories.map((m) => m.text)).toEqual([
      'Is a junior at Cornell',
      'Targeting PM internships',
      'Wants to work in NYC or Boston',
    ]);
    expect(r.recruiting?.functions).toEqual(['pm']);
    expect(r.recruiting?.locations).toEqual(['New York City', 'Boston']);
    expect(r.recruiting?.employment).toBe('internship');
    expect(r.profile?.school).toBe('Cornell');
  });

  it('keeps a cycle only when the student named the season and year', () => {
    expect(extractStatements("I'm recruiting for summer 2027 SWE internships").recruiting?.cycleLabel).toBe(
      'Summer 2027 internship',
    );
    expect(extractStatements("I'm recruiting for SWE internships").recruiting?.cycleLabel).toBeUndefined();
  });

  it('keeps a plain statement next to a sensitive one, and never the sensitive one', () => {
    const r = extractStatements("I'm Catholic and I'm targeting PM roles in Boston");
    expect(r.memories.map((m) => m.text)).toEqual(['Targeting PM roles in Boston']);
    expect(JSON.stringify(r)).not.toMatch(/catholic/i);
  });

  it('never makes an employer the school', () => {
    expect(extractStatements("I'm a junior at Amma Health Inc.").profile?.school).toBeUndefined();
    expect(extractStatements('I go to Amma Health Inc').memories).toEqual([]);
  });
});

describe('checking what a model read', () => {
  const said = "I'm targeting product manager internships at fintech startups in New York, maybe at Ramp";
  it('keeps only targets the student said, in the names Orbit stores', () => {
    const h = groundHints(
      {
        functions: ['pm', 'swe'],
        industries: ['fintech', 'crypto'],
        locations: ['NYC', 'San Francisco'],
        organizations: ['Ramp', 'Stripe'],
        phrase: 'product manager internships',
      },
      said,
      said,
    );
    expect(h?.functions).toEqual(['pm']);
    expect(h?.industries).toEqual(['Fintech']);
    expect(h?.locations).toEqual(['New York City']);
    expect(h?.organizations).toEqual(['Ramp']);
    expect(h?.employment).toBe('internship');
  });
  it('drops a guess entirely', () => {
    expect(groundHints({ functions: ['ib'], organizations: ['Goldman'] }, said, said)).toBeUndefined();
  });
  it('checks quotes and sensitive topics', () => {
    expect(quoteIsFrom("I'm targeting product manager internships", said)).toBe(true);
    expect(quoteIsFrom('I am targeting PM roles', said)).toBe(false);
    expect(sensitiveTopic('Is pregnant and looking for remote roles')).toBe('health');
    expect(sensitiveTopic('Targeting PM internships')).toBeUndefined();
    expect(memoryKey('Prefers morning calls.')).toBe(memoryKey('prefers  morning calls'));
  });
  it('asks a model only about messages that may hold facts', () => {
    expect(mayHoldFacts("I'm targeting PM roles in New York this cycle")).toBe(true);
    expect(mayHoldFacts('Who should I email today about the PM role?')).toBe(false);
    expect(mayHoldFacts('Draft a thank-you to Maya for the coffee chat')).toBe(false);
    expect(mayHoldFacts('ok thanks')).toBe(false);
  });
});

describe('vocabulary', () => {
  it('reads kinds of work, industries and places', () => {
    expect(functionsIn('product design internships')).toEqual(['design']);
    expect(functionsIn('product marketing and PM roles')).toEqual(['marketing', 'pm']);
    expect(functionsIn('mechanical engineering')).toEqual([]);
    expect(functionsIn('meet at 5pm')).toEqual([]);
    expect(functionsIn('venture-backed startups')).toEqual([]);
    expect(industriesIn('climate tech startups')).toEqual(['Climate and energy']);
    expect(industriesIn('big tech')).toEqual(['Technology']);
    expect(locationsIn('New York University')).toEqual([]);
    expect(locationsIn('in NY or the Bay Area')).toEqual(['New York City', 'San Francisco Bay Area']);
    expect(locationsIn('la vie')).toEqual([]);
  });
  it('tells schools from employers', () => {
    for (const s of [
      'University of Michigan',
      'Cornell',
      'MIT',
      'Penn State',
      'UC Santa Barbara',
      'Baruch College',
    ])
      expect(looksLikeSchool(s), s).toBe(true);
    for (const c of ['Amma Health Inc.', 'Stripe', 'Goldman Sachs', 'Scale AI', 'Bain & Company'])
      expect(looksLikeSchool(c), c).toBe(false);
    expect(looksLikeCompany('Amma Health Inc.')).toBe(true);
    expect(looksLikeCompany('Harvard School of Public Health')).toBe(false);
  });
});

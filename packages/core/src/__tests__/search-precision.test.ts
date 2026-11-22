/**
 * Who a search for a job lists, on a network shaped like a real one. Every person here is made up; each headline is a
 * pattern that once put the wrong person in the list (a mention read as the job) or kept the right one out (the job
 * said three lines down).
 *
 * The rule under test: someone is listed for a job when their own words say they hold it. A headline that only uses
 * the word ("investor relations", "VC-backed", "design thinking", "it is your people") is not that, and a title that
 * could go either way ("VC Scout", "Bonfire VC") is a likely for a reader to settle, never a confirmed match.
 */
import { describe, expect, it } from 'vitest';
import { buildFactsIndex } from '../search/companies';
import { buildPersonDoc, type DocPerson } from '../search/doc';
import { buildPlaceIndex } from '../search/places';
import { PLACES_DATA } from '../search/places.data';
import type { SearchContext } from '../search/predicates';
import { runSpec } from '../search/run';
import { buildSchoolIndex } from '../search/schools';
import type { QuerySpec } from '../search/spec';

const schools = buildSchoolIndex([
  { name: 'University of California, Berkeley', aliases: ['UC Berkeley', 'Berkeley'], kind: 1 },
  { name: 'University of Waterloo', aliases: ['UWaterloo', 'Waterloo'], kind: 1 },
]);
const places = buildPlaceIndex(PLACES_DATA);
const ctx: SearchContext = {
  facts: buildFactsIndex([]),
  places,
  schools,
  rel: () => undefined,
  channels: {
    email: { connected: true },
    meeting: { connected: false },
    text: { connected: false },
    linkedin: { connected: true },
  },
  mySchools: [],
  now: Date.parse('2026-11-22'),
  // no reader: what is listed as confirmed here is what the rules alone are sure of
  noJudge: true,
};

/** name -> headline. The title field is the headline's first part, as an import sets it. */
const NETWORK: Record<string, string> = {
  // investors, said as a job
  Ines: 'Investor at Anfa',
  Bao: 'Partner at Pear VC',
  Gita: 'General Partner at Swift Ventures',
  Vera: 'Venture Capital | Health, DeepTech, AI',
  Dev: 'Deep Tech VC | 2x Founder/CEO',
  Ama: 'Investments @ Aum Ventures | Early-Stage Deeptech',
  Pia: 'Principal at Balderton Capital',
  Ilya: 'investing in ambitious founders @ startmate',
  // investors, said further down
  Uma: 'Angel Investor | Digital Strategy Consultant',
  Bo: 'Bike Karma | Cycling & Outdoor Tech | Product | Angel Investor',
  Nag: 'Engineering and Quality Leader | Angel Investor | Independent Board Director',
  Cal: 'GenAI enabled Medical Doctor, Ex founder, Clinical Product Operations Specialist, Angel Investor',
  Mel: 'MedTech Product Consultant @ SY Health Advisors | Investor, MBA, Healthcare Innovation',
  // could be either: a reader settles it
  Dax: 'Startup Banking @ Rho | VC Scout | Ex-LinkedIn',
  Mal: 'Bonfire VC | prev. @AWS',
  Moe: 'Dealflow Partner @ LvlUp Ventures',
  Mia: 'VP & Principal | Venture Capital | Enterprise & AI SaaS',
  // not investors, whatever words they use
  Ana: 'Empowering Real Estate Companies to Raise Investor Capital - Business Development Executive',
  Kev: 'Startup & VC Lawyer',
  Kri: 'President of Girls into Venture Capital | Prev. BA @ RBC',
  Lon: 'London Venture Capital Network',
  Rob: 'vc backed ai startup - dms open',
  Dia: 'Fundraising advisor getting seed founders investor-ready and in front of the right investors',
  Oja: 'Investment Banking Analyst at SKV Capital',
  Mar: 'Trusted design partner to top VC firms, founders, and marketing leaders.',
  Sam: 'Engineering & Executive Search for VC-Backed AI Startups',
  Alx: 'CEO & 4x Managing Partner | Helping Lead a Dental Group Practice',
  Fro: 'Front Desk Associate at CCMC',
  Ful: 'Fulfillment Associate at Burlebo',
  Hrg: 'HR Generalist | People Operations & Business Partner',
  Exa: 'Executive Assistant to CEO | Executive Business Partner',
  Bad: 'Engineering @ Helium Ventures, ex-Nvidia',
  Rit: 'Making Science Better | Prev. Founder & VC',
  Asp: 'Aspiring Venture Capitalist | Economics @ UC Berkeley',
  // other jobs
  Cos: 'Chief of Staff at Ramp',
  Ceo: 'CEO @ Pond AI',
  Coo: 'COO @ ByteByByte',
  Rec: 'AI/ML & Data Recruiter',
  Tal: 'Head of Talent @ Whop',
  Cam: 'Campus Lead @ OpenAI',
  Ppl: 'It is not your people. It is your culture.',
  Pmm: 'Product Marketing Manager',
  Pmg: 'Product Manager | Duke MEM',
  Prd: 'Product @ Clerkie',
  Hlp: 'Helping Non-Technical Founders Build Their First Product',
  Des: 'Product Designer @ Onething Design',
  Sde: 'Systems Design Engineering @ UWaterloo',
  Dth: 'Exploring the depth of design thinking in all aspects of life',
  Fqe: 'Founding Quantum Engineer',
  Fnd: 'Co-Founder @ Turnstone',
  Law: 'Aspiring Lawyer | Student @ Toronto Metropolitan University',
  Dsc: 'Data Scientist @ Netflix',
  Dan: 'Data Analyst @ Shopify',
  Prf: 'Clinical Professor of Dermatology at Stanford University School of Medicine',
};

const docs = Object.entries(NETWORK).map(([name, headline], i) => {
  const first = headline.split(/\s*\|\s*/)[0]!;
  const at = /^(.*?)(?:\s+at\s+|\s*@\s*)(.+)$/i.exec(first);
  const person: DocPerson = {
    id: `p${i}`,
    displayName: name,
    tags: [],
    headline,
    currentTitle: at ? at[1] : first,
    ...(at ? { currentOrganizationRaw: at[2] } : {}),
  };
  return buildPersonDoc(person, [], { isSchool: (t) => schools.lookup(t), places });
});

function run(spec: QuerySpec) {
  const r = runSpec(spec, docs, ctx);
  const names = (band: string) =>
    r.rows
      .filter((x) => x.band === band)
      .map((x) => x.name)
      .sort();
  // an unchecked row is listed only when the job itself matched (what the table does)
  return { sure: names('strong'), likely: names('likely') };
}
const INVESTORS = [
  'Ama',
  'Bao',
  'Bo',
  'Cal',
  'Dev',
  'Gita',
  'Ilya',
  'Ines',
  'Mel',
  'Nag',
  'Pia',
  'Uma',
  'Vera',
];
const NOT_INVESTORS = [
  'Ana',
  'Kev',
  'Kri',
  'Lon',
  'Rob',
  'Dia',
  'Oja',
  'Mar',
  'Sam',
  'Alx',
  'Fro',
  'Ful',
  'Hrg',
  'Exa',
  'Bad',
  'Rit',
  'Asp',
  'Cos',
  'Ceo',
  'Rec',
  'Pmm',
  'Des',
  'Fnd',
];

describe('investors', () => {
  const asked: QuerySpec = {
    ask: 'investors',
    positions: [
      {
        role: {
          titles: ['investor', 'partner', 'principal', 'associate', 'venture partner', 'general partner'],
          families: ['investing'],
        },
        when: 'current',
      },
    ],
  };
  const r = run(asked);
  it('everyone who says they invest is confirmed, wherever in their headline they say it', () => {
    expect(r.sure).toEqual([...INVESTORS].sort());
  });
  it('a title that could go either way is a likely, never confirmed', () => {
    expect(r.likely).toEqual(['Dax', 'Mal', 'Mia', 'Moe']);
  });
  it('nobody who only mentions investors, serves them, or holds a rung word in another job is listed', () => {
    for (const n of NOT_INVESTORS) expect([...r.sure, ...r.likely], n).not.toContain(n);
  });
  it('the same holds when the search names every rung a fund has', () => {
    const vcs = run({
      ask: 'VCs',
      positions: [
        {
          role: {
            titles: [
              'venture capitalist',
              'vc',
              'venture partner',
              'general partner',
              'partner',
              'principal',
              'associate',
              'investor',
            ],
            families: ['investing'],
          },
          when: 'current',
        },
      ],
    });
    expect(vcs.sure).toEqual([...INVESTORS].sort());
    for (const n of ['Fro', 'Ful', 'Hrg', 'Exa', 'Mar', 'Alx'])
      expect([...vcs.sure, ...vcs.likely], n).not.toContain(n);
  });
});

describe('one job within a kind of work', () => {
  it('angel investors are the people who say angel, not every investor', () => {
    const r = run({
      ask: 'angel investors',
      positions: [{ role: { titles: ['angel investor'], families: ['investing'] }, when: 'current' }],
    });
    expect(r.sure).toEqual(['Bo', 'Cal', 'Nag', 'Uma']);
    for (const n of ['Ines', 'Bao', 'Gita', 'Pia', 'Dax'])
      expect([...r.sure, ...r.likely], n).not.toContain(n);
  });
  it('chiefs of staff are not every executive', () => {
    const r = run({
      ask: 'chiefs of staff',
      positions: [{ role: { titles: ['chief of staff'] }, when: 'current' }],
    });
    expect(r.sure).toEqual(['Cos']);
    expect(r.likely).toEqual([]);
  });
  it('data scientists: the title, and a neighbour in the same work as a likely', () => {
    const r = run({
      ask: 'data scientists',
      positions: [{ role: { titles: ['data scientist'], families: ['data_ml'] }, when: 'current' }],
    });
    expect(r.sure).toEqual(['Dsc']);
    expect(r.likely).toEqual(['Dan']);
    expect([...r.sure, ...r.likely]).not.toContain('Prf');
  });
});

describe('a whole kind of work', () => {
  it('recruiters: people who recruit, not everyone who writes "people" or leads a campus', () => {
    const r = run({
      ask: 'recruiters',
      positions: [
        {
          role: { titles: ['recruiter', 'talent acquisition', 'sourcer'], families: ['people_recruiting'] },
          when: 'current',
        },
      ],
    });
    // executive search is recruiting
    expect(r.sure).toEqual(['Hrg', 'Rec', 'Sam', 'Tal']);
    for (const n of ['Cam', 'Ppl']) expect(r.sure, n).not.toContain(n);
    expect(r.likely).not.toContain('Cam');
  });
  it('product managers: not product marketing, product design, or a sentence about a product', () => {
    const r = run({
      ask: 'product managers',
      positions: [{ role: { titles: ['product manager'], families: ['product'] }, when: 'current' }],
    });
    expect(r.sure).toEqual(['Pmg', 'Prd']);
    for (const n of ['Pmm', 'Des', 'Hlp']) expect(r.sure, n).not.toContain(n);
  });
  it('designers: not design engineering, and not a line about design thinking', () => {
    const r = run({
      ask: 'designers',
      positions: [{ role: { titles: ['designer'], families: ['design'] }, when: 'current' }],
    });
    // a design partner to other firms is a designer
    expect(r.sure).toEqual(['Des', 'Mar']);
    for (const n of ['Sde', 'Dth']) expect(r.sure, n).not.toContain(n);
  });
  it('founders: not a founding engineer', () => {
    const r = run({
      ask: 'founders',
      positions: [{ role: { titles: ['founder'], founder: true }, when: 'current' }],
    });
    expect(r.sure).toContain('Fnd');
    expect([...r.sure, ...r.likely]).not.toContain('Fqe');
    // "Ex founder" in the middle of a list is a job they left
    expect(r.sure).not.toContain('Cal');
  });
  it('a job they want is not a job they hold', () => {
    const r = run({
      ask: 'lawyers',
      positions: [{ role: { titles: ['lawyer', 'attorney'], families: ['legal'] }, when: 'current' }],
    });
    expect([...r.sure, ...r.likely]).not.toContain('Law');
    const inv = run({
      ask: 'investors',
      positions: [{ role: { titles: ['investor'], families: ['investing'] }, when: 'current' }],
    });
    expect([...inv.sure, ...inv.likely]).not.toContain('Asp');
  });
});

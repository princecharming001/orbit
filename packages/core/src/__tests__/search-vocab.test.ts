import { describe, expect, it } from 'vitest';
import { buildFactsIndex, keysFor, kindOfOrg, matchFacts, orgKey, stageOf } from '../search/companies';
import { canonicalBatch, readHeadline } from '../search/headline';
import { buildSchoolIndex } from '../search/schools';
import { readInvesting, readTitle, titleHasWords } from '../search/titles';

const schools = buildSchoolIndex([
  { name: 'University of California, Berkeley', aliases: ['Cal', 'UC Berkeley', 'UCB', 'Berkeley'], kind: 1 },
  { name: 'Georgia Institute of Technology', aliases: ['Georgia Tech', 'GT'], kind: 1 },
  { name: 'Indiana Institute of Technology', aliases: ['IIT'], kind: 1 },
  { name: 'Indian Institute of Technology, Madras', aliases: [], kind: 3 },
  { name: 'CUNY Brooklyn College', aliases: ['Brooklyn'], kind: 1 },
  { name: 'Arkansas Tech University', aliases: ['Tech'], kind: 1 },
  { name: 'Louisiana Tech University', aliases: ['Tech'], kind: 1 },
  { name: 'Garrett College', aliases: ['GCC'], kind: 2 },
  { name: 'Massachusetts Institute of Technology', aliases: [], kind: 1 },
  { name: 'University of Michigan - Ann Arbor', aliases: ['UMich', 'Michigan', 'U of M'], kind: 1 },
  { name: 'University of Michigan - Dearborn', aliases: [], kind: 1 },
]);
const isSchool = (t: string) => schools.lookup(t);

describe('titles', () => {
  it('reads families and seniority', () => {
    const r = readTitle('Senior Software Engineer');
    expect(r.families).toContain('engineering');
    expect(r.seniority).toBe('senior');
  });
  it('tells a club founder from a company founder', () => {
    expect(readTitle('Founder', 'Berkeley Fintech Club').founder).toBe(false);
    expect(readTitle('Founder', 'Berkeley Hackers').founder).toBe(false);
    expect(readTitle('Co-founder', 'Knowlify').founder).toBe(true);
  });
  it('keeps founding engineers out of founders', () => {
    const r = readTitle('Founding Engineer');
    expect(r.founder).toBe(false);
    expect(r.earlyEmployee).toBe(true);
    expect(r.families).toContain('engineering');
  });
  it('reads a bare class year as a student', () => {
    expect(readTitle('Senior').seniority).toBe('student');
    expect(readTitle('Rising Junior').status).toBe('student');
  });
  it('keeps every reading of an ambiguous token', () => {
    expect(readTitle('PM').maybe).toContain('finance');
  });
  it('reads founders in other languages', () => {
    expect(readTitle('Fundadora').founder).toBe(true);
    expect(readTitle('Gründer').founder).toBe(true);
  });
  it('gives no level to a part that names no role', () => {
    expect(readTitle('Hackathon Winner').seniority).toBeUndefined();
  });
});

describe('headline', () => {
  it('reads a dense founder headline', () => {
    const h = readHeadline(
      "Co-founder & CTO @ Knowlify (YC S25) | ex-Stripe | CS @ Georgia Tech '27",
      isSchool,
    );
    expect(h.roles[0]).toMatchObject({ org: 'Knowlify', current: true });
    expect(h.roles[0]!.read.founder).toBe(true);
    expect(h.yc[0]).toMatchObject({ org: 'Knowlify', batch: 'S25' });
    expect(h.roles.find((r) => r.org === 'Stripe')?.current).toBe(false);
    expect(h.schools[0]).toMatchObject({
      name: 'Georgia Institute of Technology',
      gradYear: 2027,
      field: 'CS',
    });
  });
  it('normalizes batches', () => {
    expect(canonicalBatch('Winter 2026')).toBe('W26');
    expect(canonicalBatch("F'24")).toBe('F24');
    expect(canonicalBatch('P26')).toBe('X26');
    expect(canonicalBatch('Spring 2026')).toBe('X26');
  });
  it('does not read skills or mission lines as roles', () => {
    const h = readHeadline('Python, SQL, NLP, Deep Learning | Helping founders scale', isSchool);
    expect(h.roles).toHaveLength(0);
  });
  it('does not read "Head of X" as an org', () => {
    const h = readHeadline('DurHack Head of Sponsorship', isSchool);
    expect(h.roles.every((r) => r.org !== 'Sponsorship')).toBe(true);
  });
  it('does not read "at scale" as an employer', () => {
    const h = readHeadline('Building AI systems at Scale', isSchool);
    expect(h.roles.every((r) => r.org !== 'Scale')).toBe(true);
  });
  it('peels the role off a past org', () => {
    const h = readHeadline('Ex-HSBC Analyst', isSchool);
    expect(h.roles[0]).toMatchObject({ org: 'HSBC', title: 'Analyst', current: false });
  });
  it('reads list items one by one', () => {
    const h = readHeadline('Prev: Microsoft, Yahoo, SAP, MIT', isSchool);
    expect(h.schools.map((s) => s.name)).toContain('Massachusetts Institute of Technology');
  });
  it('marks "Building X" founders as weak', () => {
    const h = readHeadline('Building Knowlify', isSchool);
    expect(h.roles[0]).toMatchObject({ org: 'Knowlify', weak: true });
    expect(readHeadline('Building products with human talent', isSchool).roles).toHaveLength(0);
  });
});

describe('schools', () => {
  it('drops nicknames two schools share and short unknown nicknames', () => {
    expect(isSchool('Tech')).toBeUndefined();
    expect(isSchool('GCC')).toBeUndefined();
    expect(isSchool('Cal')).toBe('University of California, Berkeley');
  });
  it('reads IIT campuses by their acronym', () => {
    expect(isSchool('IIT Madras')).toBe('Indian Institute of Technology, Madras');
  });
  it('gives a multi-campus base name to the main campus', () => {
    expect(isSchool('University of Michigan')).toBe('University of Michigan - Ann Arbor');
  });
  it('does not read Brooklyn Tech as Brooklyn College', () => {
    expect(readHeadline('Senior @ Brooklyn Technical High School', isSchool).schools[0]?.name).not.toBe(
      'CUNY Brooklyn College',
    );
  });
});

describe('companies', () => {
  it('keys spellings of one company together, and never substrings', () => {
    expect(orgKey('Stripe, Inc.')).toBe('stripe');
    expect(orgKey('Notion Labs')).toBe('notion');
    expect(orgKey('Box')).not.toBe(orgKey('Dropbox'));
    expect(orgKey('Stealth')).toBe('');
  });
  it('expands a parent to its subsidiaries but not the reverse', () => {
    expect(keysFor('Meta')).toContain('instagram');
    expect(keysFor('Instagram')).toEqual(['instagram']);
  });
  it('reads kinds', () => {
    expect(kindOfOrg('Citadel')).toBe('hedge_fund');
    expect(kindOfOrg('Berkeley Fintech Club')).toBe('student_org');
    expect(kindOfOrg('Sequoia Capital')).toBe('vc_firm');
  });
  it('grades YC matches by evidence', () => {
    const idx = buildFactsIndex([
      { key: 'knowlify', name: 'Knowlify', ycBatch: 'S25', source: 'yc' },
      { key: 'here', name: 'Here', ycBatch: 'W22', ambiguousName: true, source: 'yc' },
      { key: 'meta', name: 'Meta', ycBatch: 'S13', teamSize: 3, ambiguousName: true, source: 'yc' },
      { key: 'ashby', name: 'Ashby', ycBatch: 'W19', formerNames: ['Motion'], source: 'yc' },
    ]);
    expect(matchFacts('Knowlify', idx, { badgeBatch: 'S25' })?.confidence).toBe('strong');
    expect(matchFacts('Knowlify', idx)?.confidence).toBe('medium');
    expect(matchFacts('Here', idx)?.confidence).toBe('weak');
    expect(matchFacts('Knowlify', idx, { badgeBatch: 'W24' })?.confidence).toBe('weak');
    expect(matchFacts('Meta', idx)).toBeUndefined();
    expect(matchFacts('Motion', idx)).toBeUndefined();
  });
  it('labels stages from team size as estimates', () => {
    expect(stageOf({ key: 'a', name: 'A', teamSize: 8, source: 'yc' })).toEqual({
      stage: 'seed',
      estimated: true,
    });
    expect(stageOf({ key: 'a', name: 'A', ycStatus: 'Acquired', source: 'yc' })?.estimated).toBe(false);
  });
});

import { buildPlaceIndex } from '../search/places';
import { PLACES_DATA } from '../search/places.data';

describe('places', () => {
  const p = buildPlaceIndex(PLACES_DATA);
  it('reads LinkedIn locations into metros', () => {
    expect(p.read('San Francisco Bay Area')?.metro).toBe('sf_bay');
    expect(p.read('Fremont, California, United States')?.metro).toBe('sf_bay');
    expect(p.read('New York, New York, United States')?.metro).toBe('nyc');
    expect(p.read('Bengaluru, Karnataka, India')?.metro).toBe('bangalore');
    expect(p.read('Cambridge, Massachusetts, United States')?.metro).toBe('boston');
    expect(p.read('United States')).toEqual({ country: 'US', remote: undefined });
  });
  it('reads what students say', () => {
    expect(p.target('SF')?.metro).toBe('sf_bay');
    expect(p.target('the bay')?.metro).toBe('sf_bay');
    expect(p.target('NYC')?.metro).toBe('nyc');
    expect(p.target('India')?.country).toBe('IN');
    expect(p.target('California')?.region).toBe('california');
  });
  it('answers yes, no or unknown', () => {
    const sf = p.target('SF')!;
    expect(p.matches(p.read('Palo Alto, California, United States'), sf)).toBe('yes');
    expect(p.matches(p.read('Austin, Texas, United States'), sf)).toBe('no');
    expect(p.matches(p.read('United States'), sf)).toBe('unknown');
    expect(p.matches(p.read('London, England, United Kingdom'), sf)).toBe('no');
    expect(p.matches(undefined, sf)).toBe('unknown');
    expect(p.matches(p.read('Oakland, California, United States'), p.target('California')!)).toBe('yes');
  });
});

describe('a title has the words asked for, in their order and close together', () => {
  it('matches the title, with a word or two between', () => {
    for (const [t, q] of [
      ['Senior Product Manager, Payments', 'product manager'],
      ['Software Development Engineer', 'software engineer'],
      ['Venture Partner, Europe', 'venture partner'],
      ['Senior Staff Software Engineer', 'software engineer'],
      ['Head of Growth', 'head of growth'],
      ['Product Managers', 'product manager'],
    ] as const)
      expect([t, titleHasWords(t, q)]).toEqual([t, true]);
  });
  it('the same words far apart or the other way round are another title', () => {
    for (const [t, q] of [
      ['Trusted design partner to top VC firms, founders, and marketing leaders.', 'venture partner'],
      ['Partner success for venture studios', 'venture partner'],
      ['Manager of the product photography studio and its design team', 'product manager'],
      ['Front Desk Associate', 'investment associate'],
      ['Product Marketing Manager', 'product manager'],
      ['Venture & Growth Partner', 'venture partner'],
    ] as const)
      expect([t, titleHasWords(t, q)]).toEqual([t, false]);
  });
});

describe('a field word is the job only when the title is the field', () => {
  const read = (t: string, o?: string) => readTitle(t, o);
  it('a job said as a job is that kind of work', () => {
    for (const [t, f] of [
      ['Recruiter', 'people_recruiting'],
      ['Head of Talent', 'people_recruiting'],
      ['Talent Acquisition Partner', 'people_recruiting'],
      ['Product Manager', 'product'],
      ['Director of Product', 'product'],
      ['Product', 'product'],
      ['Product & Growth', 'product'],
      ['Product & Growth', 'growth'],
      ['Head of Growth', 'growth'],
      ['Product Designer', 'design'],
      ['Design Lead', 'design'],
      ['Design', 'design'],
      ['Data Scientist', 'data_ml'],
      ['Machine Learning Engineer', 'data_ml'],
      ['AI', 'data_ml'],
      ['Research Scientist', 'research'],
      ['Operations', 'operations'],
      ['Marketing Manager', 'marketing'],
      ['Software Engineer', 'engineering'],
      ['Engineering', 'engineering'],
    ] as const)
      expect(read(t).families, t).toContain(f);
  });
  it('a line that only uses the word is a maybe, for a reader to settle', () => {
    for (const [t, f] of [
      ['Helping Non-Technical Founders Build Their First Product', 'product'],
      ['It is not your people. It is your culture.', 'people_recruiting'],
      ['Most people are one relationship away from a completely different life', 'people_recruiting'],
      ['Exploring the depth of design thinking in all aspects of life', 'design'],
      ['I curate and deploy Adaptive Design Teams for growing startups', 'design'],
      ['Conversational AI SMS that turns dead leads into booked jobs', 'data_ml'],
      ['Turning thoughts into words people remember', 'people_recruiting'],
      ['💰 Get marketing help, handpicked for you', 'marketing'],
      ['I help Marketing Agencies Book More Meetings', 'marketing'],
    ] as const) {
      const r = read(t);
      expect(r.families, t).not.toContain(f);
      expect(r.maybe, t).toContain(f);
    }
  });
  it('a campus lead or ambassador is not a recruiter', () => {
    for (const t of ['Campus Lead', 'Campus Leader', 'Campus Ambassador']) {
      expect(read(t, 'OpenAI').families, t).not.toContain('people_recruiting');
      expect(read(t, 'OpenAI').maybe, t).not.toContain('people_recruiting');
    }
    expect(read('Campus Recruiter', 'Microsoft').families).toContain('people_recruiting');
  });
  it('an early employee with any field in the title is not a founder', () => {
    expect(read('Founding Quantum Engineer').founder).toBe(false);
    expect(read('Founding Engineer').founder).toBe(false);
    expect(read('Founder').founder).toBe(true);
  });
});

describe('a job at an investing firm is an investing job, when the title alone does not say so', () => {
  const fam = (t: string, o?: string) => readTitle(t, o).families;
  it('partner, principal, associate and analyst at a fund are investing', () => {
    for (const [t, o] of [
      ['Partner', 'Gradient Ventures'],
      ['Principal', 'Balderton Capital'],
      ['Associate', 'Sequoia Capital'],
      ['Analyst', 'Lightspeed Venture Partners'],
      ['Vice President', 'General Catalyst Ventures'],
      ['Managing Partner', 'Lyra Capital'],
      ['Founder & General Partner', 'Cove Fund'],
      ['Investments', 'Aum Ventures'],
      ['Building & investing', 'NPU Ventures'],
    ] as const)
      expect(fam(t, o), `${t} at ${o}`).toContain('investing');
  });
  it('a job at a fund that is not plainly an investing job is a maybe, for a reader to settle', () => {
    for (const [t, o] of [
      ['Platform', 'Cherry Ventures'],
      ['Dealflow Partner', 'LvlUp Ventures'],
      ['Business Associate', 'Attribute Global Ventures'],
      ['Venture Scout', 'First Momentum Ventures'],
      ['Fellow', 'Chai Ventures'],
      ['Partner', 'Savoia Investments'],
    ] as const) {
      const r = readTitle(t, o);
      expect(r.families, `${t} at ${o}`).not.toContain('investing');
      expect(r.maybe, `${t} at ${o}`).toContain('investing');
    }
  });
  it('the same titles elsewhere are not, and neither is another job at a fund', () => {
    for (const [t, o] of [
      ['Partner', 'McKinsey'],
      ['Associate', 'Capital One'],
      ['Analyst', 'Bank of America'],
      ['Associate', 'Latham & Watkins LLP'],
      ['Partner', undefined],
      ['Software Engineer', 'Sequoia Capital'],
      ['Recruiter', 'Accel Ventures'],
      ['Principal', 'Lincoln High School'],
    ] as const)
      expect(fam(t, o), `${t} at ${o}`).not.toContain('investing');
  });
  it('a title that says they invest is an investor, in the many ways people write it', () => {
    for (const t of [
      'Investor',
      'Angel Investor',
      'Founder/Investor',
      'Early Stage Investor',
      'Health Investor',
      'Investor in AI',
      'Physician, Angel Investor',
      'Tech Entrepreneur, Startup Coach and Angel Investor',
      'Venture Capitalist',
      'General Partner',
      'Venture Partner',
      'VC',
      'Early stage VC',
      'Deep Tech VC',
      'Venture Capital',
      'Venture Capital & AI',
      'Venture Capital Investor',
      'Venture Capital Analyst',
      'Investment Associate',
      'Head of Investments',
      'Investments',
      'Investing',
      'investing in ambitious founders',
      'Managing Partner, Fox & Chester Ventures',
      'Partner at Pear VC',
    ])
      expect(readInvesting(t), t).toBe('sure');
  });
  it('a title that only mentions investors, or serves them, is not an investor', () => {
    for (const t of [
      'Investor Relations Manager',
      'Empowering Real Estate Companies to Raise Investor Capital',
      'Fundraising advisor getting seed founders investor-ready and in front of the right investors',
      'I give founders investor-ready financials',
      'Startup & VC Lawyer',
      'Startup & Venture Capital Lawyer',
      'Advisor to Founders & Investors',
      'Engineering & Executive Search for VC-Backed AI Startups',
      'SaaS PE & VC-Backed Growth Leader',
      'vc backed ai startup',
      'Backed by incredible investors',
      'Trusted design partner to top VC firms, founders, and marketing leaders.',
      'London Venture Capital Network',
      'President of Girls into Venture Capital',
      'Girls Into VC Fellow',
      'Investment Banking Analyst',
      'Aspiring PE',
      'Passionate about Venture Capital, Market Research & GTM Strategy',
      'Helping you return from your AI investment',
      'CEO & 4x Managing Partner',
      'Managing Partner',
      'Launch Partner for Seed-Stage Startups',
      'Senior Growth Partner',
      'Front Desk Associate',
      'Boy Scout Troop Leader',
    ])
      expect(readInvesting(t), t).toBeUndefined();
    expect(readInvesting('Investment Banking Analyst', 'SKV Capital')).toBeUndefined();
    expect(readInvesting('Marketing Coordinator', 'Horizon Angel Investors')).toBeUndefined();
    expect(readInvesting('Engineering', 'Helium Ventures', true)).toBeUndefined();
    expect(readInvesting('Hedge Fund Summer Analyst', 'Schonfeld')).toBeUndefined();
  });
  it('a title that names the industry and not the job is a maybe', () => {
    for (const t of [
      'VC Scout',
      'A16z Speedrun Scout',
      'Bonfire VC',
      'Angel',
      'Building in VC',
      'Agentic Systems & Early-Stage Venture Capital',
    ])
      expect(readInvesting(t), t).toBe('maybe');
    expect(readInvesting('Biotech Venture Capital & Life Sciences Consultant')).toBe('maybe');
  });
  it('a title that already says it stays as it was read', () => {
    expect(fam('General Partner', 'Cove Fund')).toEqual(['investing']);
    expect(fam('Investor', 'Cove Fund')).toEqual(['investing']);
  });
});

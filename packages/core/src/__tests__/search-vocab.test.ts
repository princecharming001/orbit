import { describe, expect, it } from 'vitest';
import { buildFactsIndex, keysFor, kindOfOrg, matchFacts, orgKey, stageOf } from '../search/companies';
import { canonicalBatch, readHeadline } from '../search/headline';
import { buildSchoolIndex } from '../search/schools';
import { readTitle } from '../search/titles';

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

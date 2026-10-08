import { describe, expect, it } from 'vitest';
import { generateDraft } from '../drafts/templates';
import {
  extractKeywords,
  heuristicResumeParse,
  resumeOneLiner,
  resumeSectionOf,
  summarySentence,
} from '../resume/parse';
import { defaultStyleCard } from '../style/card';
import { RESUMES } from './fixtures/resumes';

describe('resume corpus (12 layouts)', () => {
  for (const r of RESUMES) {
    it(r.name, () => {
      const facets = heuristicResumeParse(r.text, 'r');
      const all = facets.map((f) => [f.text, f.title ?? '', f.organizationName ?? ''].join(' | ')).join('\n');
      for (const a of r.absent ?? []) expect(all, `"${a}" leaked into a facet`).not.toContain(a);
      const summaries = facets.filter((f) => f.kind === 'summary');
      if (r.summary === undefined) expect(summaries, 'no summary without a summary section').toHaveLength(0);
      else {
        expect(summaries).toHaveLength(1);
        if (typeof r.summary === 'string') expect(summaries[0]!.text).toBe(r.summary);
        else expect(summaries[0]!.text).toMatch(r.summary);
      }
      const roles = facets.filter((f) => f.kind === 'experience' || f.kind === 'project');
      for (const want of r.experiences) {
        const hit = roles.find((f) => want.title.test(f.title ?? '') && f.organizationName === want.org);
        expect(hit, `${want.title} at ${want.org}\n${JSON.stringify(roles, null, 1)}`).toBeDefined();
        if (want.start) expect(hit!.startDate).toBe(want.start);
        if (want.end) expect(hit!.endDate).toBe(want.end);
      }
      for (const f of facets) {
        for (const v of [f.title, f.organizationName])
          expect(v ?? '', `title/org must not be a date or place: ${v}`).not.toMatch(
            /^(present|current|[A-Z]{2}|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\.? \d{4})$/i,
          );
      }
      if (r.education) {
        const ed = facets.find(
          (f) => f.kind === 'education' && r.education!.org.test(f.organizationName ?? ''),
        );
        expect(ed, JSON.stringify(facets.filter((f) => f.kind === 'education'))).toBeDefined();
        if (r.education.title) expect(ed!.title ?? '').toMatch(r.education.title);
        if (r.education.end) expect(ed!.endDate).toBe(r.education.end);
      }
      if (r.skills) {
        const kw = facets.filter((f) => f.kind === 'skill_group').flatMap((f) => f.keywords);
        for (const s of r.skills) expect(kw).toContain(s);
      }
      for (const pr of r.projects ?? []) {
        const hit = facets.find((f) => f.kind === 'project' && pr.title.test(f.title ?? ''));
        expect(hit, JSON.stringify(facets.filter((f) => f.kind === 'project'))).toBeDefined();
        for (const k of pr.keywords) expect(hit!.keywords).toContain(k);
        expect(hit!.organizationName).toBeUndefined();
      }
      if (r.interests) expect(facets.some((f) => f.kind === 'interest')).toBe(true);
    });
  }
});

describe('resume section headings (NRC-07)', () => {
  it('recognises headings with extra words and ignores neutral sections', () => {
    expect(resumeSectionOf('RELEVANT EXPERIENCE')).toBe('experience');
    expect(resumeSectionOf('LEADERSHIP & ACTIVITIES')).toBe('experience');
    expect(resumeSectionOf('EDUCATION & HONORS')).toBe('education');
    expect(resumeSectionOf('HONORS & AWARDS')).toBe('other');
    expect(resumeSectionOf('ADDITIONAL INFORMATION')).toBe('other');
    expect(resumeSectionOf('TECHNICAL SKILLS:')).toBe('skills');
    expect(resumeSectionOf('Professional Summary')).toBe('summary');
    expect(resumeSectionOf('Built a thing for the experience team.')).toBeUndefined();
    expect(resumeSectionOf('• Experience with React')).toBeUndefined();
  });
});

describe('resume summary sentence (NRC-01)', () => {
  it('is a clean third-person sentence or nothing', () => {
    expect(summarySentence('ravi.jain@umich.edu | (734) 555-0192', 'Ravi Jain')).toBeUndefined();
    expect(summarySentence('I am a junior studying CS.', 'Ravi')).toBe('Ravi is a junior studying CS.');
    expect(summarySentence('Seeking a PM internship for summer 2026.', 'Ravi')).toBe(
      'Ravi is seeking a PM internship for summer 2026.',
    );
    expect(summarySentence('My goal is to work in fintech.', 'Ravi')).toBeUndefined();
  });
  it('never treats the contact header as the summary', () => {
    const facets = heuristicResumeParse(
      'Ravi Jain\nravi.jain@umich.edu | (734) 555-0192 | linkedin.com/in/ravijain\n\nEXPERIENCE\nStripe, Product Intern, Jun 2025 - Aug 2025\n• Shipped a thing',
      'r',
    );
    expect(facets.find((f) => f.kind === 'summary')).toBeUndefined();
  });
});

describe('resume one-liner (DQ-04)', () => {
  it('rewrites third-person and model-written summaries into one clean clause', () => {
    const cases: [string, string | undefined][] = [
      [
        'Alex Rivera is a junior at Cornell University studying Computer Science. He has interned at Brex, where he built a reconciliation service in Go, and he is interested in payments.',
        'a junior at Cornell University studying Computer Science',
      ],
      [
        'Alex Rivera is a junior at Cornell studying CS and he is interested in payments.',
        'a junior at Cornell studying CS',
      ],
      [
        'A junior at Cornell studying CS, Alex Rivera is interested in payments and developer tools.',
        'a junior at Cornell studying CS who is interested in payments and developer tools',
      ],
      [
        'This candidate is a motivated Cornell CS junior who is passionate about payments.',
        'a Cornell CS junior who is interested in payments',
      ],
      [
        'Motivated, detail-oriented junior studying economics at Michigan.',
        'a junior studying economics at Michigan',
      ],
      ['Alex Rivera alex.rivera@cornell.edu | (607) 555-0199 | linkedin.com/in/alexrivera', undefined],
      // not an "a/an ..." description: the template composes the clause from school, year and major instead
      [
        'Objective: To obtain a summer 2027 software engineering internship where I can apply my skills.',
        undefined,
      ],
      [
        'Alex Rivera is a junior at Cornell University studying Computer Science with a minor in Information Science and a deep interest in payments infrastructure.',
        undefined,
      ],
    ];
    for (const [input, want] of cases) expect(resumeOneLiner(input)).toBe(want);
    expect(summarySentence('Objective: To obtain a PM internship.', 'Alex')).toBe(
      'Alex is seeking a PM internship.',
    );
  });
});

describe('resume summary in outreach (NRC-01)', () => {
  it('never puts contact details into a draft', () => {
    for (const r of RESUMES) {
      const facets = heuristicResumeParse(r.text, 'r');
      const summary = facets.find((f) => f.kind === 'summary')?.text;
      // the same transform apps/web/src/engine/brief.ts applies to build user.oneLiner
      const oneLiner = resumeOneLiner(summary);
      const d = generateDraft({
        user: {
          firstName: 'Ravi',
          lastName: 'Jain',
          fullName: 'Ravi Jain',
          school: 'University of Michigan',
          gradYear: 2027,
          majors: ['Computer Science'],
          cycleLabel: 'Summer 2026 internship',
          targetFunctions: ['pm'],
          timezone: 'America/Detroit',
          oneLiner,
        },
        styleCard: defaultStyleCard('warm', 'Ravi'),
        person: {
          firstName: 'Priya',
          lastName: 'Patel',
          fullName: 'Priya Patel',
          title: 'Product Manager',
          org: 'Figma',
          isAlumni: true,
          relationshipType: 'alumni',
          strength: 0.4,
        },
        facts: [],
        kind: 'outreach',
        channel: 'gmail',
        now: new Date('2026-10-06T14:00:00Z'),
        seed: r.name,
      });
      expect(d.body).not.toMatch(/@|\d{3}[-.)\s]\s?\d{3}[-.\s]\d{4}|linkedin\.com|github\.com|\|/);
      expect(d.body).not.toMatch(/EXPERIENCE|EDUCATION|SKILLS/);
    }
  });
});

describe('resume keywords (NRC-22)', () => {
  it('dates and sentence punctuation are not keywords', () => {
    const k = extractKeywords(
      'June 2024 - August 2024. Present. Led acquisition. Built node.js services. Worked on acquisition models.',
    );
    for (const w of ['june', 'august', 'present', 'acquisition.', 'services.']) expect(k).not.toContain(w);
    expect(k).toEqual(expect.arrayContaining(['acquisition', 'node.js', 'services']));
  });
});

describe('one-line entries and places (UX round 1)', () => {
  it('reads "Club — Role (dates). What I did." lines as separate entries, and a bare "Detroit MI" as a place', () => {
    const text = `Jamie Park
EXPERIENCE
Michigan Finance Club — VP Education (2025-present). Led weekly technical training for 40 members.
Wolverine Consulting Group — Analyst (2024-2025). Market sizing for a Detroit EV supplier.
Ann Arbor SPARK — Summer Intern (2025). Built financial models for 3 seed-stage startups.
Summer Analyst Intern, Comerica Bank, Detroit MI — Jun 2026 to Aug 2026
- Built a DCF model for a mid-market manufacturing client
`;
    const xs = heuristicResumeParse(text, 'r').filter((f) => f.kind === 'experience');
    expect(xs.map((f) => [f.organizationName, f.title])).toEqual([
      ['Michigan Finance Club', 'VP Education'],
      ['Wolverine Consulting Group', 'Analyst'],
      ['Ann Arbor SPARK', 'Summer Intern'],
      ['Comerica Bank', 'Summer Analyst Intern'],
    ]);
    expect(xs[0]!.text).toBe('Led weekly technical training for 40 members.');
    for (const f of xs) expect(`${f.title} ${f.text}`).not.toMatch(/\(\s*,\s*\)|Detroit MI/);
  });

  it('keeps "Detroit, MI" out of the role, reads middle-dot bullets, drops stray full stops, and splits one-line activities', () => {
    const text = `Sam Patel
Education
University of Michigan, Ross School of Business .
BBA in Business Administration, May 2028
Experience
Comerica Bank
Summer Analyst Intern, Detroit, MI    Jun 2025 – Aug 2025
· Built a DCF model for a middle-market
client; automated weekly covenant reporting.
Activities
Treasurer, Club soccer
Black Business Students Association
`;
    const fs = heuristicResumeParse(text, 'r');
    const edu = fs.find((f) => f.kind === 'education')!;
    expect(edu.organizationName).toBe('University of Michigan, Ross School of Business');
    expect(edu.text).not.toMatch(/\s\./);
    const job = fs.find((f) => f.organizationName === 'Comerica Bank')!;
    expect(job.title).toBe('Summer Analyst Intern');
    expect(job.text).toBe(
      'Built a DCF model for a middle-market client; automated weekly covenant reporting.',
    );
    const acts = fs.filter((f) => f.kind === 'experience' && f.organizationName !== 'Comerica Bank');
    expect(acts.map((f) => [f.title, f.organizationName])).toEqual([
      ['Treasurer', 'Club soccer'],
      [undefined, 'Black Business Students Association'],
    ]);
  });
});

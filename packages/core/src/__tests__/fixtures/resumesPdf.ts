/**
 * Resumes as PDF-to-text and Word exports really hand them over: two columns run together with wide gaps, tabs,
 * headings in capitals with the section's first line beside them, letter-spaced headings, rules after headings and
 * headings Orbit's vocabulary does not know. Each says what the parser must keep, what the student's school, majors
 * and year are, and which names must never be read as the school.
 */
import type { ResumeFixture } from './resumes';

export interface PdfResumeFixture extends ResumeFixture {
  profile: { school?: string; degree?: string; majors?: string[]; graduationYear?: number };
  /** names that must never be an education line's place (employers) */
  notSchool?: string[];
}

export const PDF_RESUMES: PdfResumeFixture[] = [
  {
    name: 'two columns: the Experience heading shares a line with the first employer (the Amma Health case)',
    text: `ANISH KUMAR
anish.k@berkeley.edu   (510) 555-0134   linkedin.com/in/anishk

EDUCATION   University of California, Berkeley   Berkeley, CA
B.S. in Electrical Engineering and Computer Science   Expected May 2027
Relevant Coursework: Data Structures, Machine Learning, Databases

EXPERIENCE   Amma Health Inc.   San Francisco, CA
Software Engineering Intern   Jun 2025 – Aug 2025
• Built a FHIR ingestion pipeline that cut onboarding time for new clinics from 3 weeks to 4 days
• Wrote integration tests for 12 EHR vendors
Berkeley Launchpad   Berkeley, CA
Machine Learning Researcher   Jan 2024 – Present
• Trained retrieval models for a campus Q&A assistant used by 2,000 students

SKILLS   Python, TypeScript, PyTorch, Postgres
`,
    experiences: [
      {
        title: /^Software Engineering Intern$/,
        org: 'Amma Health Inc.',
        start: '2025-06-01',
        end: '2025-08-01',
      },
      { title: /^Machine Learning Researcher$/, org: 'Berkeley Launchpad', start: '2024-01-01' },
    ],
    education: {
      org: /^University of California, Berkeley$/,
      title: /^B\.S\. in Electrical Engineering and Computer Science$/,
      end: '2027-05-01',
    },
    skills: ['python', 'typescript', 'pytorch', 'postgres'],
    profile: {
      school: 'University of California, Berkeley',
      degree: 'B.S.',
      majors: ['Electrical Engineering', 'Computer Science'],
      graduationYear: 2027,
    },
    notSchool: ['Amma Health Inc.', 'Amma Health', 'Berkeley Launchpad'],
    absent: ['anish.k@berkeley.edu', '555-0134'],
  },
  {
    name: 'heading, school and date on one line: "EDUCATION   University of X   May 2026"',
    text: `Grace Kim
gkim@umich.edu | 734-555-0177

EDUCATION   University of Michigan   May 2026
Bachelor of Business Administration, Concentration in Finance
GPA: 3.9

WORK EXPERIENCE   J.P. Morgan   New York, NY
Investment Banking Summer Analyst   Jun 2025 – Aug 2025
• Built merger models for two healthcare services transactions
`,
    experiences: [{ title: /^Investment Banking Summer Analyst$/, org: 'J.P. Morgan', start: '2025-06-01' }],
    education: {
      org: /^University of Michigan$/,
      title: /^Bachelor of Business Administration/,
      end: '2026-05-01',
    },
    profile: {
      school: 'University of Michigan',
      degree: 'Bachelor of Business Administration',
      graduationYear: 2026,
    },
    notSchool: ['J.P. Morgan'],
    absent: ['gkim@umich.edu'],
  },
  {
    name: 'tab-separated Word export',
    text: `Luis Herrera
luis.herrera@utexas.edu\t512-555-0160

EDUCATION
The University of Texas at Austin\tAustin, TX
B.S. Mathematics\tMay 2027

EXPERIENCE
Bloomberg\tNew York, NY
Software Engineer Intern\tMay 2025 – Aug 2025
• Built a latency dashboard for the market data feed
Texas Convergent\tAustin, TX
Project Lead\tSep 2024 – Present
• Led 6 students building a course planner
`,
    experiences: [
      { title: /^Software Engineer Intern$/, org: 'Bloomberg', start: '2025-05-01' },
      { title: /^Project Lead$/, org: 'Texas Convergent', start: '2024-09-01' },
    ],
    education: { org: /University of Texas at Austin$/, title: /^B\.S\. Mathematics$/, end: '2027-05-01' },
    profile: {
      school: 'The University of Texas at Austin',
      degree: 'B.S.',
      majors: ['Mathematics'],
      graduationYear: 2027,
    },
    notSchool: ['Bloomberg', 'Texas Convergent'],
    absent: ['luis.herrera@utexas.edu'],
  },
  {
    name: 'letter-spaced headings and rules after them',
    text: `PRIYA NAIR
priya.nair@cmu.edu  •  412-555-0102

E D U C A T I O N
Carnegie Mellon University   Pittsburgh, PA
B.S. Information Systems, Minor in Statistics   Dec 2026

E X P E R I E N C E  ________________________
Duolingo   Pittsburgh, PA
Product Management Intern   May 2025 – Aug 2025
• Ran 4 experiments on the leaderboard that lifted weekly active learners 2%

S K I L L S
SQL, Figma, Amplitude
`,
    experiences: [{ title: /^Product Management Intern$/, org: 'Duolingo', start: '2025-05-01' }],
    education: {
      org: /^Carnegie Mellon University$/,
      title: /^B\.S\. Information Systems/,
      end: '2026-12-01',
    },
    skills: ['sql', 'figma', 'amplitude'],
    profile: {
      school: 'Carnegie Mellon University',
      degree: 'B.S.',
      majors: ['Information Systems'],
      graduationYear: 2026,
    },
    notSchool: ['Duolingo'],
    absent: ['priya.nair@cmu.edu', '____'],
  },
  {
    name: 'a heading the vocabulary does not know, in title case',
    text: `Noah Feldman
nfeldman@wharton.upenn.edu

Education
University of Pennsylvania, The Wharton School
B.S. in Economics, Concentrations in Finance and Management   May 2027

Entrepreneurial Experience
Lumen Labs   Philadelphia, PA
Co-Founder   Jan 2025 – Present
• Built a study-group matching app with 1,200 weekly users

Work experience
Citadel   Chicago, IL
Quantitative Research Intern   Jun 2025 – Aug 2025
• Backtested intraday signals on 10 years of futures data
`,
    experiences: [
      { title: /^Co-Founder$/, org: 'Lumen Labs', start: '2025-01-01' },
      { title: /^Quantitative Research Intern$/, org: 'Citadel', start: '2025-06-01' },
    ],
    education: {
      org: /^University of Pennsylvania, The Wharton School$/,
      title: /^B\.S\. in Economics/,
      end: '2027-05-01',
    },
    profile: {
      school: 'University of Pennsylvania',
      degree: 'B.S.',
      majors: ['Economics'],
      graduationYear: 2027,
    },
    notSchool: ['Lumen Labs', 'Citadel'],
    absent: ['nfeldman@wharton.upenn.edu'],
  },
  {
    name: 'employers under an Education heading the export lost (no Experience heading at all)',
    text: `Sam Ortiz
sam.ortiz@nyu.edu

EDUCATION
New York University   New York, NY
B.A. Computer Science   May 2026
Amma Health Inc.   Remote
Software Engineer Intern   Jun 2024 – Aug 2024
• Migrated a scheduling service to TypeScript
`,
    experiences: [{ title: /^Software Engineer Intern$/, org: 'Amma Health Inc.', start: '2024-06-01' }],
    education: { org: /^New York University$/, title: /^B\.A\. Computer Science$/, end: '2026-05-01' },
    profile: {
      school: 'New York University',
      degree: 'B.A.',
      majors: ['Computer Science'],
      graduationYear: 2026,
    },
    notSchool: ['Amma Health Inc.'],
    absent: ['sam.ortiz@nyu.edu'],
  },
  {
    name: 'ALL CAPS, experience first, school without a school word, and a high school',
    text: `KAREN LIU
KLIU@MIT.EDU | 617-555-0199

PROFESSIONAL EXPERIENCE
MCKINSEY & COMPANY   BOSTON, MA
BUSINESS ANALYST INTERN   JUN 2025 – AUG 2025
• Sized the US market for at-home diagnostics for a medtech client

EDUCATION
MIT   CAMBRIDGE, MA
S.B. CHEMICAL ENGINEERING   JUN 2026
LEXINGTON HIGH SCHOOL   LEXINGTON, MA
DIPLOMA   JUN 2022
`,
    experiences: [{ title: /^Business Analyst Intern$/i, org: 'McKinsey & Company', start: '2025-06-01' }],
    education: { org: /^MIT$/, title: /^S\.B\. Chemical Engineering$/, end: '2026-06-01' },
    profile: { school: 'MIT', degree: 'S.B.', majors: ['Chemical Engineering'], graduationYear: 2026 },
    notSchool: ['McKinsey & Company'],
    absent: ['KLIU@MIT.EDU'],
  },
  {
    name: 'single column with a degree on the school line, and a double major',
    text: `Ethan Brooks
ebrooks@georgetown.edu | (202) 555-0140

Education
Georgetown University, B.A. in Government and Economics   Expected May 2028

Experience
U.S. Senate Office of Senator Lee   Washington, DC
Legislative Intern   Jan 2025 – May 2025
• Drafted memos on broadband policy for the senator's staff

Leadership
Georgetown Debate Society   Treasurer   Sep 2024 – Present
`,
    experiences: [
      { title: /^Legislative Intern$/, org: 'U.S. Senate Office of Senator Lee', start: '2025-01-01' },
      { title: /^Treasurer$/, org: 'Georgetown Debate Society', start: '2024-09-01' },
    ],
    education: {
      org: /^Georgetown University$/,
      title: /^B\.A\. in Government and Economics$/,
      end: '2028-05-01',
    },
    profile: {
      school: 'Georgetown University',
      degree: 'B.A.',
      majors: ['Government', 'Economics'],
      graduationYear: 2028,
    },
    notSchool: ['U.S. Senate Office of Senator Lee', 'Georgetown Debate Society'],
    absent: ['ebrooks@georgetown.edu'],
  },
  {
    name: 'school without a school word before the degree line',
    text: `Maya Brennan
maya.brennan@wesleyan.edu

EDUCATION
Wesleyan
B.A. Economics, Minor in Data Analysis   May 2027

EXPERIENCE
Brex   San Francisco, CA
Finance Intern   Jun 2025 – Aug 2025
• Automated the month-end accrual workbook
`,
    experiences: [{ title: /^Finance Intern$/, org: 'Brex', start: '2025-06-01' }],
    education: { org: /^Wesleyan$/, title: /^B\.A\. Economics/, end: '2027-05-01' },
    profile: { school: 'Wesleyan', degree: 'B.A.', majors: ['Economics'], graduationYear: 2027 },
    notSchool: ['Brex'],
    absent: ['maya.brennan@wesleyan.edu'],
  },
];

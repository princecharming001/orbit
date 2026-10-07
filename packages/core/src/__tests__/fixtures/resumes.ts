/**
 * Twelve resumes as plain text (the way pdf.js or a .docx export hands them over), in the layouts students
 * actually use. `expect` lists, for each, the summary sentence (or none) and the employer/role pairs the
 * parser must keep together.
 */
export interface ResumeFixture {
  name: string;
  text: string;
  summary?: string | RegExp;
  experiences: { title: RegExp; org: string; start?: string; end?: string }[];
  education?: { org: RegExp; title?: RegExp; end?: string };
  projects?: { title: RegExp; keywords: string[] }[];
  skills?: string[];
  interests?: boolean;
  /** strings that must not appear in any facet (contact details, section names, rules) */
  absent?: string[];
}

export const RESUMES: ResumeFixture[] = [
  {
    name: 'chronological, location on the employer line',
    text: `Ravi Jain
ravi.jain@umich.edu | (734) 555-0192 | linkedin.com/in/ravijain
Ann Arbor, MI

EDUCATION
University of Michigan, Ann Arbor, MI
B.S.E. in Computer Science   Expected May 2027
GPA: 3.8/4.0; Relevant Coursework: Data Structures, Algorithms, Databases

RELEVANT EXPERIENCE
Stripe   San Francisco, CA
Product Management Intern, Payments Onboarding   Jun 2025 – Aug 2025
• Shipped a merchant onboarding checklist used by 4,000 new accounts in the first month
• Ran 12 user interviews and wrote the spec for identity verification retries
Michigan Daily   Ann Arbor, MI
Analyst   Sep 2024 – Present
• Built a dashboard that tracks newsletter retention across 30,000 subscribers

TECHNICAL SKILLS:
Python, SQL, Figma, JIRA

HONORS & AWARDS
Dean's List (all semesters)
ADDITIONAL INFORMATION
Fluent in Hindi
____________________
`,
    experiences: [
      { title: /^Product Management Intern/, org: 'Stripe', start: '2025-06-01', end: '2025-08-01' },
      { title: /^Analyst$/, org: 'Michigan Daily', start: '2024-09-01' },
    ],
    education: {
      org: /^University of Michigan$/,
      title: /^B\.S\.E\. in Computer Science$/,
      end: '2027-05-01',
    },
    skills: ['python', 'sql', 'figma', 'jira'],
    absent: [
      'ravi.jain@umich.edu',
      '555-0192',
      'linkedin.com',
      "Dean's List",
      'HONORS',
      'Fluent in Hindi',
      '____',
    ],
  },
  {
    name: 'two-column export: role, company and dates on separate lines',
    text: `Maya Chen
maya.chen@gatech.edu
(404) 555-0110

Experience
Software Engineering Intern
Datadog
May 2025 - Aug 2025
- Cut p95 latency of the metrics query API by 40% with a caching layer
- Wrote the on-call runbook for the ingestion service

Undergraduate Research Assistant
Georgia Tech Systems Lab
Jan 2024 - May 2025
- Benchmarked three consensus protocols on a 64-node cluster

Education
Georgia Institute of Technology
B.S. Computer Science
Aug 2022 - May 2026

Skills
Languages: Go, Python, C++
Tools: Kubernetes, Grafana
`,
    experiences: [
      { title: /^Software Engineering Intern$/, org: 'Datadog', start: '2025-05-01', end: '2025-08-01' },
      { title: /^Undergraduate Research Assistant$/, org: 'Georgia Tech Systems Lab', start: '2024-01-01' },
    ],
    education: {
      org: /^Georgia Institute of Technology$/,
      title: /^B\.S\. Computer Science$/,
      end: '2026-05-01',
    },
    skills: ['go', 'python', 'c++', 'kubernetes', 'grafana'],
    absent: ['maya.chen@gatech.edu', '555-0110'],
  },
  {
    name: 'finance format in capitals with leadership section',
    text: `JORDAN WELLS
Boston, MA | jwells@bu.edu | 617-555-0144

EDUCATION
BOSTON UNIVERSITY, Questrom School of Business   Boston, MA
Bachelor of Science in Business Administration, Concentration in Finance   May 2026
GPA: 3.7

WORK EXPERIENCE
GOLDMAN SACHS, New York, NY
Summer Analyst, TMT Investment Banking   Jun 2025 – Aug 2025
• Built operating models for two software take-private transactions worth over $2B combined
• Prepared buyer lists and teaser materials for a sell-side process

LEADERSHIP & ACTIVITIES
BU Finance Club, President   Sep 2024 – Present
• Grew membership from 40 to 120 students and ran weekly technical training

SKILLS & INTERESTS
Technical: Excel, PowerPoint, Capital IQ
Interests: Marathon running, chess, jazz piano
`,
    experiences: [
      { title: /^Summer Analyst, TMT Investment Banking$/, org: 'Goldman Sachs', start: '2025-06-01' },
      { title: /^President$/, org: 'BU Finance Club', start: '2024-09-01' },
    ],
    education: {
      org: /^Boston University, Questrom School of Business$/,
      title: /^Bachelor of Science/,
      end: '2026-05-01',
    },
    skills: ['excel', 'powerpoint', 'capital iq'],
    interests: true,
    absent: ['jwells@bu.edu', '617-555-0144'],
  },
  {
    name: 'pipe-separated one-line headers',
    text: `Alex Rivera
alex.rivera@cornell.edu | github.com/arivera

Experience
Google | Software Engineer Intern | May 2024 – Aug 2024
- Built a Spanner-backed quota service handling 50k QPS
Brex | Software Engineering Intern | Jun 2025 – Aug 2025
- Built a reconciliation service in Go

Education
Cornell University | B.S. Computer Science | Aug 2023 – May 2027
`,
    experiences: [
      { title: /^Software Engineer Intern$/, org: 'Google', start: '2024-05-01', end: '2024-08-01' },
      { title: /^Software Engineering Intern$/, org: 'Brex', start: '2025-06-01' },
    ],
    education: { org: /^Cornell University$/, title: /^B\.S\. Computer Science$/, end: '2027-05-01' },
    absent: ['alex.rivera@cornell.edu', 'github.com'],
  },
  {
    name: 'summary section with a noun phrase',
    text: `Sofia Martinez
sofia.m@nyu.edu • 212-555-0175

SUMMARY
Junior studying economics and computer science at NYU, looking for a product analytics internship for summer 2026. Comfortable with SQL and experiment design.

EXPERIENCE
Product Analytics Intern — Duolingo   Summer 2025
• Analyzed an A/B test on streak reminders across 2 million learners

SKILLS
SQL, Python, Tableau
`,
    summary:
      'Sofia Martinez is a junior studying economics and computer science at NYU, looking for a product analytics internship for summer 2026.',
    experiences: [{ title: /^Product Analytics Intern$/, org: 'Duolingo', end: '2025-06-01' }],
    absent: ['sofia.m@nyu.edu', '212-555-0175'],
  },
  {
    name: 'objective section',
    text: `Daniel Okafor
dokafor@umd.edu | (301) 555-0101

OBJECTIVE
To obtain a summer 2026 internship in investment banking where I can apply my modeling skills.

EXPERIENCE
Terrapin Investment Fund, Analyst, Sep 2024 - Present
• Pitched three industrials names; two were added to the portfolio
`,
    summary: 'Daniel Okafor is seeking a summer 2026 internship in investment banking.',
    experiences: [{ title: /^Analyst$/, org: 'Terrapin Investment Fund', start: '2024-09-01' }],
    absent: ['dokafor@umd.edu'],
  },
  {
    name: 'title-case headings with colons',
    text: `Priya Raman
priya.raman@berkeley.edu
Berkeley, CA

Education:
University of California, Berkeley
B.A. Data Science, May 2026

Professional Experience:
Data Science Intern @ Spotify   Jun 2025 – Aug 2025
- Trained a churn model for podcast listeners that lifted retention 3%

Projects:
Campus Marketplace | React, Node   Jan 2025 – Present
- Built a campus marketplace used by 800 students

Interests:
Bouldering, film photography
`,
    experiences: [{ title: /^Data Science Intern$/, org: 'Spotify', start: '2025-06-01' }],
    projects: [{ title: /^Campus Marketplace$/, keywords: ['react', 'node'] }],
    education: { org: /^University of California, Berkeley$/, title: /Data Science/, end: '2026-05-01' },
    interests: true,
    absent: ['priya.raman@berkeley.edu'],
  },
  {
    name: 'headings with extra words and rules',
    text: `Wei Zhang
wei.zhang@uw.edu | 206-555-0199 | linkedin.com/in/weizhang
_______________________________________________

WORK & RESEARCH EXPERIENCE
Microsoft   Redmond, WA
Software Engineer Intern   Jun 2025 – Sep 2025
• Shipped a telemetry sampler that reduced ingestion cost by 18%

EDUCATION & HONORS
University of Washington   Seattle, WA
B.S. Computer Engineering   Jun 2026
Dean's List 2023, 2024

CERTIFICATIONS
AWS Certified Cloud Practitioner

TECHNICAL SKILLS
Rust, TypeScript, Azure
`,
    experiences: [{ title: /^Software Engineer Intern$/, org: 'Microsoft', start: '2025-06-01' }],
    education: {
      org: /^University of Washington$/,
      title: /^B\.S\. Computer Engineering$/,
      end: '2026-06-01',
    },
    skills: ['rust', 'typescript', 'azure'],
    absent: ['wei.zhang@uw.edu', 'AWS Certified', '_____'],
  },
  {
    name: 'role then company with an em dash',
    text: `Hannah Brooks
hbrooks@risd.edu

EXPERIENCE
Product Design Intern — Figma   Summer 2025
• Designed the first version of variable modes for prototypes
Design Lead — RISD Student Union   Sep 2023 – May 2025
• Led a team of 5 redesigning the campus events app

EDUCATION
Rhode Island School of Design — BFA Industrial Design   May 2026
`,
    experiences: [
      { title: /^Product Design Intern$/, org: 'Figma' },
      { title: /^Design Lead$/, org: 'RISD Student Union', start: '2023-09-01' },
    ],
    education: {
      org: /^Rhode Island School of Design$/,
      title: /^BFA Industrial Design$/,
      end: '2026-05-01',
    },
    absent: ['hbrooks@risd.edu'],
  },
  {
    name: 'two roles under one employer',
    text: `Marcus Lee
marcus.lee@utexas.edu

EXPERIENCE
Dell Technologies   Austin, TX
Software Engineering Intern   May 2025 – Aug 2025
• Automated firmware regression tests across 30 laptop models
IT Support Associate   Sep 2023 – Apr 2025
• Resolved over 1,500 tickets for the finance department
H-E-B   Austin, TX
Data Analyst Intern   May 2024 – Aug 2024
• Forecasted weekly demand for 200 grocery items
`,
    experiences: [
      { title: /^Software Engineering Intern$/, org: 'Dell Technologies', start: '2025-05-01' },
      { title: /^IT Support Associate$/, org: 'Dell Technologies', start: '2023-09-01' },
      { title: /^Data Analyst Intern$/, org: 'H-E-B', start: '2024-05-01' },
    ],
    absent: ['marcus.lee@utexas.edu'],
  },
  {
    name: 'first-person profile and education with honors',
    text: `Emily Nguyen
+1 (617) 555-0123 | emily.nguyen@mit.edu | emilynguyen.dev

PROFILE
I am a senior studying mechanical engineering at MIT who builds hardware for robotics teams.

EXPERIENCE
Tesla, Mechanical Engineering Intern, Jan 2025 - Aug 2025
• Redesigned a battery tray bracket and cut part cost by 12%

EDUCATION & HONORS
Massachusetts Institute of Technology
S.B. Mechanical Engineering   Jun 2026
`,
    summary:
      'Emily Nguyen is a senior studying mechanical engineering at MIT who builds hardware for robotics teams.',
    experiences: [{ title: /^Mechanical Engineering Intern$/, org: 'Tesla', start: '2025-01-01' }],
    education: {
      org: /^Massachusetts Institute of Technology$/,
      title: /^S\.B\. Mechanical Engineering$/,
      end: '2026-06-01',
    },
    absent: ['emily.nguyen@mit.edu', '555-0123', 'emilynguyen.dev'],
  },
  {
    name: 'puffery summary and volunteer section',
    text: `Olivia Davis
olivia.davis@duke.edu | 919-555-0188

Professional Summary
Highly motivated, detail-oriented economics student passionate about healthcare strategy.

Consulting Experience
Duke Consulting Club, Project Lead   Sep 2024 – Present
• Led a 4-person team scoping market entry for a regional hospital system

Volunteer Experience
Durham Food Bank, Volunteer Coordinator   2022 – 2024
• Scheduled 60 weekend volunteers each month
`,
    summary: 'Olivia Davis is an economics student interested in healthcare strategy.',
    experiences: [
      { title: /^Project Lead$/, org: 'Duke Consulting Club', start: '2024-09-01' },
      { title: /^Volunteer Coordinator$/, org: 'Durham Food Bank', start: '2022-01-01', end: '2024-01-01' },
    ],
    absent: ['olivia.davis@duke.edu', 'passionate', 'Highly motivated'],
  },
];

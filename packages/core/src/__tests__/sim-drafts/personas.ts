/**
 * Deterministic student personas for the draft simulation. Each axis (school, major, year, goal, resume richness,
 * own-words style, never rule, name, tone) is a small hand-written list, and persona i takes a different stride
 * through each, so 44 personas cover every value of every axis several times without any randomness.
 */
import { heuristicResumeParse } from '../../resume/parse';
import { profileFromResume } from '../../resume/profile';
import type { ResumeFacet } from '../../types';

export type GoalId =
  | 'swe'
  | 'pm'
  | 'ib'
  | 'consulting'
  | 'vc'
  | 'design'
  | 'data'
  | 'research'
  | 'fundraising'
  | 'cofounder'
  | 'switch_nurse_pm'
  | 'switch_teacher_data';

export interface Goal {
  id: GoalId;
  /** the onboarding functions (FUNCTION_LABEL keys) */
  targetFunctions: string[];
  cycleLabel: string;
  /** recipients' employer for this goal, by recipient archetype */
  orgs: { alum: string; senior: string; recruiter: string; founder: string };
  industry: string;
  alumTitle: string;
  seniorTitle: string;
  roleLabel: string;
}

export const GOALS: Goal[] = [
  {
    id: 'swe',
    targetFunctions: ['swe'],
    cycleLabel: 'Summer 2027 internship',
    orgs: { alum: 'Stripe', senior: 'Datadog', recruiter: 'Stripe', founder: 'Railway' },
    industry: 'Software',
    alumTitle: 'Software Engineer',
    seniorTitle: 'VP of Engineering',
    roleLabel: 'Software Engineering Intern',
  },
  {
    id: 'pm',
    targetFunctions: ['pm'],
    cycleLabel: 'Summer 2027 internship',
    orgs: { alum: 'Notion', senior: 'Airbnb', recruiter: 'Notion', founder: 'Granola' },
    industry: 'Software',
    alumTitle: 'Associate Product Manager',
    seniorTitle: 'Senior Director of Product',
    roleLabel: 'APM Intern',
  },
  {
    id: 'ib',
    targetFunctions: ['ib'],
    cycleLabel: 'Summer 2027 analyst',
    orgs: { alum: 'Evercore', senior: 'Goldman Sachs', recruiter: 'Evercore', founder: 'Arcadia Capital' },
    industry: 'Investment Banking',
    alumTitle: 'Investment Banking Analyst',
    seniorTitle: 'Managing Director',
    roleLabel: 'Summer Analyst',
  },
  {
    id: 'consulting',
    targetFunctions: ['consulting'],
    cycleLabel: 'Summer 2027 internship',
    orgs: {
      alum: 'Bain & Company',
      senior: 'McKinsey & Company',
      recruiter: 'Bain & Company',
      founder: 'Kestrel Advisory',
    },
    industry: 'Management Consulting',
    alumTitle: 'Associate Consultant',
    seniorTitle: 'Partner',
    roleLabel: 'Associate Consultant Intern',
  },
  {
    id: 'vc',
    targetFunctions: ['vc'],
    cycleLabel: 'Summer 2027 internship',
    orgs: { alum: 'Accel', senior: 'Sequoia Capital', recruiter: 'Accel', founder: 'Basecase' },
    industry: 'Venture Capital',
    alumTitle: 'Investment Analyst',
    seniorTitle: 'General Partner',
    roleLabel: 'Investment Intern',
  },
  {
    id: 'design',
    targetFunctions: ['design'],
    cycleLabel: 'Summer 2027 internship',
    orgs: { alum: 'Figma', senior: 'Pinterest', recruiter: 'Figma', founder: 'Tldraw' },
    industry: 'Software',
    alumTitle: 'Product Designer',
    seniorTitle: 'VP of Design',
    roleLabel: 'Product Design Intern',
  },
  {
    id: 'data',
    targetFunctions: ['data'],
    cycleLabel: 'Fall 2027 full-time',
    orgs: { alum: 'Spotify', senior: 'Capital One', recruiter: 'Spotify', founder: 'Hex' },
    industry: 'Software',
    alumTitle: 'Data Scientist',
    seniorTitle: 'Vice President, Analytics',
    roleLabel: 'Data Scientist',
  },
  {
    id: 'research',
    targetFunctions: ['research'],
    cycleLabel: 'Summer 2027 research position',
    orgs: {
      alum: 'Allen Institute for AI',
      senior: 'Microsoft Research',
      recruiter: 'Allen Institute for AI',
      founder: 'Elicit',
    },
    industry: 'Research',
    alumTitle: 'Research Engineer',
    seniorTitle: 'Senior Principal Researcher',
    roleLabel: 'Research Intern',
  },
  {
    id: 'fundraising',
    targetFunctions: ['vc'],
    cycleLabel: 'pre-seed round',
    orgs: { alum: 'Pear VC', senior: 'Andreessen Horowitz', recruiter: 'Y Combinator', founder: 'Loomly' },
    industry: 'Venture Capital',
    alumTitle: 'Associate',
    seniorTitle: 'General Partner',
    roleLabel: 'pre-seed investment',
  },
  {
    id: 'cofounder',
    targetFunctions: [],
    cycleLabel: '',
    orgs: { alum: 'Ramp', senior: 'Plaid', recruiter: 'South Park Commons', founder: 'Quill' },
    industry: 'Software',
    alumTitle: 'Software Engineer',
    seniorTitle: 'Head of Engineering',
    roleLabel: 'technical co-founder',
  },
  {
    id: 'switch_nurse_pm',
    targetFunctions: ['pm'],
    cycleLabel: 'career switch into health tech product',
    orgs: { alum: 'Epic Systems', senior: 'Oscar Health', recruiter: 'Oscar Health', founder: 'Nabla' },
    industry: 'Health Care',
    alumTitle: 'Product Manager',
    seniorTitle: 'Chief Product Officer',
    roleLabel: 'Associate Product Manager',
  },
  {
    id: 'switch_teacher_data',
    targetFunctions: ['data'],
    cycleLabel: 'Fall 2027 full-time',
    orgs: { alum: 'Duolingo', senior: 'Khan Academy', recruiter: 'Duolingo', founder: 'Brisk Teaching' },
    industry: 'Education',
    alumTitle: 'Data Analyst',
    seniorTitle: 'Director of Data Science',
    roleLabel: 'Data Analyst',
  },
];

interface School {
  name: string;
  tier: 'elite' | 'state' | 'community' | 'international';
  tz: string;
}
export const SCHOOLS: School[] = [
  { name: 'Stanford University', tier: 'elite', tz: 'America/Los_Angeles' },
  { name: 'Princeton University', tier: 'elite', tz: 'America/New_York' },
  { name: 'University of Michigan', tier: 'state', tz: 'America/Detroit' },
  { name: 'Arizona State University', tier: 'state', tz: 'America/Phoenix' },
  { name: 'University of Texas at Austin', tier: 'state', tz: 'America/Chicago' },
  { name: 'De Anza College', tier: 'community', tz: 'America/Los_Angeles' },
  { name: 'Miami Dade College', tier: 'community', tz: 'America/New_York' },
  { name: 'Indian Institute of Technology Bombay', tier: 'international', tz: 'Asia/Kolkata' },
  { name: 'University of Lagos', tier: 'international', tz: 'Africa/Lagos' },
  { name: 'Tsinghua University', tier: 'international', tz: 'Asia/Shanghai' },
  { name: 'Universidad de los Andes', tier: 'international', tz: 'America/Bogota' },
];

export const MAJORS = [
  'Computer Science',
  'Economics',
  'Nursing',
  'Art History',
  'Mechanical Engineering',
  'Undecided',
  'Statistics',
  'Political Science',
];

interface Year {
  label: string;
  degree: string;
  /** years from 2026 to graduation */
  gradOffset: number;
}
export const YEARS: Year[] = [
  // the simulation runs in October 2026: a senior graduates in May 2027
  { label: 'first-year', degree: 'BA', gradOffset: 4 },
  { label: 'sophomore', degree: 'BS', gradOffset: 3 },
  { label: 'junior', degree: 'BS', gradOffset: 2 },
  { label: 'senior', degree: 'BA', gradOffset: 1 },
  { label: 'associate', degree: 'AA', gradOffset: 1 },
  { label: 'MBA', degree: 'MBA', gradOffset: 1 },
  { label: 'PhD', degree: 'PhD', gradOffset: 3 },
];

export interface Name {
  first: string;
  last?: string;
}
export const NAMES: Name[] = [
  { first: 'Anish', last: 'Polakala' },
  { first: 'Priya', last: 'Raghunathan' },
  { first: 'Wei', last: 'Zhang' },
  { first: 'José', last: 'Hernández' },
  { first: 'Oluwaseun', last: 'Adeyemi' },
  { first: 'Mary-Kate', last: "O'Brien" },
  { first: 'Thi', last: 'Nguyen' },
  { first: 'Zoë', last: 'Lindqvist' },
  { first: 'kevin', last: 'park' },
  { first: 'Aaliyah', last: 'Johnson' },
  { first: 'Madhu' },
  { first: 'Jean-Luc', last: 'Moreau' },
  { first: 'Fatima', last: 'Al-Sayed' },
  { first: 'Diego', last: 'Ramírez' },
  { first: 'Hannah', last: 'Schmidt' },
  { first: 'Kwame', last: 'Mensah' },
  { first: 'Sofía', last: 'Castillo' },
  { first: 'Ethan', last: 'Brooks' },
  { first: 'Yuki', last: 'Tanaka' },
  { first: 'Leila', last: 'Haddad' },
  { first: 'Marcus', last: 'Lee' },
  { first: 'Ana', last: 'Souza' },
];

export type ResumeLevel = 'rich' | 'medium' | 'thin' | 'empty' | 'messy' | 'nonnative';
const RESUME_LEVELS: ResumeLevel[] = ['rich', 'medium', 'thin', 'empty', 'messy', 'nonnative'];

export type WordsStyle =
  | 'detailed'
  | 'blank'
  | 'messy_lower'
  | 'typos'
  | 'very_long'
  | 'nonnative'
  | 'emoji'
  | 'terse';
const WORDS_STYLES: WordsStyle[] = [
  'detailed',
  'blank',
  'messy_lower',
  'typos',
  'very_long',
  'nonnative',
  'emoji',
  'terse',
];

/** A never rule, with our own check of whether a body breaks it (independent of the app's parser). */
export interface NeverRule {
  text: string;
  breaks: (body: string, p: { school: string; firstName: string }) => boolean;
}
export const NEVER_RULES: NeverRule[] = [
  { text: '', breaks: () => false },
  { text: 'Never mention my GPA.', breaks: (b) => /\bgpa\b/i.test(b) },
  { text: 'No exclamation marks.', breaks: (b) => /!/.test(b) },
  { text: "Don't say I'm a student.", breaks: (b) => /\bstudent\b/i.test(b) },
  {
    text: 'dont mention my school',
    breaks: (b, p) => b.includes(p.school) || b.includes(p.school.split(' ')[0]!),
  },
  { text: 'Never use the word "just".', breaks: (b) => /\bjust\b/i.test(b) },
  {
    text: 'Never ask for a referral in the first message. No emojis.',
    breaks: (b) => /\p{Extended_Pictographic}/u.test(b),
  },
  {
    text: 'never say "I\'m reaching out" and dont call me by my full name',
    breaks: (b) => /reaching out/i.test(b),
  },
  {
    text: "Don't mention that I go to community college.",
    breaks: (b) => /community college|\bcollege\b/i.test(b),
  },
];

export interface OwnWordsAnswers {
  story?: string;
  aim?: string;
  proudOf?: string;
  wantToMeet?: string;
  networkingHard?: string;
}

export interface Persona {
  id: string;
  label: string;
  name: Name;
  school: School;
  major: string;
  year: Year;
  goal: Goal;
  resumeLevel: ResumeLevel;
  resumeText: string;
  facets: ResumeFacet[];
  wordsStyle: WordsStyle;
  words: OwnWordsAnswers;
  never: NeverRule;
  tone: 'warm' | 'formal' | 'direct';
}

function resumeFor(
  level: ResumeLevel,
  n: Name,
  school: School,
  major: string,
  year: Year,
  goal: Goal,
): string {
  const full = [n.first, n.last].filter(Boolean).join(' ');
  const grad = `May ${2026 + year.gradOffset}`;
  const edu = `EDUCATION\n${school.name}\n${year.degree} in ${major}   Expected ${grad}\nGPA: 3.4/4.0\n`;
  const company = goal.orgs.founder === 'Quill' ? 'Brightline Labs' : 'Northwind Analytics';
  if (level === 'empty') return '';
  if (level === 'thin') return `${full}\n${full.toLowerCase().replace(/\W+/g, '.')}@example.edu\n\n${edu}`;
  if (level === 'messy')
    return `${full} | ${school.name} | ${major}\nexperience: worked at family restaurant 3 yrs, did some freelance stuff, tutoring\nskills: excel, canva, people`;
  if (level === 'nonnative')
    return `${full}\n${edu}\nEXPERIENCE\n${company}   Remote\nIntern   Jun 2025 – Aug 2025\n• Was responsible of the making of weekly reports for the sales team of 12 persons\n• Helped in the migration of database to cloud\n`;
  const medium = `${full}\n${full.toLowerCase().replace(/\W+/g, '.')}@example.edu | (555) 555-0100\n\n${edu}\nEXPERIENCE\n${company}   Austin, TX\nOperations Intern   Jun 2025 – Aug 2025\n• Automated a weekly inventory report, saving the team 6 hours a week\n`;
  if (level === 'medium') return medium;
  return `${full}\n${full.toLowerCase().replace(/\W+/g, '.')}@example.edu | linkedin.com/in/x\n\nSUMMARY\n${full} is a ${year.label} at ${school.name} studying ${major}.\n\n${edu}\nEXPERIENCE\n${company}   San Francisco, CA\nAnalyst Intern   Jun 2025 – Aug 2025\n• Built a churn model in Python that cut monthly churn by 8% across 40,000 accounts\n• Led 14 customer interviews and wrote the spec for a self-serve onboarding flow\nCampus Ventures Club   Campus\nPresident   Sep 2024 – Present\n• Grew membership from 30 to 210 students and ran a 300-person pitch night\n\nPROJECTS\nStudyMatch\n• Shipped a course-matching app used by 1,200 students in its first semester\n\nSKILLS\nPython, SQL, Figma, Excel\n`;
}

function wordsFor(style: WordsStyle, goal: Goal, major: string): OwnWordsAnswers {
  // how a student names what they want: "product design", "summer analyst", "pre-seed investment"
  const fn = goal.roleLabel
    .toLowerCase()
    .replace(/\s+intern$/, '')
    .replace(/^apm$/, 'product management');
  switch (style) {
    case 'blank':
      return {};
    case 'terse':
      return { aim: fn, story: major };
    case 'messy_lower':
      return {
        story: `im a ${major.toLowerCase()} kid who got into ${fn} stuff after building a discord bot for my dorm`,
        aim: `get a ${fn} offer for next summer tbh`,
        proudOf: 'my dorm bot has like 400 users lol',
      };
    case 'typos':
      return {
        story: `I studdied ${major} but realy I love building thigns, I ran a small resale buisness in high school`,
        aim: `land a ${fn} role at a compnay that care about users`,
        proudOf: 'grew my resale buisness to 2k a month',
        networkingHard: 'i get nervus emailing strangers',
      };
    case 'very_long':
      return {
        story:
          `So my story is kind of long, I started out in ${major} because my parents wanted me to, and then sophomore year I took an intro class that changed everything for me, and since then I have been doing everything I can, clubs, side projects, a summer internship that was not really related, reading every blog post, going to every info session, and I think the through line is that I really like turning messy problems into something simple that people actually use, which is why ${fn} feels like the right fit and why I keep coming back to it even when it is hard and nobody around me is doing it.`.repeat(
            1,
          ),
        aim: `I want to get a ${fn} role, ideally somewhere with real mentorship, where I can learn fast from people who have done this for years and eventually lead my own team, and I would honestly take any team as long as I learn.`,
        proudOf:
          'Organizing a 300-person hackathon on a shoestring budget with a team of six volunteers, finding sponsors, running logistics and keeping everyone fed and happy for 36 hours.',
      };
    case 'nonnative':
      return {
        story: `I am coming from ${major} background and now I am very interesting to make career in ${fn}. In my country I have done the internship in a bank.`,
        aim: `To get the ${fn} position in USA company and learning the best practices.`,
        proudOf: 'I have won the national level case competition among 120 teams.',
      };
    case 'emoji':
      return {
        story: `${major} major 📚 who fell in love with ${fn} 🚀`,
        aim: `${fn} internship ✨ ideally in NYC 🗽`,
        proudOf: 'Built a budgeting app 💸 with 900 users',
      };
    default:
      return {
        story: `I moved from ${major} into ${fn} after running the analytics for our campus food pantry, which now serves 600 students a week.`,
        aim: `A ${fn} role on a team that works on tools for small businesses.`,
        proudOf: 'I rebuilt the food pantry ordering system and cut wait times from 40 minutes to 10.',
        wantToMeet: 'People who moved into this field from a non-traditional path.',
        networkingHard: 'I never know how to ask without sounding like I want something.',
      };
  }
}

export const PERSONA_COUNT = 44;

export function buildPersonas(n = PERSONA_COUNT): Persona[] {
  const out: Persona[] = [];
  for (let i = 0; i < n; i++) {
    const name = NAMES[i % NAMES.length]!;
    // community colleges get associate students, PhDs go to elite or international schools: keep combinations plausible
    let school = SCHOOLS[(i * 3) % SCHOOLS.length]!;
    let year = YEARS[(i * 5 + 1) % YEARS.length]!;
    if (school.tier === 'community' && !['first-year', 'sophomore', 'associate'].includes(year.label))
      year = YEARS[4]!;
    if (school.tier !== 'community' && year.label === 'associate') year = YEARS[2]!;
    const goal = GOALS[i % GOALS.length]!;
    let major = MAJORS[(i * 7 + 2) % MAJORS.length]!;
    if (goal.id === 'switch_nurse_pm') major = 'Nursing';
    if (year.label === 'MBA') major = 'Business Administration';
    if (year.label === 'PhD' && major === 'Undecided') major = 'Physics';
    if (school.tier === 'international' && i % 2 === 0) school = SCHOOLS[7 + (i % 4)]!;
    const resumeLevel = RESUME_LEVELS[(i * 5 + 2) % RESUME_LEVELS.length]!;
    const wordsStyle = WORDS_STYLES[(i * 3 + 1) % WORDS_STYLES.length]!;
    const never = NEVER_RULES[(i * 4 + 3) % NEVER_RULES.length]!;
    const tone = (['warm', 'formal', 'direct'] as const)[i % 3]!;
    const resumeText = resumeFor(resumeLevel, name, school, major, year, goal);
    const facets = resumeText ? heuristicResumeParse(resumeText, `r${i}`, { name: name.first }) : [];
    out.push({
      id: `p${String(i + 1).padStart(2, '0')}`,
      label: `${name.first} · ${school.tier} · ${major} · ${year.label} · ${goal.id} · resume:${resumeLevel} · words:${wordsStyle}`,
      name,
      school,
      major,
      year,
      goal,
      resumeLevel,
      resumeText,
      facets,
      wordsStyle,
      words: wordsFor(wordsStyle, goal, major),
      never,
      tone,
    });
  }
  return out;
}

export { profileFromResume };

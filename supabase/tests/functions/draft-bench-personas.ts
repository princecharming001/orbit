/**
 * Students for the draft bench (plan 30): three per situation, from different schools, years and experience levels.
 * Every person and company is made up. The norms are the judge's reference, written from public guidance (cited in
 * docs/plan/30-niche-drafting.md) and independent of Orbit's own prompt, so the bench does not grade Orbit against
 * itself.
 */

export type Niche = 'coffee_chat' | 'research_position' | 'startup_hiring';

export const NICHE_NORMS: Record<Niche, string> = {
  coffee_chat: [
    'A coffee chat ask to a banker or consultant, the student recruiting for an internship.',
    '- First message: four to six sentences. Lead with the real connection (same school, club, hometown, a referral) or one specific thing about their group or path. One line on who the student is (school, year, the one relevant fact). Ask for 15 to 20 minutes by phone or Zoom at their convenience to hear about their path or group. Never ask for a job, an interview, a referral or "openings", never attach or send a resume unasked, never a paragraph about the student.',
    '- Subject: plain and specific (school, connection, topic). Never "quick question", never clickbait.',
    '- Follow-up: one short polite nudge after about a week, restating the ask in one line, no guilt ("just bumping this" style filler is weak, a new line of context is better).',
    '- Reply to a yes: thank them, propose two or three concrete times or take theirs, confirm the medium and length, nothing else.',
  ].join('\n'),
  research_position: [
    'An undergraduate asking a professor (or a PhD student in the lab) about joining their lab as a research assistant.',
    '- First message: 100 to 180 words, formal but warm ("Dear Professor X" or "Dr. X"). Show they read the work: name a specific recent paper or project and one honest sentence on what drew them to it. Their year, major, relevant coursework or skills, any lab, coding or project experience (or say plainly they are new and eager to learn). State their availability (hours a week, which terms) and that they can share a CV and transcript. The ask: whether there might be a place for an undergraduate in the lab, or a short meeting to talk about it. Never claim attachments that do not exist, never flatter, never a mass-email feel, never ask for pay first.',
    '- Subject: names the topic and that they are an undergraduate (for example "Undergraduate interested in sleep and memory research").',
    '- Follow-up: polite, after one to two weeks, two or three sentences, restating interest and availability; professors are busy and a follow-up is normal.',
    '- Reply to a question (CV, availability, interests): answer exactly what was asked, with the specifics the student gave, offer times if a meeting is proposed, keep it short.',
  ].join('\n'),
  startup_hiring: [
    'A student writing to a founder or hiring lead at a startup that is hiring right now, about a specific open role.',
    '- First message: 70 to 140 words, direct and concrete. Name the role and one specific thing about the product or a recent launch that shows real interest. One or two lines of proof of work (something they built or shipped, with a result or a link if the facts give one). Why this company now. The ask: a short call about the role, or the best way to be considered. Startups welcome direct interest in the open role; a referral ask to a stranger or "any openings?" is weak, and so is a generic "I am passionate about startups".',
    '- Subject: names the role or what they built (for example "Founding engineer role, shipped a scheduling API at my co-op").',
    '- Follow-up: one short nudge after about a week that adds something new (a small idea, a quick teardown, a link), never guilt.',
    '- Reply to a yes: confirm interest, take or offer times, answer any question (GitHub, availability, start date) with what the student gave, short.',
  ].join('\n'),
};

export interface BenchPersona {
  id: string;
  niche: Niche;
  firstName: string;
  fullName: string;
  school: string;
  gradYear: number;
  degree: string;
  majors: string[];
  city?: string;
  /** what they typed when Orbit asked what they are working toward, read by the real goal inference */
  statedGoal: string;
  /** their own words from setup (settings.about) */
  about: Record<string, string>;
  resume?: { text: string; facets: { title?: string; org?: string; text?: string }[] };
  /** what the judge is told about the student */
  studentSummary: string;
  recipient: {
    name: string;
    title: string;
    org: string;
    email: string;
    alum?: boolean;
    score?: number;
    facts: string[];
  };
  topic?: string;
  firstKind?: 'first_touch' | 'warm_first_touch';
  theirReply: { body: string; replyClass: string; answer?: string };
}

export const BENCH_PERSONAS: BenchPersona[] = [
  // ---- 1. coffee chats for recruiting: IB, consulting -------------------------------------------------------------
  {
    id: 'ib-ut-junior',
    niche: 'coffee_chat',
    firstName: 'Priya',
    fullName: 'Priya Shah',
    school: 'The University of Texas at Austin',
    gradYear: 2028,
    degree: 'BBA',
    majors: ['Finance'],
    city: 'Austin',
    statedGoal:
      "I'm a junior at UT Austin in finance and I want a summer 2027 investment banking internship, ideally energy coverage at a boutique in Houston like Tudor Pickering or Simmons.",
    about: {
      aim: 'Investment banking summer analyst 2027, energy coverage in Houston.',
      story:
        'Junior in finance at McCombs. I grew up in Midland, where half my friends’ parents work in oil and gas.',
      proudOf: 'I built the valuation model for our student fund’s pitch on an upstream E&P name.',
    },
    resume: {
      text: 'Priya Shah. BBA Finance, UT Austin 2028. Summer 2026: Wealth management intern, Frost Bank. McCombs Investment Team, energy sector lead.',
      facets: [
        { title: 'Wealth Management Intern', org: 'Frost Bank' },
        { title: 'Energy Sector Lead', org: 'McCombs Investment Team' },
      ],
    },
    studentSummary:
      'Priya Shah, junior at UT Austin (finance, McCombs), grew up in Midland, interned in wealth management at Frost Bank, energy lead on the student investment team; wants a 2027 IB summer internship in energy in Houston.',
    recipient: {
      name: 'Jake Morales',
      title: 'Investment Banking Analyst',
      org: 'Tudor, Pickering, Holt & Co.',
      email: 'jmorales@tph-example.com',
      alum: true,
      facts: [
        'Jake Morales graduated from UT Austin (McCombs, finance) in 2024 and joined TPH in Houston that summer.',
        'Jake works on upstream and midstream M&A deals in the energy group.',
      ],
    },
    theirReply: {
      body: 'Hi Priya, happy to chat. Things are busy this week but I could do a quick call next week. What does your schedule look like?',
      replyClass: 'interested',
    },
  },
  {
    id: 'consult-georgetown-soph',
    niche: 'coffee_chat',
    firstName: 'Marcus',
    fullName: 'Marcus Lee',
    school: 'Georgetown University',
    gradYear: 2029,
    degree: 'BS',
    majors: ['Economics'],
    city: 'Washington',
    statedGoal:
      'Sophomore at Georgetown, econ. I want to break into management consulting, MBB if I can, for a summer 2028 internship. I need coffee chats with consultants.',
    about: {
      aim: 'Management consulting at McKinsey, Bain or BCG.',
      story: 'Sophomore in econ at Georgetown. I run case practice for the Georgetown Consulting Club.',
    },
    studentSummary:
      'Marcus Lee, sophomore at Georgetown (economics), runs case practice for the Georgetown Consulting Club, no internships yet; wants MBB consulting for 2028.',
    recipient: {
      name: 'Elena Rossi',
      title: 'Business Analyst',
      org: 'McKinsey & Company',
      email: 'elena.rossi@mck-example.com',
      alum: true,
      facts: [
        'Elena Rossi graduated from Georgetown in 2024 and was president of the Georgetown Consulting Club.',
        'Elena is a business analyst in McKinsey’s Washington, DC office working in the public sector practice.',
      ],
    },
    theirReply: {
      body: 'Hey Marcus, always happy to help a fellow Hoya. I can do 20 minutes Thursday or Friday afternoon. Does either work?',
      replyClass: 'scheduling',
    },
  },
  {
    id: 'rx-rutgers-senior',
    niche: 'coffee_chat',
    firstName: 'Jordan',
    fullName: 'Jordan Kim',
    school: 'Rutgers University',
    gradYear: 2027,
    degree: 'BS',
    majors: ['Accounting'],
    city: 'New Brunswick',
    statedGoal:
      "I'm a senior at Rutgers in accounting, I start at Deloitte audit next fall but I want to move into restructuring banking. Looking to talk to people at Houlihan Lokey, PJT and Moelis about how they made the switch.",
    about: {
      aim: 'Move from audit into restructuring investment banking.',
      story:
        'Senior in accounting at Rutgers. Starting in audit at Deloitte next fall. I got into restructuring after reading about the Bed Bath & Beyond bankruptcy for a class project.',
    },
    resume: {
      text: 'Jordan Kim. BS Accounting, Rutgers 2027. Audit intern, Deloitte (summer 2026). Treasurer, Rutgers Korean Student Association.',
      facets: [{ title: 'Audit Intern', org: 'Deloitte' }],
    },
    studentSummary:
      'Jordan Kim, senior at Rutgers (accounting), audit intern at Deloitte and starting there full time; wants to move into restructuring banking; no connection to the recipient.',
    recipient: {
      name: 'David Chen',
      title: 'Associate, Financial Restructuring',
      org: 'Houlihan Lokey',
      email: 'dchen@hl-example.com',
      facts: [
        'David Chen started his career in audit at PwC before moving to Houlihan Lokey’s financial restructuring group in 2023.',
        'David is based in Houlihan Lokey’s New York office.',
      ],
    },
    theirReply: {
      body: 'Hi Jordan, I took the same path so happy to share what I can. Send me a couple of times next week that work for you.',
      replyClass: 'scheduling',
    },
  },

  // ---- 2. professors and labs for research positions ---------------------------------------------------------------
  {
    id: 'lab-davis-soph',
    niche: 'research_position',
    firstName: 'Ana',
    fullName: 'Ana Torres',
    school: 'University of California, Davis',
    gradYear: 2029,
    degree: 'BS',
    majors: ['Neurobiology, Physiology and Behavior'],
    city: 'Davis',
    statedGoal:
      "I'm a sophomore at UC Davis in neurobiology. I want to get into a research lab this winter quarter, something on sleep and memory. I have no lab experience yet.",
    about: {
      aim: 'An undergraduate research assistant position in a sleep and memory lab.',
      story: 'Sophomore in NPB at UC Davis. I work at the campus pharmacy and took NPB 101 last spring.',
      proudOf: 'An A in NPB 101 and a literature review on sleep deprivation I wrote for my writing class.',
    },
    studentSummary:
      'Ana Torres, sophomore at UC Davis (neurobiology), no lab experience, took NPB 101, works at the campus pharmacy, wrote a literature review on sleep deprivation; wants an undergraduate RA position in a sleep and memory lab, can do about 10 hours a week from winter quarter.',
    recipient: {
      name: 'Rachel Kim',
      title: 'Associate Professor of Neurobiology, Physiology and Behavior',
      org: 'University of California, Davis',
      email: 'rkim@ucdavis-example.edu',
      facts: [
        'Professor Rachel Kim’s 2025 paper in the Journal of Neuroscience showed that five hours of sleep deprivation disrupts hippocampal memory consolidation in mice.',
        'Her lab website says undergraduates can join for course credit through NPB 199 and are asked to commit about 10 hours a week.',
      ],
    },
    topic: 'joining the lab as an undergraduate researcher',
    theirReply: {
      body: 'Dear Ana, thank you for your interest in the lab. Could you send your CV and an unofficial transcript, and let me know how many hours a week you could commit in winter quarter?',
      replyClass: 'question',
      answer:
        'About 10 hours a week, Tuesday and Thursday afternoons are free, and I can send my CV and transcript today.',
    },
  },
  {
    id: 'lab-gatech-junior',
    niche: 'research_position',
    firstName: 'Ethan',
    fullName: 'Ethan Brooks',
    school: 'Georgia Institute of Technology',
    gradYear: 2028,
    degree: 'BS',
    majors: ['Computer Science'],
    city: 'Atlanta',
    statedGoal:
      'Junior CS at Georgia Tech. I want undergrad research in NLP this summer, ideally evaluation of language models. I want to email professors whose labs take undergrads.',
    about: {
      aim: 'Summer undergraduate research in NLP, evaluation of language models.',
      story:
        'Junior in CS at Georgia Tech, intelligence and theory threads. I fine-tuned a small model to review pull requests for a hackathon and it placed second.',
    },
    resume: {
      text: 'Ethan Brooks. BS CS, Georgia Tech 2028. CS 4650 NLP (A). Hackathon: fine-tuned a 1B model to review pull requests, 2nd place at HackGT 2025. Python, PyTorch.',
      facets: [
        { text: 'Fine-tuned a 1B model to review pull requests, 2nd place at HackGT 2025' },
        { text: 'CS 4650 Natural Language Processing, A' },
      ],
    },
    studentSummary:
      'Ethan Brooks, junior at Georgia Tech (CS), took CS 4650 NLP (A), fine-tuned a 1B model to review pull requests (2nd at HackGT 2025), knows Python and PyTorch; wants summer NLP research on evaluating language models.',
    recipient: {
      name: 'Wei Zhang',
      title: 'Assistant Professor, School of Interactive Computing',
      org: 'Georgia Institute of Technology',
      email: 'wzhang@gatech-example.edu',
      facts: [
        'Professor Wei Zhang’s ACL 2025 paper introduced a benchmark for how well language models evaluate low-resource machine translation.',
        'His group page lists open summer undergraduate positions through the Georgia Tech PURA program.',
      ],
    },
    topic: 'summer undergraduate research on language model evaluation',
    theirReply: {
      body: 'Hi Ethan, thanks for reaching out. I do take a few undergrads in the summer. Would you have time for a 20 minute meeting next week to talk about possible projects?',
      replyClass: 'interested',
    },
  },
  {
    id: 'lab-osu-first-year-grad-student',
    niche: 'research_position',
    firstName: 'Leila',
    fullName: 'Leila Haddad',
    school: 'The Ohio State University',
    gradYear: 2030,
    degree: 'BS',
    majors: ['Chemistry'],
    city: 'Columbus',
    statedGoal:
      'First-year chemistry major at Ohio State. I want to start doing research in an organic chemistry lab as early as possible. Someone told me to email the grad students first.',
    about: {
      aim: 'Start undergraduate research in an organic synthesis lab.',
      story:
        'First-year chemistry major at Ohio State. I did a summer program at a community college chemistry lab after high school.',
    },
    studentSummary:
      'Leila Haddad, first-year at Ohio State (chemistry), did a high school summer program in a community college chemistry lab, no university research yet; wants to start in an organic synthesis lab and is writing to a PhD student first.',
    recipient: {
      name: 'Sam Okoro',
      title: 'PhD Candidate, Department of Chemistry and Biochemistry',
      org: 'The Ohio State University',
      email: 'okoro.12@osu-example.edu',
      facts: [
        'Sam Okoro is a fourth-year PhD candidate in Professor Lin’s organic synthesis group, working on nickel-catalyzed cross-coupling reactions.',
        'Sam mentors the two undergraduates currently in the Lin group, according to the group website.',
      ],
    },
    topic: 'getting started as an undergraduate in the Lin group',
    theirReply: {
      body: 'Hi Leila, nice to hear from you. Prof. Lin usually takes undergrads after they finish Orgo 1, but you could shadow me in the lab a couple of afternoons to see the work. What days are you free?',
      replyClass: 'question',
      answer: 'Monday and Wednesday afternoons after 1pm.',
    },
  },

  // ---- 3. startups hiring right now ---------------------------------------------------------------------------------
  {
    id: 'startup-neu-senior-swe',
    niche: 'startup_hiring',
    firstName: 'Chris',
    fullName: 'Chris Nguyen',
    school: 'Northeastern University',
    gradYear: 2027,
    degree: 'BS',
    majors: ['Computer Science'],
    city: 'Boston',
    statedGoal:
      "Senior CS at Northeastern. I want a new grad software engineering job at a seed or Series A startup that's hiring right now, backend or infrastructure.",
    about: {
      aim: 'New grad backend engineer at an early-stage startup.',
      story:
        'Senior in CS at Northeastern. Two co-ops: backend at Wayfair and platform at a fintech called Ledgerly.',
      proudOf: 'At Ledgerly I rebuilt the webhook retry queue and cut failed deliveries by 80 percent.',
    },
    resume: {
      text: 'Chris Nguyen. BS CS, Northeastern 2027. Co-op: Backend Engineer, Wayfair (2025). Co-op: Platform Engineer, Ledgerly (2026), rebuilt webhook retry queue, failed deliveries down 80%. Go, Python, Postgres, Kafka. github.com/chrisnguyen-dev',
      facets: [
        { title: 'Backend Engineer Co-op', org: 'Wayfair' },
        {
          title: 'Platform Engineer Co-op',
          org: 'Ledgerly',
          text: 'Rebuilt webhook retry queue, failed deliveries down 80%',
        },
      ],
    },
    studentSummary:
      'Chris Nguyen, senior at Northeastern (CS), co-ops in backend at Wayfair and platform at Ledgerly (rebuilt a webhook retry queue, failed deliveries down 80%), Go, Python, Postgres, Kafka, GitHub github.com/chrisnguyen-dev; wants a new grad backend role at a seed or Series A startup.',
    recipient: {
      name: 'Maya Patel',
      title: 'Co-founder and CTO',
      org: 'Fieldnote',
      email: 'maya@fieldnote-example.com',
      facts: [
        'Fieldnote (seed, $4M from Boston investors) builds scheduling software for field service teams.',
        'Fieldnote posted a Founding Backend Engineer role on Y Combinator’s Work at a Startup three days ago: Go, Postgres, event-driven systems.',
        'Maya Patel wrote on the Fieldnote blog last month about launching their public scheduling API.',
      ],
    },
    topic: 'the Founding Backend Engineer role',
    theirReply: {
      body: 'Hi Chris, thanks for the note, the retry queue work is very relevant. Can you do a 30 minute call this week? Also send me your GitHub.',
      replyClass: 'interested',
    },
  },
  {
    id: 'startup-nyu-junior-growth',
    niche: 'startup_hiring',
    firstName: 'Grace',
    fullName: 'Grace Liu',
    school: 'New York University',
    gradYear: 2028,
    degree: 'BS',
    majors: ['Marketing'],
    city: 'New York',
    statedGoal:
      'Junior at NYU Stern in marketing. I want a growth or marketing internship at a consumer startup in New York that is hiring now, for spring semester.',
    about: {
      aim: 'A spring growth marketing internship at a New York consumer startup.',
      story:
        'Junior in marketing at NYU Stern. I grew the Stern Women in Business TikTok from zero to 40,000 followers in a year.',
    },
    studentSummary:
      'Grace Liu, junior at NYU Stern (marketing), grew a club TikTok from zero to 40,000 followers in a year, no internships at startups yet; wants a spring growth internship at a New York consumer startup.',
    recipient: {
      name: 'Tom Alvarez',
      title: 'Head of Growth',
      org: 'Pantry',
      email: 'tom@pantry-example.com',
      facts: [
        'Pantry (Series A) delivers groceries from local New York bodegas in under 30 minutes.',
        'Pantry posted a Spring Growth Marketing Intern role on LinkedIn four days ago, focused on short-form video and campus ambassadors.',
      ],
    },
    topic: 'the Spring Growth Marketing Intern role',
    theirReply: {
      body: 'Hey Grace, love the TikTok numbers. We are moving fast on this role. Are you around for a quick call Thursday? And can you work 15 hours a week?',
      replyClass: 'question',
      answer: 'Yes, Thursday works any time after 2pm, and 15 hours a week is fine.',
    },
  },
  {
    id: 'startup-cmu-ms-ml',
    niche: 'startup_hiring',
    firstName: 'Dev',
    fullName: 'Dev Raman',
    school: 'Carnegie Mellon University',
    gradYear: 2027,
    degree: 'MS',
    majors: ['Machine Learning'],
    city: 'Pittsburgh',
    statedGoal:
      'MS in machine learning at CMU graduating in May. I want a founding ML engineer role at an AI startup that is hiring now, ideally working on evals or agents.',
    about: {
      aim: 'Founding or early ML engineer at an AI startup, evals or agents.',
      story:
        'MS in machine learning at CMU. Before that two years as a data scientist at a logistics company in Bangalore.',
      proudOf: 'I open-sourced an eval harness for tool-using agents that has 600 GitHub stars.',
    },
    resume: {
      text: 'Dev Raman. MS Machine Learning, CMU 2027. Data Scientist, Delhivery (2023-2025). Open source: agent-evals (600 stars). PyTorch, JAX.',
      facets: [
        { title: 'Data Scientist', org: 'Delhivery' },
        { text: 'agent-evals, open-source eval harness for tool-using agents, 600 GitHub stars' },
      ],
    },
    studentSummary:
      'Dev Raman, MS in machine learning at CMU graduating May 2027, two years as a data scientist at Delhivery, open-sourced an agent eval harness with 600 GitHub stars; wants a founding ML engineer role at an AI startup on evals or agents.',
    recipient: {
      name: 'Priya Iyer',
      title: 'Co-founder and CEO',
      org: 'Arcline AI',
      email: 'priya@arcline-example.ai',
      facts: [
        'Arcline AI (Y Combinator W26) builds testing infrastructure for AI agents.',
        'Arcline is hiring a Founding ML Engineer, per its Work at a Startup listing posted this week.',
        'Priya Iyer wrote a blog post in October arguing that agent evals should replay real user sessions.',
      ],
    },
    topic: 'the Founding ML Engineer role',
    theirReply: {
      body: 'Dev, we use something close to your harness internally. Would love to talk. Are you free for 45 minutes early next week?',
      replyClass: 'interested',
    },
  },
];

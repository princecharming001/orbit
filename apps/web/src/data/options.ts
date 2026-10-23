/**
 * The choices Orbit suggests in its free-text fields: recruiting cycles, roles, industries and cities students aim
 * for. Each is still free text; these are the common answers, so the student does not have to invent the words and
 * Orbit's drafts and advice can know the cycle they are in.
 */
import type { Suggestion } from '../ui/Suggest';

/** Recruiting cycles, from the next one on: internships, new-grad, and the earlier programs. */
export function cycleOptions(now = new Date()): Suggestion[] {
  const y = now.getFullYear();
  const month = now.getMonth();
  // from August, the coming summer is next year's
  const summer = month >= 7 ? y + 1 : y + 1;
  const out: Suggestion[] = [
    { value: `Summer ${summer} internship`, sub: 'Applications mostly open the fall before' },
    { value: `Summer ${summer + 1} internship`, sub: 'Sophomore and early programs' },
    { value: `Full-time ${summer} new grad`, sub: 'Graduating this cycle' },
    { value: `Full-time ${summer + 1} new grad`, sub: 'Graduating next year' },
    { value: `Fall ${summer} internship`, sub: 'Off-cycle, fewer applicants' },
    { value: `Spring ${summer + 1} internship`, sub: 'Off-cycle, fewer applicants' },
    { value: `Summer ${summer} research`, sub: 'Labs, REUs and research assistant roles' },
    { value: `${summer} externship or insight week`, sub: 'First- and second-year programs' },
    { value: `Summer ${summer} MBA internship`, sub: 'Between years of an MBA' },
    { value: 'PhD or grad school applications', sub: 'Advisors, labs and recommenders' },
    { value: 'Not recruiting, building my network', sub: 'Coffee chats without a deadline' },
  ];
  return out;
}

export const ROLE_OPTIONS = [
  'Software Engineer',
  'Software Engineering Intern',
  'Product Manager',
  'Associate Product Manager',
  'Data Scientist',
  'Machine Learning Engineer',
  'AI Research Scientist',
  'Investment Banking Analyst',
  'Management Consultant',
  'Business Analyst',
  'Product Designer',
  'UX Researcher',
  'Quantitative Trader',
  'Quantitative Researcher',
  'Private Equity Analyst',
  'Venture Capital Analyst',
  'Growth Marketing',
  'Product Marketing Manager',
  'Operations Analyst',
  'Strategy and Operations',
  'Chief of Staff',
  'Founder',
  'Research Assistant',
  'Hardware Engineer',
  'Security Engineer',
  'Site Reliability Engineer',
  'Solutions Engineer',
  'Sales Development Representative',
  'Account Executive',
  'Financial Analyst',
  'Equity Research Analyst',
  'Wealth Management Analyst',
  'Policy Analyst',
  'Mechanical Engineer',
  'Electrical Engineer',
  'Biomedical Engineer',
  'Clinical Research Coordinator',
  'Teacher or Education',
];

export const INDUSTRY_OPTIONS = [
  'Technology',
  'Artificial intelligence',
  'Fintech',
  'Investment banking',
  'Private equity',
  'Venture capital',
  'Hedge funds and trading',
  'Management consulting',
  'Healthcare and biotech',
  'Pharmaceuticals',
  'Medical devices',
  'Consumer products',
  'E-commerce and retail',
  'Media and entertainment',
  'Gaming',
  'Climate and energy',
  'Aerospace and defense',
  'Automotive and mobility',
  'Robotics',
  'Semiconductors',
  'Cybersecurity',
  'Developer tools and infrastructure',
  'Enterprise software',
  'Real estate',
  'Government and public policy',
  'Nonprofit and social impact',
  'Education',
  'Law',
  'Sports',
  'Fashion',
  'Food and beverage',
  'Travel and hospitality',
  'Telecommunications',
  'Startups (early stage)',
];

export const LOCATION_OPTIONS = [
  'San Francisco Bay Area',
  'New York City',
  'Seattle',
  'Los Angeles',
  'Boston',
  'Chicago',
  'Austin',
  'Washington, DC',
  'Denver',
  'Atlanta',
  'Dallas',
  'Houston',
  'Miami',
  'Philadelphia',
  'San Diego',
  'Minneapolis',
  'Pittsburgh',
  'Raleigh-Durham',
  'Salt Lake City',
  'Portland',
  'Phoenix',
  'Toronto',
  'Vancouver',
  'London',
  'Dublin',
  'Berlin',
  'Paris',
  'Amsterdam',
  'Zurich',
  'Singapore',
  'Hong Kong',
  'Tokyo',
  'Sydney',
  'Bangalore',
  'Remote',
  'Open to anywhere',
];

/** Suggestions from a fixed list, prefix matches first; for comma-separated fields the last item is what is typed. */
export function suggestFrom(options: readonly string[], query: string, limit = 8): Suggestion[] {
  const q = query.toLowerCase().trim();
  if (!q) return options.slice(0, limit).map((value) => ({ value }));
  const starts = options.filter((o) => o.toLowerCase().startsWith(q));
  const words = options.filter(
    (o) =>
      !starts.includes(o) &&
      o
        .toLowerCase()
        .split(/[\s,-]+/)
        .some((w) => w.startsWith(q)),
  );
  const inside = options.filter(
    (o) => !starts.includes(o) && !words.includes(o) && o.toLowerCase().includes(q),
  );
  return [...starts, ...words, ...inside].slice(0, limit).map((value) => ({ value }));
}

/** A field holding a comma-separated list: suggestions for the item being typed, picked into that spot. */
export function listField(options: readonly string[]) {
  const split = (v: string) => {
    const parts = v.split(',');
    const last = parts.pop() ?? '';
    return { head: parts.map((p) => p.trim()).filter(Boolean), last: last.trim() };
  };
  return {
    suggest: (v: string) => {
      const { head, last } = split(v);
      const rest = options.filter((o) => !head.some((h) => h.toLowerCase() === o.toLowerCase()));
      return suggestFrom(rest, last);
    },
    /** the value once `picked` replaces the item being typed */
    pick: (v: string, picked: string) => {
      const { head } = split(v);
      return [...head, picked].join(', ');
    },
  };
}

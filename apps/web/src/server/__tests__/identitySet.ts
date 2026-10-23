/**
 * A labelled test set for research identity (docs/plan/20 §8): 50 people sharing 15 common names, each with the
 * LinkedIn profile research would have, and web pages labelled `right` (about this very person) or `wrong` (a
 * namesake, a people-search copy, a page that only shares a word with their employer). Precision is the share of
 * pages scored strong that are right; the target is at least 98%.
 *
 * Built from templates so it is deterministic and readable, with the traps real searches turn up: namesakes at other
 * companies and in the same city, employers that are everyday words (Block, Ramp, Notion, Meta inside "metadata"),
 * alias names (Facebook for Meta, AWS for Amazon), LinkedIn mirrors and background-check sites, and one honest hard
 * case: two people with the same name at the same company.
 */
import type { IdentityInput } from '../../../../../supabase/functions/_shared/research/identity';

export interface LabelledPage {
  url: string;
  title: string;
  text: string;
  label: 'right' | 'wrong';
  why: string;
}

export interface LabelledPerson {
  id: string;
  input: IdentityInput;
  pages: LabelledPage[];
}

const NAMES = [
  ['Michael', 'Chen'],
  ['David', 'Kim'],
  ['Emily', 'Johnson'],
  ['Sarah', 'Lee'],
  ['James', 'Smith'],
  ['Jennifer', 'Wang'],
  ['Daniel', 'Park'],
  ['Jessica', 'Brown'],
  ['Kevin', 'Nguyen'],
  ['Ashley', 'Garcia'],
  ['Christopher', 'Miller'],
  ['Priya', 'Patel'],
  ['Ryan', 'Davis'],
  ['Amanda', 'Wilson'],
  ['Alex', 'Rodriguez'],
] as const;

/** Employer, its alias as the press writes it, the one before, school, city. Some employers are everyday words. */
const JOBS: [string, string, string, string, string][] = [
  ['Meta', 'Facebook', 'Dropbox', 'Stanford University', 'Menlo Park, California'],
  ['Amazon', 'AWS', 'Microsoft', 'University of Washington', 'Seattle, Washington'],
  ['Block', 'Square', 'Stripe', 'UC Berkeley', 'San Francisco, California'],
  ['Ramp', 'Ramp', 'Brex', 'Columbia University', 'New York, New York'],
  ['Notion', 'Notion Labs', 'Figma', 'Carnegie Mellon University', 'San Francisco, California'],
  ['Goldman Sachs', 'Goldman', 'Evercore', 'University of Pennsylvania', 'New York, New York'],
  ['Google', 'Alphabet', 'IBM', 'Georgia Institute of Technology', 'Mountain View, California'],
  ['McKinsey & Company', 'McKinsey', 'Deloitte', 'Northwestern University', 'Chicago, Illinois'],
  ['Stripe', 'Stripe', 'Plaid', 'University of Waterloo', 'Toronto, Ontario'],
  ['JPMorgan Chase', 'J.P. Morgan', 'Citi', 'New York University', 'New York, New York'],
  ['Figma', 'Figma', 'Adobe', 'Rhode Island School of Design', 'San Francisco, California'],
  ['Databricks', 'Databricks', 'Oracle', 'University of Michigan', 'Ann Arbor, Michigan'],
  ['Netflix', 'Netflix', 'Hulu', 'University of Southern California', 'Los Angeles, California'],
];

const TITLES = [
  'Product Manager',
  'Software Engineer',
  'Data Scientist',
  'Designer',
  'Associate',
  'Engineering Manager',
];
const OTHER_CO = [
  'Acme Plumbing',
  'Riverside Dental',
  'Blue Oak Realty',
  'Sunrise Bakery',
  'Granite Law Group',
  'Harbor Fitness',
];
const OTHER_CITY = ['Tulsa', 'Boise', 'Omaha', 'Spokane', 'Dayton', 'Fresno'];

/** The everyday-word trap for an employer: a page that has the word but not the company. */
function wordTrap(org: string, full: string): { title: string; text: string } | undefined {
  const t: Record<string, { title: string; text: string }> = {
    Meta: {
      title: `${full} on metadata pipelines`,
      text: `${full} writes about metadata, meta-analysis and tagging for small libraries.`,
    },
    Block: {
      title: `${full}'s block printing workshop`,
      text: `${full} teaches block printing on weekends; book a block of time below.`,
    },
    Ramp: {
      title: `${full} builds a wheelchair ramp`,
      text: `Volunteers led by ${full} built a ramp for the community center.`,
    },
    Notion: {
      title: `${full}: the notion of time`,
      text: `An essay by ${full} on the notion of time in poetry.`,
    },
    Amazon: {
      title: `${full} returns from the amazon`,
      text: `${full} spent six weeks in the amazon rainforest studying frogs.`,
    },
  };
  return t[org];
}

/** 50 people: each common name used by three or four different people at different employers. */
export function identitySet(): LabelledPerson[] {
  const out: LabelledPerson[] = [];
  let n = 0;
  for (let i = 0; out.length < 50; i++) {
    const [first, last] = NAMES[i % NAMES.length]!;
    const full = `${first} ${last}`;
    const [org, alias, prev, school, location] = JOBS[(i * 7) % JOBS.length]!;
    const title = TITLES[i % TITLES.length]!;
    const city = location.split(',')[0]!;
    const slug = `${first}-${last}-${(1000 + i).toString(36)}`.toLowerCase();
    const id = `p${++n}`;
    const otherCo = OTHER_CO[i % OTHER_CO.length]!;
    const otherCity = OTHER_CITY[i % OTHER_CITY.length]!;
    const pages: LabelledPage[] = [
      {
        url: `https://events.example/${slug}/talk`,
        title: `${full} on building at ${org}`,
        text: `${full}, ${title} at ${org}, spoke about shipping small and often. Before ${org}, ${first} worked at ${prev}.`,
        label: 'right',
        why: 'name and current employer',
      },
      {
        url: `https://news.example/${slug}/launch`,
        title: `${alias} launches a new tool for teams`,
        text: `"We started with three customers," said ${full}, a ${title.toLowerCase()} at ${alias}.`,
        label: 'right',
        why: 'name and the employer under its alias',
      },
      {
        url: `https://alumni.example/${slug}`,
        title: `Alumni spotlight: ${full}`,
        text: `${full} graduated from ${school} and now works in ${city}.`,
        label: 'right',
        why: 'name and school',
      },
      {
        url: `https://blog.example/${slug}/from-${prev.toLowerCase().replace(/\W+/g, '-')}`,
        title: `What I learned in four years at ${prev}`,
        text: `By ${full}. Notes from my time at ${prev}, before I moved on.`,
        label: 'right',
        why: 'name and previous employer',
      },
      {
        url: `https://www.${otherCo.toLowerCase().replace(/\W+/g, '')}.example/team`,
        title: `${full} - Office Manager at ${otherCo}`,
        text: `${full} manages the front office at ${otherCo} in ${otherCity}.`,
        label: 'wrong',
        why: 'a namesake at another company',
      },
      {
        url: `https://rocketreach.co/${slug}-email`,
        title: `${full} email & phone | ${org}`,
        text: `${full} works at ${org} as ${title}. Get ${first}'s email address.`,
        label: 'wrong',
        why: 'a people-search copy of LinkedIn: never strong',
      },
      {
        url: `https://www.spokeo.com/${first}-${last}`,
        title: `${full}, ${city} | Spokeo`,
        text: `${full}, age 34, lives in ${city}. Relatives, phone numbers and address history.`,
        label: 'wrong',
        why: 'a background-check site: blocked',
      },
      {
        url: `https://chess.example/${otherCity.toLowerCase()}/${slug}`,
        title: `${full} wins the ${city} open chess tournament`,
        text: `${full}, a retired teacher, won the open section.`,
        label: 'wrong',
        why: 'a namesake who only shares the city',
      },
      {
        url: `https://www.linkedin.com/in/${slug}`,
        title: `${full} - ${title} - ${org} | LinkedIn`,
        text: `${full}. ${title} at ${org}. ${school}.`,
        label: 'wrong',
        why: 'LinkedIn itself: the profile is the LinkedIn source, never a web page',
      },
    ];
    // a namesake who builds on the employer's product: "the Plaid API" is not a job at Plaid
    if (['Stripe', 'Figma', 'Google', 'Notion', 'Databricks', 'Amazon'].includes(org))
      pages.push({
        url: `https://portfolio.example/${first.toLowerCase()}-${last.toLowerCase()}-${i}`,
        title: `${full} | Freelance developer`,
        text: `Hi, I'm ${full}. My latest project syncs invoices with the ${org} API and runs on Vercel.`,
        label: 'wrong',
        why: "a namesake who builds on the employer's product",
      });
    const trap = wordTrap(org, full);
    if (trap)
      pages.push({
        url: `https://misc.example/${slug}/word`,
        ...trap,
        label: 'wrong',
        why: `shares the word "${org}" with the employer, not the company`,
      });
    // personal sites: the address is their name. Theirs says where they work; a namesake's does not, and is not them
    if (i % 4 === 0)
      pages.push({
        url: `https://${first.toLowerCase()}${last.toLowerCase()}${i}.dev/about`,
        title: `About ${first}`,
        text: `Hi, I'm ${full}, a ${title.toLowerCase()} at ${org}. I write about product and engineering.`,
        label: 'right',
        why: 'their own site',
      });
    pages.push({
      url: `https://www.${first.toLowerCase()}${last.toLowerCase()}.media/`,
      title: `${full} | Photography`,
      text: `I'm ${full}, a wedding photographer. Book a session.`,
      label: 'wrong',
      why: "a namesake's site named after the name",
    });
    out.push({
      id,
      input: {
        name: full,
        firstName: first,
        lastName: last,
        org,
        title,
        location,
        linkedinUrl: `https://www.linkedin.com/in/${slug}`,
        profile: {
          headline: `${title} at ${org}`,
          location,
          publicIdentifier: slug,
          experience: [
            { title, company: org, current: true },
            { title: 'Analyst', company: prev, current: false },
          ],
          education: [{ school }],
        },
      },
      pages,
    });
  }
  // the honest hard case: a second Michael Chen at the same company, in another office. A page about him names the
  // same employer, so research cannot tell them apart from the page alone; it counts against precision.
  const mc = out.find((p) => p.input.name === 'Michael Chen')!;
  mc.pages.push({
    url: 'https://zurich.example/michael-chen',
    title: `Michael Chen joins the ${mc.input.org} Zurich office`,
    text: `Michael Chen, who moved from Singapore, now leads the ${mc.input.org} Zurich team.`,
    label: 'wrong',
    why: 'a namesake at the same employer: the case research cannot settle from one page',
  });
  return out;
}

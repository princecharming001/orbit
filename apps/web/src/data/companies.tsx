/**
 * Companies to suggest as targets: the ones students aim for most, and any company already in the student's own
 * network (someone there is the best way in). Free text still wins; this just saves the typing.
 */
import { companyDomain, companyLogoUrl, normalizeCompany } from '@orbit/core';
import { db } from '../db/schema';
import type { Suggestion } from '../ui/Suggest';

export const COMMON_COMPANIES = [
  // tech
  'Google',
  'Meta',
  'Apple',
  'Amazon',
  'Microsoft',
  'Netflix',
  'NVIDIA',
  'OpenAI',
  'Anthropic',
  'Stripe',
  'Figma',
  'Notion',
  'Linear',
  'Ramp',
  'Vercel',
  'Datadog',
  'Airbnb',
  'Uber',
  'Lyft',
  'DoorDash',
  'Instacart',
  'Shopify',
  'Salesforce',
  'Oracle',
  'IBM',
  'Intel',
  'AMD',
  'Tesla',
  'SpaceX',
  'Palantir',
  'Databricks',
  'Snowflake',
  'Scale AI',
  'Coinbase',
  'Robinhood',
  'Plaid',
  'Brex',
  'Rippling',
  'Anduril',
  'Roblox',
  'Snap',
  'Pinterest',
  'Reddit',
  'Dropbox',
  'Atlassian',
  'Adobe',
  'Cisco',
  'Qualcomm',
  'Samsung',
  'ByteDance',
  'TikTok',
  'Cloudflare',
  'MongoDB',
  'HubSpot',
  'Duolingo',
  'Perplexity',
  'Mistral',
  'xAI',
  'Hugging Face',
  'Waymo',
  'Cruise',
  'Rivian',
  'Lucid',
  // finance
  'Goldman Sachs',
  'Morgan Stanley',
  'J.P. Morgan',
  'Bank of America',
  'Citi',
  'Evercore',
  'Lazard',
  'Moelis',
  'Centerview',
  'PJT Partners',
  'Jefferies',
  'Barclays',
  'UBS',
  'Deutsche Bank',
  'Wells Fargo',
  'RBC',
  'Houlihan Lokey',
  'Guggenheim',
  'Rothschild',
  'Perella Weinberg',
  'Qatalyst',
  'Blackstone',
  'KKR',
  'Apollo',
  'Carlyle',
  'TPG',
  'Bain Capital',
  'Warburg Pincus',
  'Vista Equity',
  'Thoma Bravo',
  'Silver Lake',
  'Citadel',
  'Citadel Securities',
  'Jane Street',
  'Two Sigma',
  'D. E. Shaw',
  'Hudson River Trading',
  'Jump Trading',
  'Optiver',
  'IMC',
  'SIG',
  'Point72',
  'Millennium',
  'Bridgewater',
  'Renaissance Technologies',
  'AQR',
  'BlackRock',
  'Vanguard',
  'Fidelity',
  'Capital One',
  'American Express',
  'Visa',
  'Mastercard',
  // venture
  'Sequoia',
  'Andreessen Horowitz',
  'Benchmark',
  'Accel',
  'Greylock',
  'Kleiner Perkins',
  'Lightspeed',
  'General Catalyst',
  'Founders Fund',
  'Index Ventures',
  'Bessemer',
  'Insight Partners',
  'Y Combinator',
  'Thrive Capital',
  'Khosla Ventures',
  'NEA',
  // consulting
  'McKinsey',
  'BCG',
  'Bain',
  'Deloitte',
  'PwC',
  'EY',
  'KPMG',
  'Accenture',
  'Oliver Wyman',
  'Kearney',
  'L.E.K.',
  'Roland Berger',
  'Booz Allen',
  'ZS',
  'Analysis Group',
  'Cornerstone Research',
  'Charles River Associates',
  // other
  'Nike',
  'Disney',
  'Procter & Gamble',
  'Unilever',
  'PepsiCo',
  'Coca-Cola',
  'Johnson & Johnson',
  'Pfizer',
  'Moderna',
  'Genentech',
  'Boeing',
  'Lockheed Martin',
  'Northrop Grumman',
  'Raytheon',
  'General Motors',
  'Ford',
  'Walmart',
  'Target',
  'Costco',
  'Starbucks',
  'Spotify',
  'Warner Bros. Discovery',
  'The New York Times',
  'Bloomberg',
  'Federal Reserve',
  'World Bank',
  'United Nations',
];

const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function Logo({ name }: { name: string }) {
  const domain = companyDomain(name);
  if (!domain) return <span className="w-5 h-5 shrink-0 rounded-md bg-canvas-2" aria-hidden />;
  return (
    <img
      src={companyLogoUrl(domain)}
      alt=""
      className="w-5 h-5 shrink-0 rounded-md object-contain bg-canvas"
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
      }}
    />
  );
}

/**
 * Company suggestions for what is typed: the student's own network first ("3 people there"), then the common
 * ones. `taken` are companies already on the list, left out.
 */
export async function suggestCompanies(
  query: string,
  taken: string[] = [],
  limit = 8,
): Promise<Suggestion[]> {
  const q = fold(query);
  if (!q) return [];
  const takenKeys = new Set(taken.map((t) => normalizeCompany(t)));
  const out = new Map<string, Suggestion & { rank: number }>();
  const add = (name: string, sub: string | undefined, rank: number) => {
    const key = normalizeCompany(name);
    if (!key || takenKeys.has(key)) return;
    const f = fold(name);
    const score = f.startsWith(q)
      ? 2
      : f.split(' ').some((w) => w.startsWith(q))
        ? 1
        : f.includes(q)
          ? 0.5
          : 0;
    if (!score) return;
    const cur = out.get(key);
    if (!cur || cur.rank < rank + score)
      out.set(key, { value: name, sub, mark: <Logo name={name} />, rank: rank + score });
  };
  // the network: how many people the student knows at each company
  const people = await db.people.filter((p) => !!p.currentOrganizationRaw && !p.hiddenAt).toArray();
  const counts = new Map<string, { name: string; n: number }>();
  for (const p of people) {
    const key = normalizeCompany(p.currentOrganizationRaw);
    if (!key) continue;
    const c = counts.get(key) ?? { name: p.currentOrganizationRaw!, n: 0 };
    c.n++;
    counts.set(key, c);
  }
  for (const { name, n } of counts.values())
    add(name, `${n} ${n === 1 ? 'person' : 'people'} you know there`, 10 + Math.min(n, 5));
  for (const name of COMMON_COMPANIES) add(name, undefined, 0);
  return [...out.values()]
    .sort((a, b) => b.rank - a.rank || a.value.length - b.value.length)
    .slice(0, limit)
    .map(({ rank: _r, ...s }) => s);
}

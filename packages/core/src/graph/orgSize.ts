import { normalizeCompany } from '../text/normalize';

/**
 * Approximate headcount buckets (LinkedIn style) for employers students most often target. Used only when an
 * organization has no sizeBucket of its own, so that "both at Google" is weighed like a 150,000-person company and
 * not like a 12-person startup. Keys are normalizeCompany() forms.
 */
const KNOWN_SIZES: Record<string, string> = {};
const add = (bucket: string, names: string[]) => {
  for (const n of names) KNOWN_SIZES[normalizeCompany(n)] = bucket;
};
add('10001+', [
  'Google',
  'Alphabet',
  'Meta',
  'Facebook',
  'Amazon',
  'Amazon Web Services',
  'AWS',
  'Microsoft',
  'Apple',
  'Netflix',
  'Oracle',
  'Salesforce',
  'Adobe',
  'IBM',
  'Intel',
  'NVIDIA',
  'Cisco',
  'Uber',
  'Tesla',
  'SpaceX',
  'Qualcomm',
  'Intuit',
  'PayPal',
  'ServiceNow',
  'Workday',
  'VMware',
  'Dell',
  'HP',
  'Accenture',
  'Deloitte',
  'PwC',
  'PricewaterhouseCoopers',
  'EY',
  'Ernst & Young',
  'KPMG',
  'McKinsey & Company',
  'McKinsey',
  'Boston Consulting Group',
  'BCG',
  'Bain & Company',
  'Bain',
  'Booz Allen Hamilton',
  'Capgemini',
  'Goldman Sachs',
  'JPMorgan Chase',
  'JP Morgan',
  'J.P. Morgan',
  'Morgan Stanley',
  'Bank of America',
  'Citi',
  'Citigroup',
  'Wells Fargo',
  'Barclays',
  'UBS',
  'Deutsche Bank',
  'HSBC',
  'BlackRock',
  'Fidelity Investments',
  'Vanguard',
  'Capital One',
  'American Express',
  'Visa',
  'Mastercard',
  'Charles Schwab',
  'State Street',
  'Procter & Gamble',
  'PepsiCo',
  'Coca-Cola',
  'Johnson & Johnson',
  'Pfizer',
  'Walmart',
  'Target',
  'Nike',
  'Disney',
  'The Walt Disney Company',
  'Comcast',
  'Verizon',
  'AT&T',
  'Boeing',
  'Lockheed Martin',
  'General Electric',
  'GE',
  'General Motors',
  'Ford',
  'ByteDance',
  'TikTok',
  'Samsung',
  'Bloomberg',
  'LinkedIn',
  'Shopify',
  'Booking.com',
]);
add('5001-10000', [
  'Stripe',
  'Airbnb',
  'Snap',
  'Snapchat',
  'Spotify',
  'Block',
  'Square',
  'DoorDash',
  'Lyft',
  'Datadog',
  'Atlassian',
  'Palantir',
  'Coinbase',
  'Robinhood',
  'Pinterest',
  'Dropbox',
  'Instacart',
  'Lazard',
  'Evercore',
  'Jane Street',
  'Citadel',
  'Two Sigma',
  'Oliver Wyman',
  'LEK Consulting',
  'Kearney',
]);
add('1001-5000', [
  'Figma',
  'Anthropic',
  'OpenAI',
  'Ramp',
  'Brex',
  'Databricks',
  'Snowflake',
  'Plaid',
  'Notion',
  'Duolingo',
  'Reddit',
  'Discord',
  'Scale AI',
  'Asana',
  'Airtable',
  'Hudson River Trading',
  'DE Shaw',
  'D. E. Shaw',
  'Point72',
  'Centerview Partners',
  'PJT Partners',
  'Moelis',
  'Moelis & Company',
  'Perella Weinberg',
  'Guggenheim Partners',
  'Blackstone',
  'KKR',
  'Apollo',
  'Carlyle',
]);
add('501-1000', ['Vercel', 'Retool', 'Rippling', 'Mercury', 'Jump Trading', 'Optiver', 'Five Rings']);
add('201-500', ['Linear', 'Sequoia Capital', 'Andreessen Horowitz', 'a16z', 'Benchmark', 'Accel']);

export function knownSizeBucket(name: string | undefined): string | undefined {
  const n = normalizeCompany(name);
  return n ? KNOWN_SIZES[n] : undefined;
}

/**
 * How much "both at this company" says about two people knowing each other: 1 for small teams, 0.7 for mid-size,
 * 0.4 for very large employers. Order of evidence: the organization's own sizeBucket, the known-employer table,
 * then how many people at that company are in the student's own network (30+ suggests a big employer).
 */
export function sizeFactor(
  sizeBucket: string | undefined,
  name: string | undefined,
  networkCount = 0,
): number {
  const b = sizeBucket ?? knownSizeBucket(name);
  if (b) {
    if (['1-10', '2-10', '11-50', '51-200'].includes(b)) return 1;
    if (['201-500', '501-1000', '1001-5000'].includes(b)) return 0.7;
    return 0.4;
  }
  if (networkCount >= 30) return 0.4;
  if (networkCount >= 12) return 0.6;
  return 0.5;
}

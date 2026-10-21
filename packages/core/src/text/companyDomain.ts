import { PERSONAL_EMAIL_DOMAINS } from '../entity/resolve';
import { normalizeCompany } from './normalize';

/**
 * The web domain of a company, for its logo. Orbit rarely stores one, so it is found from what it has: a domain on
 * the organisation, a work address of someone there, a list of the companies students aim for most, and for a
 * one-word name its .com. Returns undefined when none of those gives a confident answer.
 */
const KNOWN: Record<string, string> = {
  // tech
  google: 'google.com',
  alphabet: 'abc.xyz',
  meta: 'meta.com',
  apple: 'apple.com',
  amazon: 'amazon.com',
  'amazon web services': 'aws.amazon.com',
  aws: 'aws.amazon.com',
  microsoft: 'microsoft.com',
  netflix: 'netflix.com',
  nvidia: 'nvidia.com',
  openai: 'openai.com',
  anthropic: 'anthropic.com',
  stripe: 'stripe.com',
  figma: 'figma.com',
  notion: 'notion.so',
  linear: 'linear.app',
  ramp: 'ramp.com',
  vercel: 'vercel.com',
  datadog: 'datadoghq.com',
  airbnb: 'airbnb.com',
  uber: 'uber.com',
  lyft: 'lyft.com',
  doordash: 'doordash.com',
  instacart: 'instacart.com',
  shopify: 'shopify.com',
  salesforce: 'salesforce.com',
  oracle: 'oracle.com',
  ibm: 'ibm.com',
  intel: 'intel.com',
  amd: 'amd.com',
  adobe: 'adobe.com',
  atlassian: 'atlassian.com',
  slack: 'slack.com',
  dropbox: 'dropbox.com',
  snowflake: 'snowflake.com',
  databricks: 'databricks.com',
  palantir: 'palantir.com',
  scale: 'scale.com',
  'scale ai': 'scale.com',
  plaid: 'plaid.com',
  brex: 'brex.com',
  robinhood: 'robinhood.com',
  coinbase: 'coinbase.com',
  square: 'squareup.com',
  block: 'block.xyz',
  spotify: 'spotify.com',
  pinterest: 'pinterest.com',
  snap: 'snap.com',
  'snap inc': 'snap.com',
  linkedin: 'linkedin.com',
  twitter: 'x.com',
  x: 'x.com',
  tesla: 'tesla.com',
  spacex: 'spacex.com',
  github: 'github.com',
  gitlab: 'gitlab.com',
  cloudflare: 'cloudflare.com',
  twilio: 'twilio.com',
  hubspot: 'hubspot.com',
  asana: 'asana.com',
  canva: 'canva.com',
  duolingo: 'duolingo.com',
  discord: 'discord.com',
  reddit: 'reddit.com',
  roblox: 'roblox.com',
  zoom: 'zoom.us',
  retool: 'retool.com',
  rippling: 'rippling.com',
  gusto: 'gusto.com',
  deel: 'deel.com',
  mercury: 'mercury.com',
  airtable: 'airtable.com',
  webflow: 'webflow.com',
  replit: 'replit.com',
  cursor: 'cursor.com',
  anysphere: 'cursor.com',
  perplexity: 'perplexity.ai',
  'hugging face': 'huggingface.co',
  cohere: 'cohere.com',
  mistral: 'mistral.ai',
  'mistral ai': 'mistral.ai',
  'character ai': 'character.ai',
  waymo: 'waymo.com',
  deepmind: 'deepmind.google',
  'google deepmind': 'deepmind.google',
  bytedance: 'bytedance.com',
  tiktok: 'tiktok.com',
  // finance
  'goldman sachs': 'goldmansachs.com',
  'morgan stanley': 'morganstanley.com',
  'jp morgan': 'jpmorganchase.com',
  'jpmorgan chase': 'jpmorganchase.com',
  jpmorgan: 'jpmorganchase.com',
  'bank of america': 'bankofamerica.com',
  citi: 'citi.com',
  'wells fargo': 'wellsfargo.com',
  blackrock: 'blackrock.com',
  blackstone: 'blackstone.com',
  kkr: 'kkr.com',
  carlyle: 'carlyle.com',
  citadel: 'citadel.com',
  'citadel securities': 'citadelsecurities.com',
  'jane street': 'janestreet.com',
  'two sigma': 'twosigma.com',
  'd e shaw': 'deshaw.com',
  'de shaw': 'deshaw.com',
  'hudson river trading': 'hudsonrivertrading.com',
  'jump trading': 'jumptrading.com',
  optiver: 'optiver.com',
  'imc trading': 'imc.com',
  imc: 'imc.com',
  sig: 'sig.com',
  'susquehanna international group': 'sig.com',
  bridgewater: 'bridgewater.com',
  'bridgewater associates': 'bridgewater.com',
  evercore: 'evercore.com',
  lazard: 'lazard.com',
  'centerview partners': 'centerviewpartners.com',
  'pjt partners': 'pjtpartners.com',
  moelis: 'moelis.com',
  'moelis & company': 'moelis.com',
  barclays: 'barclays.com',
  ubs: 'ubs.com',
  'deutsche bank': 'db.com',
  'credit suisse': 'credit-suisse.com',
  fidelity: 'fidelity.com',
  'fidelity investments': 'fidelity.com',
  vanguard: 'vanguard.com',
  visa: 'visa.com',
  mastercard: 'mastercard.com',
  'american express': 'americanexpress.com',
  amex: 'americanexpress.com',
  paypal: 'paypal.com',
  'capital one': 'capitalone.com',
  // venture
  'andreessen horowitz': 'a16z.com',
  a16z: 'a16z.com',
  sequoia: 'sequoiacap.com',
  'sequoia capital': 'sequoiacap.com',
  'y combinator': 'ycombinator.com',
  accel: 'accel.com',
  benchmark: 'benchmark.com',
  'kleiner perkins': 'kleinerperkins.com',
  greylock: 'greylock.com',
  'lightspeed venture partners': 'lsvp.com',
  'general catalyst': 'generalcatalyst.com',
  'index ventures': 'indexventures.com',
  'founders fund': 'foundersfund.com',
  // consulting
  mckinsey: 'mckinsey.com',
  'mckinsey & company': 'mckinsey.com',
  bain: 'bain.com',
  'bain & company': 'bain.com',
  'boston consulting group': 'bcg.com',
  bcg: 'bcg.com',
  deloitte: 'deloitte.com',
  pwc: 'pwc.com',
  pricewaterhousecoopers: 'pwc.com',
  ey: 'ey.com',
  'ernst & young': 'ey.com',
  kpmg: 'kpmg.com',
  accenture: 'accenture.com',
  'oliver wyman': 'oliverwyman.com',
  'l e k consulting': 'lek.com',
  'lek consulting': 'lek.com',
  // other
  disney: 'disney.com',
  'the walt disney company': 'disney.com',
  nike: 'nike.com',
  'procter & gamble': 'pg.com',
  'p&g': 'pg.com',
  pepsico: 'pepsico.com',
  'coca cola': 'coca-colacompany.com',
  'johnson & johnson': 'jnj.com',
  pfizer: 'pfizer.com',
  boeing: 'boeing.com',
  'lockheed martin': 'lockheedmartin.com',
  walmart: 'walmart.com',
  target: 'target.com',
  'teach for america': 'teachforamerica.org',
  // schools, for education lines
  'cornell university': 'cornell.edu',
  cornell: 'cornell.edu',
  'georgia tech': 'gatech.edu',
  'georgia institute of technology': 'gatech.edu',
  'carnegie mellon university': 'cmu.edu',
  'carnegie mellon': 'cmu.edu',
  mit: 'mit.edu',
  'massachusetts institute of technology': 'mit.edu',
  'stanford university': 'stanford.edu',
  stanford: 'stanford.edu',
  'harvard university': 'harvard.edu',
  harvard: 'harvard.edu',
  'yale university': 'yale.edu',
  'princeton university': 'princeton.edu',
  'columbia university': 'columbia.edu',
  'university of pennsylvania': 'upenn.edu',
  upenn: 'upenn.edu',
  wharton: 'upenn.edu',
  'brown university': 'brown.edu',
  'dartmouth college': 'dartmouth.edu',
  'duke university': 'duke.edu',
  'northwestern university': 'northwestern.edu',
  'university of chicago': 'uchicago.edu',
  'new york university': 'nyu.edu',
  nyu: 'nyu.edu',
  'uc berkeley': 'berkeley.edu',
  'university of california berkeley': 'berkeley.edu',
  'university of california, berkeley': 'berkeley.edu',
  ucla: 'ucla.edu',
  'university of michigan': 'umich.edu',
  'university of texas at austin': 'utexas.edu',
  'ut austin': 'utexas.edu',
  'university of washington': 'uw.edu',
  'university of illinois urbana champaign': 'illinois.edu',
  uiuc: 'illinois.edu',
  'university of southern california': 'usc.edu',
  usc: 'usc.edu',
  'university of virginia': 'virginia.edu',
  'georgetown university': 'georgetown.edu',
  'rice university': 'rice.edu',
  'vanderbilt university': 'vanderbilt.edu',
  'johns hopkins university': 'jhu.edu',
  'boston university': 'bu.edu',
  'purdue university': 'purdue.edu',
  'university of waterloo': 'uwaterloo.ca',
  'university of toronto': 'utoronto.ca',
};

/** A host as a domain: no scheme, no www, no path. */
function bare(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '');
}

/** The list keyed the way Orbit keys companies, so "McKinsey & Company" and "McKinsey" find the same entry. */
const BY_NAME = new Map(Object.entries(KNOWN).map(([k, v]) => [normalizeCompany(k), v]));

const DOMAIN = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function companyDomain(
  name: string | undefined,
  hints: { domains?: string[]; emails?: (string | undefined)[] } = {},
): string | undefined {
  for (const d of hints.domains ?? []) {
    const b = bare(d);
    if (DOMAIN.test(b)) return b;
  }
  const norm = normalizeCompany(name);
  if (norm && BY_NAME.has(norm)) return BY_NAME.get(norm);
  // a work address (not a free mailbox, not a school) names the employer's domain
  for (const e of hints.emails ?? []) {
    const d = e?.split('@')[1]?.toLowerCase().trim();
    if (d && DOMAIN.test(d) && !PERSONAL_EMAIL_DOMAINS.has(d) && !d.endsWith('.edu')) return d;
  }
  if (!norm) return undefined;
  // a one-word name is usually its own .com ("Ramp", "Figma"); longer names are too often wrong to guess
  if (/^[a-z0-9]{3,}$/.test(norm)) return `${norm}.com`;
  return undefined;
}

/** The logo image for a domain: the site's own icon, from DuckDuckGo's icon service (a 404 when it has none). */
export function companyLogoUrl(domain: string): string {
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;
}

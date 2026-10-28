/**
 * Finding a company's logo image for its web domain. The logos shipped with the app (public/logos: the companies and
 * schools students name most) come first and need no network. Otherwise DuckDuckGo's and Google's icon services are
 * asked; they answer a site they have no icon for with a stand-in picture (a grey arrow, a globe) and a status the
 * page cannot read, so each source is loaded off screen and judged by its size (core judgeLogo) before a tile shows
 * it: DuckDuckGo, then Google, then the site's own touch icon and favicon. The answer is kept per domain in this
 * browser (two weeks for a logo, three days for none), so a page full of the same company asks once.
 */
import { judgeLogo, logoSources } from '@orbit/core';

/** The logos in public/logos, by the domain they belong to (and the file's name there). */
const BUNDLED: Record<string, string> = {
  '3m.com': '3m',
  '8vc.com': '8vc',
  'a24films.com': 'a24',
  'abbott.com': 'abbott',
  'accenture.com': 'accenture',
  'adidas.com': 'adidas',
  'adobe.com': 'adobe',
  'affirm.com': 'affirm',
  'airbnb.com': 'airbnb',
  'airbus.com': 'airbus',
  'airtable.com': 'airtable',
  'alibaba.com': 'alibaba',
  'alvarezandmarsal.com': 'alvarezmarsal',
  'amazon.com': 'amazon',
  'aws.amazon.com': 'amazon',
  'aa.com': 'americanairlines',
  'americanexpress.com': 'americanexpress',
  'amplitude.com': 'amplitude',
  'anduril.com': 'anduril',
  'anheuser-busch.com': 'anheuserbusch',
  'anthropic.com': 'anthropic',
  'apollo.com': 'apollo',
  'apple.com': 'apple',
  'appliedmaterials.com': 'appliedmaterials',
  'aqr.com': 'aqr',
  'arm.com': 'arm',
  'asana.com': 'asana',
  'asml.com': 'asml',
  'astrazeneca.com': 'astrazeneca',
  'att.com': 'atandt',
  'atlassian.com': 'atlassian',
  'baidu.com': 'baidu',
  'bain.com': 'bain',
  'rwbaird.com': 'baird',
  'bamfunds.com': 'balyasny',
  'bankofamerica.com': 'bankofamerica',
  'barclays.com': 'barclays',
  'battery.com': 'batteryventures',
  'bcg.com': 'bcg',
  'berkeley.edu': 'berkeley',
  'bird.co': 'bird',
  'blackstone.com': 'blackstone',
  'bloomberg.com': 'bloomberg',
  'blueorigin.com': 'blueorigin',
  'blueowl.com': 'blueowl',
  'bmo.com': 'bmo',
  'bmw.com': 'bmw',
  'bnpparibas.com': 'bnpparibas',
  'bny.com': 'bny',
  'booking.com': 'bookingcom',
  'boozallen.com': 'boozallen',
  'bostonscientific.com': 'bostonscientific',
  'bp.com': 'bp',
  'brex.com': 'brex',
  'broadcom.com': 'broadcom',
  'brookfield.com': 'brookfield',
  'brookings.edu': 'brookings',
  'brown.edu': 'brown',
  'bumble.com': 'bumble',
  'buzzfeed.com': 'buzzfeed',
  'bytedance.com': 'bytedance',
  'calendly.com': 'calendly',
  'caltech.edu': 'caltech',
  'canva.com': 'canva',
  'capgemini.com': 'capgemini',
  'capitalgroup.com': 'capitalgroup',
  'capitalone.com': 'capitalone',
  'carlyle.com': 'carlyle',
  'cash.app': 'cashapp',
  'caterpillar.com': 'caterpillar',
  'cdc.gov': 'cdc',
  'cdr-inc.com': 'cdr',
  'cerebras.ai': 'cerebras',
  'cfr.org': 'cfr',
  'character.ai': 'characterai',
  'schwab.com': 'charlesschwab',
  'chevron.com': 'chevron',
  'chewy.com': 'chewy',
  'chime.com': 'chime',
  'chipotle.com': 'chipotle',
  'cia.gov': 'cia',
  'citadel.com': 'citadel',
  'citadelsecurities.com': 'citadel',
  'citi.com': 'citi',
  'clay.com': 'clay',
  'cloudflare.com': 'cloudflare',
  'cmegroup.com': 'cmegroup',
  'cmu.edu': 'cmu',
  'cnn.com': 'cnn',
  'coatue.com': 'coatue',
  'coca-colacompany.com': 'cocacola',
  'cognition.ai': 'cognition',
  'cohere.com': 'cohere',
  'coinbase.com': 'coinbase',
  'colgatepalmolive.com': 'colgate',
  'columbia.edu': 'columbia',
  'condenast.com': 'condenast',
  'confluent.io': 'confluent',
  'cooley.com': 'cooley',
  'coreweave.com': 'coreweave',
  'cornell.edu': 'cornell',
  'crai.com': 'cra',
  'cravath.com': 'cravath',
  'crowdstrike.com': 'crowdstrike',
  'crv.com': 'crv',
  'cursor.com': 'cursor',
  'cvc.com': 'cvc',
  'dartmouth.edu': 'dartmouth',
  'databricks.com': 'databricks',
  'datadoghq.com': 'datadog',
  'decagon.ai': 'decagon',
  'deel.com': 'deel',
  'deepmind.google': 'deepmind',
  'dell.com': 'dell',
  'deloitte.com': 'deloitte',
  'delta.com': 'delta',
  'db.com': 'deutschebank',
  'discord.com': 'discord',
  'disney.com': 'disney',
  'docker.com': 'docker',
  'dreamworks.com': 'dreamworks',
  'drw.com': 'drw',
  'duke.edu': 'duke',
  'duolingo.com': 'duolingo',
  'ea.com': 'ea',
  'ebay.com': 'ebay',
  'economist.com': 'economist',
  'elastic.co': 'elastic',
  'elevenlabs.io': 'elevenlabs',
  'lilly.com': 'elililly',
  'epicgames.com': 'epicgames',
  'epic.com': 'epicsystems',
  'espn.com': 'espn',
  'etsy.com': 'etsy',
  'evercore.com': 'evercore',
  'exoduspoint.com': 'exoduspoint',
  'expedia.com': 'expedia',
  'faire.com': 'faire',
  'federalreserve.gov': 'federalreserve',
  'felicis.com': 'felicis',
  'fidelity.com': 'fidelity',
  'figma.com': 'figma',
  'figure.ai': 'figure',
  'firstround.com': 'firstround',
  'fiverings.com': 'fiverings',
  'flexport.com': 'flexport',
  'ford.com': 'ford',
  'gartner.com': 'gartner',
  'gatech.edu': 'gatech',
  'gatesfoundation.org': 'gates',
  'ge.com': 'ge',
  'gene.com': 'genentech',
  'generalatlantic.com': 'generalatlantic',
  'generalcatalyst.com': 'generalcatalyst',
  'gd.com': 'generaldynamics',
  'georgetown.edu': 'georgetown',
  'gibsondunn.com': 'gibsondunn',
  'gilead.com': 'gilead',
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'glean.com': 'glean',
  'gm.com': 'gm',
  'goldmansachs.com': 'goldman',
  'gs.com': 'goldman',
  'google.com': 'google',
  'gopuff.com': 'gopuff',
  'grab.com': 'grab',
  'grammarly.com': 'grammarly',
  'greylock.com': 'greylock',
  'gsk.com': 'gsk',
  'gv.com': 'gv',
  'harvard.edu': 'harvard',
  'harvey.ai': 'harvey',
  'hashicorp.com': 'hashicorp',
  'helionenergy.com': 'helion',
  'hf.com': 'hellmanfriedman',
  'thehersheycompany.com': 'hershey',
  'honeywell.com': 'honeywell',
  'hl.com': 'houlihan',
  'hp.com': 'hp',
  'hudsonrivertrading.com': 'hrt',
  'hsbc.com': 'hsbc',
  'hubspot.com': 'hubspot',
  'huggingface.co': 'huggingface',
  'ice.com': 'ice',
  'ideo.com': 'ideo',
  'illinois.edu': 'illinois',
  'indexventures.com': 'indexventures',
  'inflection.ai': 'inflectionai',
  'initialized.com': 'initialized',
  'instacart.com': 'instacart',
  'invesco.com': 'invesco',
  'ivp.com': 'ivp',
  'janestreet.com': 'janestreet',
  'jasper.ai': 'jasper',
  'jd.com': 'jdcom',
  'jefferies.com': 'jefferies',
  'jhu.edu': 'jhu',
  'jnj.com': 'jnj',
  'jobyaviation.com': 'jobyaviation',
  'jpmorganchase.com': 'jpmorgan',
  'jumptrading.com': 'jumptrading',
  'kearney.com': 'kearney',
  'khanacademy.org': 'khanacademy',
  'khoslaventures.com': 'khoslaventures',
  'kimberly-clark.com': 'kimberlyclark',
  'kirkland.com': 'kirkland',
  'kkr.com': 'kkr',
  'klarna.com': 'klarna',
  'lambda.ai': 'lambda',
  'langchain.com': 'langchain',
  'lw.com': 'latham',
  'lazard.com': 'lazard',
  'leonardgreen.com': 'leonardgreen',
  'levi.com': 'levis',
  'lsvp.com': 'lightspeed',
  'li.me': 'lime',
  'linear.app': 'linear',
  'linkedin.com': 'linkedin',
  'lockheedmartin.com': 'lockheed',
  'lovable.dev': 'lovable',
  'lucidmotors.com': 'lucid',
  'lululemon.com': 'lululemon',
  'luxcapital.com': 'luxcapital',
  'lvmh.com': 'lvmh',
  'lyft.com': 'lyft',
  'maersk.com': 'maersk',
  'man.com': 'mangroup',
  'mastercard.com': 'mastercard',
  'mtch.com': 'matchgroup',
  'mayoclinic.org': 'mayoclinic',
  'mcdonalds.com': 'mcdonalds',
  'mckinsey.com': 'mckinsey',
  'medium.com': 'medium',
  'medtronic.com': 'medtronic',
  'menlovc.com': 'menloventures',
  'mercadolibre.com': 'mercadolibre',
  'mercedes-benz.com': 'mercedesbenz',
  'merck.com': 'merck',
  'mercury.com': 'mercury',
  'meta.com': 'meta',
  'micron.com': 'micron',
  'microsoft.com': 'microsoft',
  'midjourney.com': 'midjourney',
  'miro.com': 'miro',
  'mistral.ai': 'mistral',
  'mit.edu': 'mit',
  'mizuhogroup.com': 'mizuho',
  'mlb.com': 'mlb',
  'modal.com': 'modal',
  'modernatx.com': 'moderna',
  'moelis.com': 'moelis',
  'mondelezinternational.com': 'mondelez',
  'mongodb.com': 'mongodb',
  'moodys.com': 'moodys',
  'morganstanley.com': 'morganstanley',
  'mozilla.org': 'mozilla',
  'msci.com': 'msci',
  'mufg.jp': 'mufg',
  'nasa.gov': 'nasa',
  'nasdaq.com': 'nasdaq',
  'nba.com': 'nba',
  'nea.com': 'nea',
  'nestle.com': 'nestle',
  'netflix.com': 'netflix',
  'nextdoor.com': 'nextdoor',
  'nfl.com': 'nfl',
  'nike.com': 'nike',
  'nintendo.com': 'nintendo',
  'northerntrust.com': 'northerntrust',
  'northropgrumman.com': 'northrop',
  'northwestern.edu': 'northwestern',
  'notion.so': 'notion',
  'makenotion.com': 'notion',
  'nd.edu': 'notredame',
  'novartis.com': 'novartis',
  'novonordisk.com': 'novonordisk',
  'nubank.com.br': 'nubank',
  'nvidia.com': 'nvidia',
  'nytimes.com': 'nytimes',
  'nyu.edu': 'nyu',
  'okta.com': 'okta',
  'oliverwyman.com': 'oliverwyman',
  'onemedical.com': 'onemedical',
  'openai.com': 'openai',
  'opendoor.com': 'opendoor',
  'optiver.com': 'optiver',
  'oracle.com': 'oracle',
  'hioscar.com': 'oscarhealth',
  'palantir.com': 'palantir',
  'paloaltonetworks.com': 'paloalto',
  'paramount.com': 'paramount',
  'patagonia.com': 'patagonia',
  'patreon.com': 'patreon',
  'paulweiss.com': 'paulweiss',
  'paypal.com': 'paypal',
  'peacecorps.gov': 'peacecorps',
  'onepeloton.com': 'peloton',
  'upenn.edu': 'penn',
  'pepsico.com': 'pepsico',
  'permira.com': 'permira',
  'perplexity.ai': 'perplexity',
  'pfizer.com': 'pfizer',
  'pg.com': 'pg',
  'physicalintelligence.company': 'physicalintel',
  'pimco.com': 'pimco',
  'pinecone.io': 'pinecone',
  'pinterest.com': 'pinterest',
  'pipersandler.com': 'pipersandler',
  'pixar.com': 'pixar',
  'pjtpartners.com': 'pjtpartners',
  'plaid.com': 'plaid',
  'pnc.com': 'pnc',
  'point72.com': 'point72',
  'postman.com': 'postman',
  'princeton.edu': 'princeton',
  'pwc.com': 'pwc',
  'pwpartners.com': 'pwp',
  'quora.com': 'quora',
  'rakuten.com': 'rakuten',
  'ramp.com': 'ramp',
  'rand.org': 'rand',
  'rtx.com': 'raytheon',
  'redbull.com': 'redbull',
  'redcross.org': 'redcross',
  'reddit.com': 'reddit',
  'redfin.com': 'redfin',
  'redpoint.com': 'redpoint',
  'regeneron.com': 'regeneron',
  'replit.com': 'replit',
  'retool.com': 'retool',
  'reuters.com': 'reuters',
  'revolut.com': 'revolut',
  'rice.edu': 'rice',
  'riotgames.com': 'riotgames',
  'rippling.com': 'rippling',
  'rivian.com': 'rivian',
  'robinhood.com': 'robinhood',
  'roblox.com': 'roblox',
  'roche.com': 'roche',
  'rocketlabusa.com': 'rocketlab',
  'rolandberger.com': 'rolandberger',
  'rothschildandco.com': 'rothschild',
  'runwayml.com': 'runway',
  'sambanova.ai': 'sambanova',
  'sanofi.com': 'sanofi',
  'santander.com': 'santander',
  'saronic.com': 'saronic',
  'scale.com': 'scale',
  'scotiabank.com': 'scotiabank',
  'sea.com': 'sea',
  'segment.com': 'segment',
  'sequoiacap.com': 'sequoia',
  'servicenow.com': 'servicenow',
  'shell.com': 'shell',
  'shield.ai': 'shieldai',
  'shopify.com': 'shopify',
  'siemens.com': 'siemens',
  'sig.com': 'sig',
  'silverlake.com': 'silverlake',
  'skild.ai': 'skildai',
  'snap.com': 'snap',
  'snowflake.com': 'snowflake',
  'sonymusic.com': 'sonymusic',
  'southwest.com': 'southwest',
  'spacex.com': 'spacex',
  'splunk.com': 'splunk',
  'spotify.com': 'spotify',
  'squareup.com': 'square',
  'squarespace.com': 'squarespace',
  'stanford.edu': 'stanford',
  'starbucks.com': 'starbucks',
  'state.gov': 'statedept',
  'stifel.com': 'stifel',
  'strategyand.pwc.com': 'strategyand',
  'strava.com': 'strava',
  'stripe.com': 'stripe',
  'stryker.com': 'stryker',
  'substack.com': 'substack',
  'supabase.com': 'supabase',
  'sweetgreen.com': 'sweetgreen',
  'target.com': 'target',
  'tdsecurities.com': 'tdsecurities',
  'tesla.com': 'tesla',
  'ti.com': 'ti',
  'tigerglobal.com': 'tigerglobal',
  'tiktok.com': 'tiktok',
  'tinder.com': 'tinder',
  't-mobile.com': 'tmobile',
  'together.ai': 'togetherai',
  'toyota.com': 'toyota',
  'tripadvisor.com': 'tripadvisor',
  'troweprice.com': 'troweprice',
  'twilio.com': 'twilio',
  'twitch.tv': 'twitch',
  'twosigma.com': 'twosigma',
  'uber.com': 'uber',
  'ubs.com': 'ubs',
  'uchicago.edu': 'uchicago',
  'ucla.edu': 'ucla',
  'universalmusic.com': 'umg',
  'umich.edu': 'umich',
  'unilever.com': 'unilever',
  'united.com': 'united',
  'unity.com': 'unity',
  'usc.edu': 'usc',
  'usv.com': 'usv',
  'utexas.edu': 'utexas',
  'virginia.edu': 'uva',
  'vanderbilt.edu': 'vanderbilt',
  'vanguard.com': 'vanguard',
  'vanta.com': 'vanta',
  'vercel.com': 'vercel',
  'verkada.com': 'verkada',
  'vikingglobal.com': 'vikingglobal',
  'virtu.com': 'virtufinancial',
  'visa.com': 'visa',
  'vistaequitypartners.com': 'vistaequity',
  'vmware.com': 'vmware',
  'volkswagen.com': 'volkswagen',
  'voxmedia.com': 'voxmedia',
  'wlrk.com': 'wachtelllipton',
  'walmart.com': 'walmart',
  'wandb.ai': 'wandb',
  'warburgpincus.com': 'warburgpincus',
  'warbyparker.com': 'warbyparker',
  'washingtonpost.com': 'washingtonpost',
  'wayfair.com': 'wayfair',
  'waymo.com': 'waymo',
  'webflow.com': 'webflow',
  'wellsfargo.com': 'wellsfargo',
  'whitehouse.gov': 'whitehouse',
  'wikimediafoundation.org': 'wikimedia',
  'williamblair.com': 'williamblair',
  'wise.com': 'wise',
  'wix.com': 'wix',
  'wmg.com': 'wmg',
  'worldbank.org': 'worldbank',
  'writer.com': 'writer',
  'wsj.com': 'wsj',
  'wustl.edu': 'wustl',
  'x.com': 'x',
  'x.ai': 'xai',
  'yale.edu': 'yale',
  'ycombinator.com': 'ycombinator',
  'yelp.com': 'yelp',
  'youtube.com': 'youtube',
  'zapier.com': 'zapier',
  'zillow.com': 'zillow',
  'zoom.us': 'zoom',
  'zscaler.com': 'zscaler',
};

const base = () => (import.meta.env?.BASE_URL ?? '/').replace(/\/?$/, '/');

/** A logo shipped with the app for this domain, or undefined. */
export function bundledLogo(domain: string): string | undefined {
  const file = BUNDLED[domain.toLowerCase()];
  return file ? `${base()}logos/${file}.png` : undefined;
}

/** Whether an image is one of the app's own logo files. */
export const isBundledLogo = (src: string) => src.startsWith(`${base()}logos/`);

/** The domain a sub-site belongs to: "stern.nyu.edu" is part of "nyu.edu"; undefined for a domain of two parts. */
function parentDomain(domain: string): string | undefined {
  const parts = domain.split('.');
  if (parts.length < 3) return undefined;
  const parent = parts.slice(1).join('.');
  // "ox.ac.uk" has no parent site; "ac.uk" is not one
  return /^(ac|edu|co|com|org|gov)\.[a-z]{2}$/.test(parent) ? undefined : parent;
}

const KEY = 'orbit:logos:v1';
const FOUND_MS = 14 * 86_400_000;
const NONE_MS = 3 * 86_400_000;
const KEEP = 600;

interface Entry {
  /** the image to show, or null when the domain has none */
  src: string | null;
  at: number;
}

let known: Record<string, Entry> | undefined;

function entries(): Record<string, Entry> {
  if (known) return known;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    known = raw && typeof raw === 'object' ? (raw as Record<string, Entry>) : {};
  } catch {
    known = {};
  }
  return known;
}

function remember(domain: string, src: string | null, keep: boolean) {
  const all = entries();
  all[domain] = { src, at: Date.now() };
  if (!keep) return;
  try {
    const kept = Object.entries(all)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, KEEP);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // storage full or blocked: the answer still holds for this visit
  }
}

/**
 * What is known about a domain's logo without loading anything: a logo shipped with the app, an image found before,
 * null for a domain known to have none, undefined when it has not been looked for yet.
 */
export function knownLogo(domain: string, now = Date.now()): string | null | undefined {
  const bundled = bundledLogo(domain);
  if (bundled) return bundled;
  const e = entries()[domain];
  if (!e) return undefined;
  return now - e.at < (e.src ? FOUND_MS : NONE_MS) ? e.src : undefined;
}

/** An image that was found but then failed to show: look again next time. */
export function forgetLogo(domain: string) {
  const all = entries();
  if (!all[domain]) return;
  delete all[domain];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // nothing to do
  }
}

export type ImageSize = { width: number; height: number };

/** Load an image off screen: its natural size, or undefined when it does not load in time. */
export function loadImageSize(url: string, timeoutMs = 8000): Promise<ImageSize | undefined> {
  return new Promise((resolve) => {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    let done = false;
    const finish = (v: ImageSize | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    img.onload = () => finish({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => finish(undefined);
    img.src = url;
  });
}

const running = new Map<string, Promise<string | null>>();

/**
 * The logo image for a domain, or null when no source has a real one. One look per domain at a time; a tiny real
 * icon is used only when nothing larger turns up, and a school inside a university ("stern.nyu.edu") with no icon of
 * its own wears the university's shipped logo. When nothing loaded at all (offline), the answer is not kept.
 */
export function resolveLogo(domain: string, load = loadImageSize): Promise<string | null> {
  const k = knownLogo(domain);
  if (k !== undefined) return Promise.resolve(k);
  const busy = running.get(domain);
  if (busy) return busy;
  const p = (async () => {
    let weak: string | undefined;
    let answered = false;
    for (const s of logoSources(domain)) {
      const size = await load(s.url);
      if (!size) continue;
      answered = true;
      const v = judgeLogo(s.kind, size.width, size.height);
      if (v === 'ok') {
        remember(domain, s.url, true);
        return s.url;
      }
      if (v === 'weak') weak ??= s.url;
    }
    const parent = parentDomain(domain);
    const inherited = parent ? bundledLogo(parent) : undefined;
    const found = weak ?? inherited ?? null;
    remember(domain, found, answered || !!inherited);
    return found;
  })().finally(() => running.delete(domain));
  running.set(domain, p);
  return p;
}

/** For tests: forget everything. */
export function resetLogoCache() {
  known = {};
  running.clear();
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing to do
  }
}

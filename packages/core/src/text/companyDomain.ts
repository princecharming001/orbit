import { PERSONAL_EMAIL_DOMAINS } from '../entity/resolve';
import { normalizeCompany, stripDiacritics } from './normalize';
import { SUB_SCHOOLS, UNIVERSITIES } from './universities';

/**
 * The web domain of a company, for its logo. Orbit rarely stores one, so it is found from what it has: a domain on
 * the organisation, a list of the companies students aim for most, the universities and their schools
 * (universities.ts), a work address of someone there, and for a one-word name its .com. Returns undefined when none
 * of those gives a confident answer.
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
  // the rest of the companies Orbit suggests as targets (apps/web/src/data/companies.tsx)
  anduril: 'anduril.com',
  cisco: 'cisco.com',
  qualcomm: 'qualcomm.com',
  samsung: 'samsung.com',
  mongodb: 'mongodb.com',
  cruise: 'getcruise.com',
  rivian: 'rivian.com',
  lucid: 'lucidmotors.com',
  youtube: 'youtube.com',
  okta: 'okta.com',
  crowdstrike: 'crowdstrike.com',
  'palo alto networks': 'paloaltonetworks.com',
  zscaler: 'zscaler.com',
  servicenow: 'servicenow.com',
  workday: 'workday.com',
  intuit: 'intuit.com',
  'cash app': 'cash.app',
  affirm: 'affirm.com',
  sofi: 'sofi.com',
  klarna: 'klarna.com',
  revolut: 'revolut.com',
  carta: 'carta.com',
  miro: 'miro.com',
  grammarly: 'grammarly.com',
  calendly: 'calendly.com',
  zapier: 'zapier.com',
  supabase: 'supabase.com',
  postman: 'postman.com',
  docker: 'docker.com',
  hashicorp: 'hashicorp.com',
  confluent: 'confluent.io',
  splunk: 'splunk.com',
  samsara: 'samsara.com',
  verkada: 'verkada.com',
  flexport: 'flexport.com',
  gopuff: 'gopuff.com',
  etsy: 'etsy.com',
  ebay: 'ebay.com',
  wayfair: 'wayfair.com',
  chewy: 'chewy.com',
  peloton: 'onepeloton.com',
  strava: 'strava.com',
  zillow: 'zillow.com',
  redfin: 'redfin.com',
  opendoor: 'opendoor.com',
  expedia: 'expedia.com',
  'booking.com': 'booking.com',
  tripadvisor: 'tripadvisor.com',
  yelp: 'yelp.com',
  nextdoor: 'nextdoor.com',
  quora: 'quora.com',
  substack: 'substack.com',
  patreon: 'patreon.com',
  twitch: 'twitch.tv',
  'epic games': 'epicgames.com',
  'riot games': 'riotgames.com',
  'activision blizzard': 'activisionblizzard.com',
  'electronic arts': 'ea.com',
  valve: 'valvesoftware.com',
  nintendo: 'nintendo.com',
  sony: 'sony.com',
  dell: 'dell.com',
  hp: 'hp.com',
  lenovo: 'lenovo.com',
  tsmc: 'tsmc.com',
  micron: 'micron.com',
  broadcom: 'broadcom.com',
  'texas instruments': 'ti.com',
  'applied materials': 'appliedmaterials.com',
  asml: 'asml.com',
  'lam research': 'lamresearch.com',
  marvell: 'marvell.com',
  sap: 'sap.com',
  vmware: 'vmware.com',
  autodesk: 'autodesk.com',
  'unity software': 'unity.com',
  benchling: 'benchling.com',
  verily: 'verily.com',
  vanta: 'vanta.com',
  mixpanel: 'mixpanel.com',
  amplitude: 'amplitude.com',
  squarespace: 'squarespace.com',
  wix: 'wix.com',
  hinge: 'hinge.co',
  tinder: 'tinder.com',
  bumble: 'bumble.com',
  'match group': 'mtch.com',
  gojek: 'gojek.com',
  shopee: 'shopee.com',
  'mercado libre': 'mercadolibre.com',
  nubank: 'nubank.com.br',
  alibaba: 'alibaba.com',
  tencent: 'tencent.com',
  baidu: 'baidu.com',
  'jd.com': 'jd.com',
  rakuten: 'rakuten.com',
  'booz allen hamilton': 'boozallen.com',
  xai: 'x.ai',
  midjourney: 'midjourney.com',
  elevenlabs: 'elevenlabs.io',
  jasper: 'jasper.ai',
  adept: 'adept.ai',
  'inflection ai': 'inflection.ai',
  'safe superintelligence': 'ssi.inc',
  'thinking machines lab': 'thinkingmachines.ai',
  'physical intelligence': 'physicalintelligence.company',
  'skild ai': 'skild.ai',
  'together ai': 'together.ai',
  groq: 'groq.com',
  cerebras: 'cerebras.ai',
  sambanova: 'sambanova.ai',
  coreweave: 'coreweave.com',
  'weights & biases': 'wandb.ai',
  pinecone: 'pinecone.io',
  langchain: 'langchain.com',
  jefferies: 'jefferies.com',
  rbc: 'rbc.com',
  'houlihan lokey': 'hl.com',
  guggenheim: 'guggenheimpartners.com',
  rothschild: 'rothschildandco.com',
  'perella weinberg': 'pwpartners.com',
  qatalyst: 'qatalyst.com',
  hsbc: 'hsbc.com',
  'bnp paribas': 'bnpparibas.com',
  nomura: 'nomura.com',
  mizuho: 'mizuhogroup.com',
  mufg: 'mufg.jp',
  'credit agricole': 'credit-agricole.com',
  'societe generale': 'societegenerale.com',
  'td securities': 'tdsecurities.com',
  bmo: 'bmo.com',
  scotiabank: 'scotiabank.com',
  santander: 'santander.com',
  'william blair': 'williamblair.com',
  'piper sandler': 'pipersandler.com',
  'raymond james': 'raymondjames.com',
  stifel: 'stifel.com',
  baird: 'rwbaird.com',
  'harris williams': 'harriswilliams.com',
  'lincoln international': 'lincolninternational.com',
  greenhill: 'greenhill.com',
  truist: 'truist.com',
  'u.s. bank': 'usbank.com',
  pnc: 'pnc.com',
  'charles schwab': 'schwab.com',
  'northern trust': 'northerntrust.com',
  'state street': 'statestreet.com',
  bny: 'bny.com',
  apollo: 'apollo.com',
  tpg: 'tpg.com',
  'bain capital': 'baincapital.com',
  'warburg pincus': 'warburgpincus.com',
  'vista equity': 'vistaequitypartners.com',
  'thoma bravo': 'thomabravo.com',
  'silver lake': 'silverlake.com',
  'hellman & friedman': 'hf.com',
  'advent international': 'adventinternational.com',
  eqt: 'eqtgroup.com',
  'general atlantic': 'generalatlantic.com',
  'ares management': 'aresmgmt.com',
  brookfield: 'brookfield.com',
  'blue owl': 'blueowl.com',
  'leonard green': 'leonardgreen.com',
  'clayton dubilier & rice': 'cdr-inc.com',
  permira: 'permira.com',
  'cvc capital partners': 'cvc.com',
  point72: 'point72.com',
  millennium: 'mlp.com',
  'renaissance technologies': 'rentec.com',
  aqr: 'aqr.com',
  'five rings': 'fiverings.com',
  'tower research capital': 'tower-research.com',
  drw: 'drw.com',
  'virtu financial': 'virtu.com',
  'akuna capital': 'akunacapital.com',
  'old mission': 'oldmissioncapital.com',
  squarepoint: 'squarepoint-capital.com',
  'man group': 'man.com',
  balyasny: 'bamfunds.com',
  exoduspoint: 'exoduspoint.com',
  'tiger global': 'tigerglobal.com',
  coatue: 'coatue.com',
  'viking global': 'vikingglobal.com',
  'elliott management': 'elliottmgmt.com',
  'pershing square': 'pershingsquareholdings.com',
  pimco: 'pimco.com',
  't. rowe price': 'troweprice.com',
  'wellington management': 'wellington.com',
  'capital group': 'capitalgroup.com',
  invesco: 'invesco.com',
  'franklin templeton': 'franklintempleton.com',
  nasdaq: 'nasdaq.com',
  nyse: 'nyse.com',
  'cme group': 'cmegroup.com',
  's&p global': 'spglobal.com',
  "moody's": 'moodys.com',
  msci: 'msci.com',
  factset: 'factset.com',
  lightspeed: 'lsvp.com',
  bessemer: 'bvp.com',
  'insight partners': 'insightpartners.com',
  'thrive capital': 'thrivecap.com',
  'khosla ventures': 'khoslaventures.com',
  nea: 'nea.com',
  gv: 'gv.com',
  redpoint: 'redpoint.com',
  'battery ventures': 'battery.com',
  felicis: 'felicis.com',
  'first round': 'firstround.com',
  'initialized capital': 'initialized.com',
  kleiner: 'kleinerperkins.com',
  ivp: 'ivp.com',
  'spark capital': 'sparkcapital.com',
  'union square ventures': 'usv.com',
  'menlo ventures': 'menlovc.com',
  crv: 'crv.com',
  '8vc': '8vc.com',
  'lux capital': 'luxcapital.com',
  softbank: 'softbank.jp',
  'tiger global management': 'tigerglobal.com',
  kearney: 'kearney.com',
  'roland berger': 'rolandberger.com',
  'booz allen': 'boozallen.com',
  zs: 'zs.com',
  'analysis group': 'analysisgroup.com',
  'cornerstone research': 'cornerstone.com',
  'charles river associates': 'crai.com',
  'alvarez & marsal': 'alvarezandmarsal.com',
  'fti consulting': 'fticonsulting.com',
  huron: 'huronconsultinggroup.com',
  guidehouse: 'guidehouse.com',
  'simon-kucher': 'simon-kucher.com',
  'strategy&': 'strategyand.pwc.com',
  capgemini: 'capgemini.com',
  gartner: 'gartner.com',
  ideo: 'ideo.com',
  cravath: 'cravath.com',
  'wachtell lipton': 'wlrk.com',
  skadden: 'skadden.com',
  'sullivan & cromwell': 'sullcrom.com',
  'davis polk': 'davispolk.com',
  'kirkland & ellis': 'kirkland.com',
  'latham & watkins': 'lw.com',
  'simpson thacher': 'stblaw.com',
  'paul weiss': 'paulweiss.com',
  'wilson sonsini': 'wsgr.com',
  cooley: 'cooley.com',
  'gibson dunn': 'gibsondunn.com',
  unilever: 'unilever.com',
  "l'oréal": 'loreal.com',
  'estée lauder': 'elcompanies.com',
  lvmh: 'lvmh.com',
  nestlé: 'nestle.com',
  mondelez: 'mondelezinternational.com',
  'kraft heinz': 'kraftheinzcompany.com',
  'general mills': 'generalmills.com',
  kellogg: 'kelloggs.com',
  'colgate-palmolive': 'colgatepalmolive.com',
  'kimberly-clark': 'kimberly-clark.com',
  costco: 'costco.com',
  'home depot': 'homedepot.com',
  "lowe's": 'lowes.com',
  'best buy': 'bestbuy.com',
  starbucks: 'starbucks.com',
  "mcdonald's": 'mcdonalds.com',
  chipotle: 'chipotle.com',
  sweetgreen: 'sweetgreen.com',
  patagonia: 'patagonia.com',
  lululemon: 'lululemon.com',
  adidas: 'adidas.com',
  'under armour': 'underarmour.com',
  "levi's": 'levi.com',
  glossier: 'glossier.com',
  'warby parker': 'warbyparker.com',
  allbirds: 'allbirds.com',
  'red bull': 'redbull.com',
  'anheuser-busch': 'anheuser-busch.com',
  hershey: 'thehersheycompany.com',
  moderna: 'modernatx.com',
  genentech: 'gene.com',
  merck: 'merck.com',
  'eli lilly': 'lilly.com',
  abbvie: 'abbvie.com',
  'bristol myers squibb': 'bms.com',
  amgen: 'amgen.com',
  gilead: 'gilead.com',
  regeneron: 'regeneron.com',
  novartis: 'novartis.com',
  roche: 'roche.com',
  astrazeneca: 'astrazeneca.com',
  sanofi: 'sanofi.com',
  gsk: 'gsk.com',
  'novo nordisk': 'novonordisk.com',
  medtronic: 'medtronic.com',
  abbott: 'abbott.com',
  stryker: 'stryker.com',
  'boston scientific': 'bostonscientific.com',
  'intuitive surgical': 'intuitive.com',
  illumina: 'illumina.com',
  'thermo fisher': 'thermofisher.com',
  'unitedhealth group': 'unitedhealthgroup.com',
  'cvs health': 'cvshealth.com',
  'kaiser permanente': 'kaiserpermanente.org',
  'mayo clinic': 'mayoclinic.org',
  'one medical': 'onemedical.com',
  'oscar health': 'hioscar.com',
  'epic systems': 'epic.com',
  airbus: 'airbus.com',
  'northrop grumman': 'northropgrumman.com',
  raytheon: 'rtx.com',
  'general dynamics': 'gd.com',
  'blue origin': 'blueorigin.com',
  'rocket lab': 'rocketlabusa.com',
  'relativity space': 'relativityspace.com',
  'joby aviation': 'jobyaviation.com',
  'shield ai': 'shield.ai',
  saronic: 'saronic.com',
  'general motors': 'gm.com',
  ford: 'ford.com',
  toyota: 'toyota.com',
  honda: 'honda.com',
  bmw: 'bmw.com',
  'mercedes-benz': 'mercedes-benz.com',
  volkswagen: 'volkswagen.com',
  'general electric': 'ge.com',
  siemens: 'siemens.com',
  honeywell: 'honeywell.com',
  '3m': '3m.com',
  caterpillar: 'caterpillar.com',
  deere: 'deere.com',
  exxonmobil: 'exxonmobil.com',
  chevron: 'chevron.com',
  bp: 'bp.com',
  'nextera energy': 'nexteraenergy.com',
  'commonwealth fusion systems': 'cfs.energy',
  helion: 'helionenergy.com',
  'delta air lines': 'delta.com',
  'united airlines': 'united.com',
  'american airlines': 'aa.com',
  'southwest airlines': 'southwest.com',
  fedex: 'fedex.com',
  ups: 'ups.com',
  maersk: 'maersk.com',
  'warner bros. discovery': 'wbd.com',
  'the new york times': 'nytimes.com',
  'the washington post': 'washingtonpost.com',
  'the wall street journal': 'wsj.com',
  bloomberg: 'bloomberg.com',
  reuters: 'reuters.com',
  'the economist': 'economist.com',
  cnn: 'cnn.com',
  nbcuniversal: 'nbcuniversal.com',
  paramount: 'paramount.com',
  comcast: 'comcast.com',
  'universal music group': 'universalmusic.com',
  'sony music': 'sonymusic.com',
  'warner music group': 'wmg.com',
  a24: 'a24films.com',
  'condé nast': 'condenast.com',
  'vox media': 'voxmedia.com',
  buzzfeed: 'buzzfeed.com',
  pixar: 'pixar.com',
  dreamworks: 'dreamworks.com',
  nba: 'nba.com',
  nfl: 'nfl.com',
  mlb: 'mlb.com',
  espn: 'espn.com',
  verizon: 'verizon.com',
  'at&t': 'att.com',
  't-mobile': 't-mobile.com',
  'federal reserve': 'federalreserve.gov',
  'world bank': 'worldbank.org',
  'united nations': 'un.org',
  imf: 'imf.org',
  nasa: 'nasa.gov',
  nih: 'nih.gov',
  cdc: 'cdc.gov',
  'u.s. department of state': 'state.gov',
  'u.s. treasury': 'treasury.gov',
  cia: 'cia.gov',
  'white house': 'whitehouse.gov',
  'peace corps': 'peacecorps.gov',
  'gates foundation': 'gatesfoundation.org',
  'red cross': 'redcross.org',
  brookings: 'brookings.edu',
  rand: 'rand.org',
  'council on foreign relations': 'cfr.org',
  'khan academy': 'khanacademy.org',
  'wikimedia foundation': 'wikimediafoundation.org',
  mozilla: 'mozilla.org',
  'bell labs': 'bell-labs.com',
  'microsoft research': 'microsoft.com',
  'allen institute': 'alleninstitute.org',
  'broad institute': 'broadinstitute.org',
  hhmi: 'hhmi.org',
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

// ---- schools -----------------------------------------------------------------------------------------------------

/** A school name folded for lookup: "U.C. Berkeley", "UC-Berkeley" and "The University of Texas at Austin" alike. */
function schoolFold(raw: string): string {
  return stripDiacritics(raw)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’'`.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the /, '')
    .replace(/ at /g, ' ')
    .replace(/ main campus$/, '');
}

const indexNames = (rows: [string, ...string[]][]) => {
  const m = new Map<string, string>();
  for (const [domain, ...names] of rows) for (const n of names) m.set(schoolFold(n), domain);
  return m;
};
const UNIVERSITY = indexNames(UNIVERSITIES);
const SUB_SCHOOL = indexNames(SUB_SCHOOLS);
/** The schools named with two words or more, which can be found inside a longer name. */
const SUB_PHRASES = [...SUB_SCHOOL.entries()].filter(([k]) => k.includes(' '));
/** The full name of a university (not a short form like "Columbia" or "Duke", which also name companies). */
const FULL_UNIVERSITY = new Set(
  UNIVERSITIES.flatMap(([, ...names]) => names.map(schoolFold)).filter((k) =>
    /\b(university|college|institute|school)\b/.test(k),
  ),
);
/** Words that say a name is a part of a university: its school, college, department or lab. */
const SCHOOL_PART =
  /\b(school|college|business|law|engineering|medicine|medical|management|graduate|sciences?|arts|institute|department|dept|faculty|program|center|centre|lab|laboratory|eecs|mba|health|nursing|design|policy|public)\b/;

/** What follows a university's name when the thing is not the university: its press, its credit union. */
const NOT_THE_SCHOOL = /\b(press|publishing|publishers|credit union|bookstore|bookshop)\b/;

/** Where the separators in "Haas School of Business, UC Berkeley" or "School of Law at Duke" split a name. */
const SEPARATOR = /\s+[-–—|@]\s+|,\s+|\s+at\s+|\s*\(\s*|\s*\)\s*/i;

const schoolCache = new Map<string, string | undefined>();

/**
 * The domain of a university or one of its schools, from the name as people write it: the full name or a short form
 * ("UIUC", "UT Austin"), a school of it ("NYU Stern", "Stanford GSB", "Haas School of Business, UC Berkeley"), or a
 * part of it named after the university ("Stanford School of Medicine", "School of Engineering at Tufts University").
 * A school with its own site wins over its university. Undefined when the name is not a school Orbit knows.
 */
export function schoolDomain(name: string | undefined): string | undefined {
  if (!name?.trim()) return undefined;
  if (schoolCache.has(name)) return schoolCache.get(name);
  const found = findSchool(name);
  schoolCache.set(name, found);
  return found;
}

function findSchool(name: string): string | undefined {
  const k = schoolFold(name);
  if (!k) return undefined;
  const exact = SUB_SCHOOL.get(k) ?? UNIVERSITY.get(k);
  if (exact) return exact;
  // "UC Berkeley, Haas School of Business": a school among the parts first, then the university
  const parts = name
    .split(SEPARATOR)
    .map(schoolFold)
    .filter((p) => p && p !== k);
  for (const p of parts) if (SUB_SCHOOL.has(p)) return SUB_SCHOOL.get(p);
  // "University of Michigan Stephen M. Ross School of Business": a school named inside a longer name
  const padded = ` ${k} `;
  for (const [phrase, domain] of SUB_PHRASES) if (padded.includes(` ${phrase} `)) return domain;
  if (parts.length > 1) for (const p of parts) if (UNIVERSITY.has(p)) return UNIVERSITY.get(p);
  // "Stanford School of Medicine" (the university, then a part of it) and "School of Engineering of the University
  // of Pennsylvania" (a part, then the university)
  const words = k.split(' ');
  for (let i = words.length - 1; i >= 1; i--) {
    const head = words.slice(0, i).join(' ');
    const rest = words.slice(i).join(' ');
    const domain = UNIVERSITY.get(head);
    // a short form is a school only with a word that says so ("Columbia Sportswear" is not Columbia University);
    // a full name takes any part after it ("Boston University Questrom") except its press or its credit union
    if (domain && !NOT_THE_SCHOOL.test(rest) && (SCHOOL_PART.test(rest) || FULL_UNIVERSITY.has(head)))
      return domain;
  }
  for (let i = 1; i < words.length; i++) {
    const head = words.slice(0, i).join(' ');
    const rest = words
      .slice(i)
      .join(' ')
      .replace(/^((of|in)\s+)?(the\s+)?/, '');
    const domain = UNIVERSITY.get(rest);
    if (domain && SCHOOL_PART.test(head)) return domain;
  }
  return undefined;
}

// ---- the domain --------------------------------------------------------------------------------------------------

export function companyDomain(
  name: string | undefined,
  /** `guess: false` answers only from what is known (a stored domain, the well-known list, a school's address) */
  hints: { domains?: string[]; emails?: (string | undefined)[]; guess?: boolean } = {},
): string | undefined {
  for (const d of hints.domains ?? []) {
    const b = bare(d);
    if (DOMAIN.test(b)) return b;
  }
  const norm = normalizeCompany(name);
  if (norm && BY_NAME.has(norm)) return BY_NAME.get(norm);
  const school = schoolDomain(name);
  if (school) return school;
  if (hints.guess === false) return undefined;
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

// ---- the logo image ----------------------------------------------------------------------------------------------

/** The logo image for a domain: the site's own icon, from DuckDuckGo's icon service. */
export function companyLogoUrl(domain: string): string {
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;
}

export type LogoSourceKind = 'duckduckgo' | 'google' | 'touch' | 'favicon';

export interface LogoSource {
  kind: LogoSourceKind;
  url: string;
}

/**
 * Where a domain's logo is looked for, in order: DuckDuckGo's icon service, Google's (larger icons, 128 px when the
 * site has one), then the site's own touch icon and favicon. The two services answer a site they have no icon for
 * with a stand-in picture rather than an error, so each answer is judged by its size (judgeLogo) before it is shown.
 */
export function logoSources(domain: string): LogoSource[] {
  const d = encodeURIComponent(bare(domain));
  return [
    { kind: 'duckduckgo', url: `https://icons.duckduckgo.com/ip3/${d}.ico` },
    { kind: 'google', url: `https://www.google.com/s2/favicons?domain=${d}&sz=128` },
    { kind: 'touch', url: `https://${d}/apple-touch-icon.png` },
    { kind: 'favicon', url: `https://${d}/favicon.ico` },
  ];
}

/** DuckDuckGo's stand-in for a site without an icon: a grey circle with an arrow, 48 by 48. */
export const DUCKDUCKGO_PLACEHOLDER = { width: 48, height: 48 } as const;

/**
 * What a loaded logo image is worth, from its natural size: `ok` to show, `weak` (a real but tiny icon, shown only
 * when nothing better turns up) or `missing` (a stand-in picture, or nothing). DuckDuckGo's stand-in is 48 by 48 and
 * Google's is a 16 px globe; neither says so any other way a page can read. A real 48 px icon from DuckDuckGo is
 * found again from Google or the site itself.
 */
export function judgeLogo(kind: LogoSourceKind, width: number, height: number): 'ok' | 'weak' | 'missing' {
  if (!width || !height) return 'missing';
  if (kind === 'duckduckgo') {
    if (width === DUCKDUCKGO_PLACEHOLDER.width && height === DUCKDUCKGO_PLACEHOLDER.height) return 'missing';
    return Math.max(width, height) <= 16 ? 'weak' : 'ok';
  }
  if (kind === 'google' || kind === 'touch') return Math.max(width, height) <= 16 ? 'missing' : 'ok';
  return 'ok';
}

/** A company's initials for a tile when no logo is found: "Blue Harbor Partners" is BH, "Datadog" is D. */
export function companyInitials(name: string | undefined, max = 2): string {
  const words = stripDiacritics(name ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .split(/[\s\-–—/,&+.]+/)
    .map((w) => w.replace(/[^A-Za-z0-9]/g, ''))
    .filter(Boolean);
  const STOP = new Set(['the', 'of', 'and', 'at', 'for', 'in', 'a', 'inc', 'llc', 'ltd', 'co', 'corp']);
  const kept = words.filter((w) => !STOP.has(w.toLowerCase()));
  const use = kept.length ? kept : words;
  // the first letter of each of the first words that matter ("NYU Stern" is NS, "University of Chicago" UC)
  return use
    .slice(0, max)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

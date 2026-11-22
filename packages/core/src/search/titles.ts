/**
 * Job titles for network search (plan 32 §5.1): the families a title belongs to and the seniority it sits at, from
 * one normal form. Built on recommend/title.ts (`normalizeTitle`, `titleLevel`, `titleStatus`), which already writes
 * out abbreviations ("SWE", "PM", "VP") and knows ladder steps.
 *
 * Families are broad on purpose ("investing" covers a GP, an LP, an angel and a VC associate); a query narrows with
 * the title words the student used. A title can be in several families ("Founding Engineer" is founder and
 * engineering). Nothing here is a guess about the person: a title no rule reads gives no family, and the search says
 * so instead of treating it as a no.
 */
import { normalizeTitle, titleLevel, titleStatus } from '../recommend/title';

export const TITLE_FAMILIES = [
  'founder',
  'executive',
  'engineering',
  'data_ml',
  'research',
  'product',
  'design',
  'sales',
  'marketing',
  'growth',
  'operations',
  'finance',
  'investing',
  'consulting',
  'banking',
  'legal',
  'people_recruiting',
  'customer',
  'education_academia',
  'healthcare',
  'student',
  'creator',
  'policy_government',
  'media',
  'life_sciences',
  'real_estate',
  'military',
] as const;
export type TitleFamily = (typeof TITLE_FAMILIES)[number];

export const SENIORITIES = [
  'intern',
  'student',
  'entry',
  'mid',
  'senior',
  'staff_lead',
  'manager',
  'director_head',
  'vp',
  'c_level',
] as const;
export type SearchSeniority = (typeof SENIORITIES)[number];

export const SENIORITY_RANK: Record<SearchSeniority, number> = {
  intern: 0,
  student: 0,
  entry: 1,
  mid: 2,
  senior: 3,
  staff_lead: 4,
  manager: 4,
  director_head: 5,
  vp: 6,
  c_level: 7,
};

/**
 * Whole-word patterns over the normalized title (abbreviations already written out), per family. A pattern here is a
 * job said as a job: "Recruiter", "Product Manager", "Designer". A word that only names the field ("people",
 * "product", "design") is in FIELD_WORDS below, where it counts when the title is that word and little else.
 */
const FAMILY_PATTERNS: [TitleFamily, RegExp][] = [
  [
    'founder',
    /\b(founder|co founder|cofounder|founding (ceo|cto|coo|partner)|stealth startup|stealth mode|owner of|fundador|fundadora|grunder|grunderin|fondateur|fondatrice|fondatore|fondatrice|oprichter|zalozyciel|kurucu)\b|创始人|創業者|創辦人|창업자/,
  ],
  [
    'executive',
    /\b(chief \w+ officer|chief of staff|president|general manager|managing director|executive director|ceo|cto|coo|cfo)\b/,
  ],
  [
    'engineering',
    /\b(ingeniero|ingeniera|ingenieur|ingenieurin|ingenieure|engenheiro|engenheira|ingegnere|desarrollador|entwickler|developpeur|engineer|engineers|engineering|developer|programmer|fullstack|full stack|frontend|front end|backend|back end|devops|sre|site reliability|web developer|coder)\b/,
  ],
  [
    'data_ml',
    /\b(data scientist|data science|data engineer|data analyst|data analytics|statistician|applied scientist|quant|quantitative (researcher|analyst|trader|developer)|(machine learning|ml|ai|deep learning|nlp|computer vision|llm) (engineer|researcher|scientist|research|engineering|lead|architect|developer|intern)|analytics (engineer|manager|lead|analyst))\b/,
  ],
  [
    'research',
    /\b(researcher|scientist|phd|postdoc|post doctoral|professor|research (assistant|associate|engineer|fellow|scientist|intern|lead|analyst|scholar|staff|director|manager)|ra)\b/,
  ],
  [
    'product',
    /\b(product manager|product management|product lead|head of product|product owner|associate product manager|technical program manager|program manager|director of product|vice president of product|vice president product|chief product officer|cpo|group product manager|product director)\b/,
  ],
  [
    'design',
    /\b(designer|ux|ui|user research|user researcher|creative director|art director|illustrator|(product|graphic|visual|interaction|web|motion|brand|ux|ui|experience|service|industrial|game) design|head of design|design (lead|director|manager|partner|intern)|chief design officer)\b/,
  ],
  [
    'sales',
    /\b(sales|account executive|account manager|business development|sdr|bdr|solutions consultant|revenue operations)\b/,
  ],
  [
    'marketing',
    /\b(marketing|marketer|public relations|seo|demand gen|cmo|social media (manager|strategist|lead|marketing|coordinator)|content (marketing|strategist|strategy|manager|lead|writer)|communications (manager|director|lead|specialist|officer|associate)|brand (manager|strategist|strategy|marketing|director|lead)|pr (manager|specialist|director))\b/,
  ],
  [
    'growth',
    /\b(head of growth|growth (lead|manager|marketer|marketing|engineer|hacker|strategist|director|associate|analyst|intern|operations|product manager)|vice president of growth|vice president growth|user acquisition|lifecycle (marketing|manager)|retention (marketing|manager))\b/,
  ],
  [
    'operations',
    /\b(operations (manager|lead|associate|analyst|director|specialist|coordinator|intern)|head of operations|director of operations|vice president of operations|chief operating officer|coo|bizops|business operations|strategy & operations|strategy and operations|supply chain|logistics|procurement|program coordinator|project manager|chief of staff)\b/,
  ],
  [
    'finance',
    /\b(finance|financial analyst|fp&a|financial planning analysis|accountant|accounting|controller|treasury|cpa|audit|tax|actuar\w*|wealth (manager|management|advisor|adviser)|asset management|hedge fund|trader|sales trading|equity research|credit analyst|portfolio manager|chief financial officer)\b/,
  ],
  [
    'consulting',
    /\b(consultant|consulting|strategy consultant|management consultant|engagement manager|case team|business analyst at (mckinsey|bain|bcg|deloitte|accenture))\b/,
  ],
  [
    'banking',
    /\b(investment banking|investment banker|banker|mergers acquisitions|capital markets|leveraged finance|restructuring|coverage|ecm|dcm)\b/,
  ],
  [
    'legal',
    /\b(counsel|attorney|lawyer|paralegal|law clerk|jd|associate at .* llp|legal (counsel|intern|assistant|analyst|operations|director|officer|specialist|advisor))\b/,
  ],
  [
    'people_recruiting',
    /\b(recruit\w*|sourcer|talent (acquisition|partner|lead|manager|director|scout|sourcer|specialist|advisor|operations|matchmaker)|head of talent|people (operations|ops|partner|team|lead|manager)|head of people|chief people officer|vice president of people|human resources|hr|hrbp|university relations|executive search|headhunter|staffing)\b/,
  ],
  [
    'customer',
    /\b(customer success|customer support|customer experience|support engineer|solutions engineer|implementation|onboarding specialist)\b/,
  ],
  [
    'education_academia',
    /\b(professor|lecturer|teacher|instructor|tutor|teaching assistant|ta|dean|faculty|educator)\b/,
  ],
  [
    'healthcare',
    /\b(physician|doctor|md|nurse|rn|resident|surgeon|clinician|pharmacist|dentist|therapist|emt|paramedic|medical (student|doctor|assistant|scribe|officer|director|resident)|clinical (research coordinator|nurse|director|lead|fellow|pharmacist|psychologist))\b/,
  ],
  [
    'student',
    /\b(student|undergrad\w*|graduate student|grad student|phd candidate|mba candidate|candidate|class of|freshman|sophomore|junior at|senior at|incoming|estudiante|etudiant|etudiante|studentin|estudante|studente|alumno|alumna)\b/,
  ],
  ['creator', /\b(creator|content creator|youtuber|podcast\w*|writer|author|influencer|streamer)\b/],
  [
    'policy_government',
    /\b(legislative|congress\w*|senator|senate|assembly|city council|mayor|diplomat|foreign service|civil servant|state department|white house|regulatory affairs|public affairs|policy (analyst|advisor|adviser|director|fellow|researcher|manager|lead|associate|intern))\b/,
  ],
  [
    'media',
    /\b(journalist|reporter|editor|producer|newsroom|broadcast\w*|anchor|correspondent|filmmaker|photographer|videographer)\b/,
  ],
  [
    'life_sciences',
    /\b(biotech\w*|biolog\w*|chemist\w*|biochem\w*|pharma\w*|genomic\w*|neuroscien\w*|immunolog\w*|molecular|life sciences|clinical research|wet lab|bioinformatic\w*|bioengineer\w*)\b/,
  ],
  [
    'real_estate',
    /\b(real estate|realtor|broker|property manag\w*|leasing|acquisitions associate at .*(properties|realty|reit))\b/,
  ],
  [
    'military',
    /\b(army|navy|air force|marine corps|marines|veteran|usmc|usaf|national guard|lieutenant|sergeant|captain usa|officer candidate|rotc|space force|coast guard)\b/,
  ],
];

/**
 * Words that name a field of work and not a job in it. "Product", "Design", "Growth @ Ramp" or "Product & Growth"
 * is the job, said the short way; "Helping founders build their first product" and "It is not your people, it is
 * your culture" only use the word. So a field word counts for sure when the title is field words and little else,
 * and as a maybe (for a reader to settle) otherwise.
 */
const FIELD_WORDS: [TitleFamily, RegExp][] = [
  [
    'engineering',
    /\b(software|firmware|embedded|infrastructure|platform|mobile|ios|android|hardware|robotics)\b/,
  ],
  ['data_ml', /\b(analytics|ml|ai|machine learning|deep learning|nlp|computer vision|llm|data)\b/],
  ['research', /\b(research|lab)\b/],
  ['product', /\b(product)\b/],
  ['design', /\b(design)\b/],
  ['sales', /\b(partnerships|revenue|go to market|gtm)\b/],
  ['marketing', /\b(brand|content|communications|comms|social media|pr)\b/],
  ['growth', /\b(growth|lifecycle|retention)\b/],
  ['operations', /\b(operations|ops)\b/],
  ['finance', /\b(financial|wealth|credit)\b/],
  ['legal', /\b(legal)\b/],
  ['people_recruiting', /\b(talent|people)\b/],
  ['education_academia', /\b(curriculum|education)\b/],
  ['healthcare', /\b(clinical|medical|healthcare)\b/],
  ['creator', /\b(newsletter)\b/],
  ['policy_government', /\b(policy|government|public sector|federal)\b/],
];
/** Words a short title carries beside its field ("Head of Product", "Senior Design Lead", "Product & Growth"). */
const TITLE_FILLER =
  /^(?:head|lead|leader|leadership|director|manager|vice|president|vp|chief|officer|senior|junior|staff|principal|associate|intern|team|member|global|of|the|and|at|in|for|&|\+|\/|-)$/;

/**
 * Whether a title is a field said as a job: every word is the field's, another field's, or the kind of word a title
 * carries. "Product & Growth" and "Head of Talent" are; "Trusted design partner to top VC firms" is not.
 */
function isFieldTitle(t: string): boolean {
  const words = t.trim().split(' ').filter(Boolean);
  if (!words.length || words.length > 5) return false;
  return words.every((w) => TITLE_FILLER.test(w) || FIELD_WORDS.some(([, re]) => re.test(` ${w} `)));
}

/** "Founding engineer", "founding designer": an early employee, not a founder. */
const EARLY =
  /\b(founding (?:\w+ ){0,2}(engineer|designer|team|member|pm|product|scientist|researcher|hire|employee|ae|gtm|marketer|recruiter|analyst|operator|associate|healthcare)|first (engineer|hire|employee)|employee #?\d{1,2})\b/;
/** A title that is only a class year ("Senior", "Rising Junior") is a student. */
const YEAR_ONLY =
  /^\s*(rising\s+)?(freshman|sophomore|junior|senior|first year|second year|third year|fourth year|final year)\s*$/;
/**
 * Short tokens with several readings. The doc keeps every reading in `maybe`; a query resolves it by the company kind
 * ("PM at Citadel" is a portfolio manager) or by the words around it.
 */
const AMBIGUOUS: [RegExp, TitleFamily[]][] = [
  [/(^|[^a-z])pm([^a-z]|$)/i, ['product', 'operations', 'finance']],
  [/(^|[^a-z])ta([^a-z]|$)/i, ['education_academia', 'people_recruiting']],
  [/(^|[^a-z])ra([^a-z]|$)/i, ['research', 'healthcare']],
  [/(^|[^a-z])ae([^a-z]|$)/i, ['sales', 'engineering']],
  [/(^|[^a-z])ib([^a-z]|$)/i, ['banking', 'student']],
  [/(^|[^a-z])se([^a-z]|$)/i, ['engineering', 'sales']],
];

/** A founder or president of a student group is not a startup founder: these words after the title say it is a club. */
const CLUB =
  /\b(hackers|club|society|association|chapter|council|fraternity|sorority|hackathon|conference|league|committee|ambassador|initiative|student|students|campus|undergraduate|alliance|collective|guild|union|nonprofit|non profit|501c3|magazine|journal)\b/;

/** A firm whose people invest, by the words in its name: a fund says so ("Pear VC", "Theory Ventures"). */
const INVESTING_ORG =
  /\b(ventures?|venture partners|venture capital|vc|capital|seed fund|angels|fund|funds)\b/;
/** A name that often is such a firm and often is not ("Pareto Holdings" may be a fund or a holding company). */
const MAYBE_INVESTING_ORG = /\b(holdings|equity|investments?|asset management|family office|partners)\b/;
/** Places that share those words and do not: a bank, a lender, an insurer, a law or consulting firm, a record label. */
const NOT_INVESTING_ORG =
  /\b(capital one|bank|banking|credit|insurance|mutual|llp|law|consult\w*|advis\w*|records|factory|city|human capital management|network|club|society|association|studio|hedge fund|real estate|realty|properties)\b/;
/**
 * A job at such a firm that is an investing job, said plainly: "Partner", "Managing Partner", "Founder & General
 * Partner", "Investments". A "Dealflow Partner", a "Business Associate" or an "Engineer" at a fund is not one for sure.
 */
const FUND_ROLE =
  /^(?:(?:co ?founder|founder|ceo)\s*(?:&|and|,|\/)\s*)?(?:(?:senior|junior|managing|general|founding|venture|investment|investing|early stage|growth|seed|vice president|vp)\s*(?:&|and|,|\/)?\s*)*(?:partner|principal|associate|analyst|vice president|vp|managing director|md|director|gp|lp|investor|investing|investments?|investment team|portfolio manager)(?:\s*(?:&|and|,|\/)\s.*)?$/;
/** A job word that could be an investing job, with more words around it than FUND_ROLE allows. */
const INVESTING_ROLE =
  /\b(partner|principal|associate|analyst|vice president|managing director|investment|investments|investing|portfolio|gp|lp|fellow|scout)\b/;

/**
 * Words that name investing without the person being an investor: the people a founder raises from ("investor
 * relations", "investor-ready", "raise investor capital"), a company others invested in ("VC-backed"), someone who
 * serves funds ("design partner to top VC firms", a lawyer, a recruiter), a campus group about the industry, a banker.
 */
const NOT_INVESTING: RegExp[] = [
  /\binvestor[\s-]+(relations?|ready|capital|visibility|updates?|decks?|outreach|network|day|days|pitch\w*|materials|communications?|reporting|portal|experience|education|protection|sentiment|meetings?|readiness|introductions?|intros?|signals)\b/g,
  /\b(vc|venture|venture capital|pe|private equity|investor)(\s*(&|and|\/)\s*(vc|venture|venture capital|pe|private equity))?[\s-]+(backed|funded)\b/g,
  /\bbacked by\b[^|]*/g,
  /\b(venture capital|vc|private equity|pe|startup|fund)(\s*(&|and|\/)\s*(venture capital|vc|private equity|pe|startup|fund))?\s+(lawyer|law|attorney|counsel|recruit\w*|talent|club|network|society|association|community|newsletter|podcast|conference|summit|course|program|bootcamp|fellowship|enthusiast|student|aspirant|ecosystem|firms?)\b/g,
  /\b(girls|women|students?|kids|break|breaking|getting) in(to)? (vc|venture capital|private equity)\b/g,
  /\binvestment bank\w*\b/g,
  /\b(aspiring|future|wannabe|incoming|interested in|passionate about|curious about|exploring|learning|studying)\b[^|,]*/g,
  /\b(to|for|with|serving|helping|supporting|connecting|partnering with)\b[^|,@]*\b(vcs?|venture capital|private equity|pe|investors?|funds?)\b/g,
  /\b(return|returns|roi) (from|on) [^|,]*\binvestments?\b/g,
];

/** A fund's stage or field said before "VC" ("Early stage VC", "Deep Tech VC"): the person is the VC. */
const VC_KIND =
  /^(?:(?:pre ?seed|seed|early|late|growth)(?:[\s-]stage)?|deep ?tech|ai|fintech|health\w*|bio\w*|climate|consumer|enterprise|b2b|saas|crypto|web3|software|hardware|impact|tech|corporate|solo|emerging)$/;
/** After "Venture Capital &": another line of work beside it, not a job that serves it. */
const OTHER_JOB_TAIL =
  /\b(consult\w*|lawyer|attorney|recruit\w*|engineer\w*|student|writer|journalist|reporter|advis\w*|research\w*)\b/;

/**
 * Whether a title says its holder invests. 'sure': the title is an investor's ("Angel Investor", "General Partner",
 * "Partner" at a fund). 'maybe': it names the industry and not the job ("VC Scout", "Bonfire VC", "Analyst" at
 * "MoE Capital"), which a reader has to settle. Undefined: it only mentions investors ("investor relations").
 * `otherJob`: the title already reads as another line of work ("Engineering" at Helium Ventures).
 */
export function readInvesting(title: string, org?: string, otherJob = false): 'sure' | 'maybe' | undefined {
  const fold = (x: string) =>
    ` ${foldAccents(x)
      .toLowerCase()
      .replace(/[^a-z0-9&/|,@\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()} `;
  const whole = fold(title);
  if (!whole.trim()) return undefined;
  const o = fold(org ?? '');
  let t = whole;
  for (const re of NOT_INVESTING) t = t.replace(re, ' ');
  t = ` ${t.replace(/\s+/g, ' ').trim()} `;
  // a banker, whatever the firm is called
  const banker = /\b(investment bank\w*|banker|mergers|m&a)\b/.test(whole);
  // the noun, of one person: "Investor", "Angel Investor", "Founder/Investor" ("investors" are other people)
  if (/\binvestor\b/.test(t)) return 'sure';
  if (/\b(venture capitalist|general partner|limited partner|venture partner|investment partner)\b/.test(t))
    return 'sure';
  if (/\b(angel invest\w*|business angel|super angel|angel syndicate)\b/.test(t)) return 'sure';
  if (
    /\b(venture capital|vc|private equity|growth equity|venture) (associate|analyst|principal|partner|professional|investing|investments?)\b/.test(
      t,
    )
  )
    return 'sure';
  if (
    /\b(investment (associate|analyst|principal|professional|manager|director|team)|head of investments?|chief investment officer|investing (in|at)|invests in)\b/.test(
      t,
    )
  )
    return 'sure';
  // "Investments", "Investing", "Building & investing": the title is the work
  if (
    /^ (?:\w+ (?:&|and|\/|,) )?(investments?|investing|venture investing|investment team)( (&|and|\/|,|in|for) .*)? $/.test(
      t,
    )
  )
    return 'sure';
  // "VC", "Early stage VC", "Deep Tech VC"; "Venture Capital", "Venture Capital & AI": the person is one
  const vc = /^ (.*?)\s?(?:vc|venture capital|private equity)( (?:&|and|\/|,) (.*))? $/.exec(t);
  if (vc) {
    const before = (vc[1] ?? '').trim();
    if ((!before || VC_KIND.test(before)) && !OTHER_JOB_TAIL.test(vc[3] ?? '')) return 'sure';
  }
  if (!banker) {
    const body = t.trim();
    // "Partner" at Pear VC, "Associate" at Sequoia Capital: the firm in the field beside the title
    if (!NOT_INVESTING_ORG.test(o) && FUND_ROLE.test(body)) {
      if (INVESTING_ORG.test(o)) return 'sure';
      if (MAYBE_INVESTING_ORG.test(o)) return 'maybe';
    }
    // "Managing Partner, Fox & Chester Ventures": the firm in the same words
    const inTitle = /^(.+?)\s*(?:,| - | at | of |@)\s*(.+)$/.exec(body);
    if (inTitle && FUND_ROLE.test(inTitle[1]!.trim()) && !NOT_INVESTING_ORG.test(inTitle[2]!)) {
      if (INVESTING_ORG.test(inTitle[2]!)) return 'sure';
      if (MAYBE_INVESTING_ORG.test(inTitle[2]!)) return 'maybe';
    }
  }
  if (banker) return undefined;
  // the industry named, the job not: a scout, someone "at Bonfire VC", "Angel", "Early-Stage Venture"
  if (/\bscout\b/.test(t))
    return /\b(venture|vc|capital|fund|speedrun|investor|investing|ventures)\b/.test(`${t} ${o}`)
      ? 'maybe'
      : undefined;
  if (/\b(venture capital|vc|private equity|angel|family office|investing)\b/.test(t)) return 'maybe';
  if (/^ (\S+ ){0,2}investments?\b/.test(t) && !otherJob) return 'maybe';
  // some job at a fund: an investor's only when nothing says it is another line of work
  const firm = !NOT_INVESTING_ORG.test(o) && (INVESTING_ORG.test(o) || MAYBE_INVESTING_ORG.test(o));
  if (firm && INVESTING_ROLE.test(t)) return 'maybe';
  if (firm && INVESTING_ORG.test(o) && !otherJob) return 'maybe';
  return undefined;
}

export interface TitleRead {
  families: TitleFamily[];
  seniority: SearchSeniority | undefined;
  founder: boolean;
  /** the role is a club, society or campus group ("Founder, Berkeley Fintech Club"), not a company */
  club: boolean;
  /** 'aspiring' and 'incoming' roles are not held yet ("Aspiring PM", "Incoming SWE Intern") */
  status: 'working' | 'student' | 'aspiring' | 'incoming';
  /** an early employee ("Founding Engineer"), which is not a founder */
  earlyEmployee: boolean;
  /** other readings of an ambiguous short token ("PM" may be portfolio or project manager) */
  maybe: TitleFamily[];
}

const cache = new Map<string, TitleRead>();

/**
 * Families and seniority of one title (a job title or one part of a headline). `org` is the organization next to it
 * when known, which tells a club founder from a company founder.
 */
export function readTitle(title: string | undefined, org?: string): TitleRead {
  const whole = (title ?? '').trim();
  const key = `${whole}\u0000${org ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  // "Doctor, Ex founder, Angel Investor": the job they left is not read as one they hold
  const parts = whole.split(/\s*[,;•·]\s*/);
  const held = parts.filter(
    (x) => !/^(?:ex|former|formerly|previous|previously|prev)\b[\s.-]/i.test(x.trim()),
  );
  const raw = held.length && held.length < parts.length ? held.join(', ') : whole;
  const t = ` ${normalizeTitle(foldAccents(raw))} `;
  const families = new Set<TitleFamily>();
  if (t.trim()) for (const [f, re] of FAMILY_PATTERNS) if (re.test(t) || re.test(raw)) families.add(f);
  // a job said as a job, before field words are read ("Platform" at a fund is the fund's platform team, not software)
  const saidJob = families.size > 0;
  // a field named and no job in it: the job when the title is the field ("Product", "Head of Talent"), a maybe when
  // the word is only used in passing
  const fieldOnly: TitleFamily[] = [];
  if (t.trim()) {
    const short = isFieldTitle(t.trim());
    for (const [f, re] of FIELD_WORDS)
      if (!families.has(f) && re.test(t)) {
        if (short) families.add(f);
        else fieldOnly.push(f);
      }
  }
  const earlyEmployee = EARLY.test(t);
  if (earlyEmployee && !/\b(co ?founder|founder)\b/.test(t)) families.delete('founder');
  const yearOnly = YEAR_ONLY.test(t.toLowerCase());
  const status = yearOnly ? 'student' : titleStatus(raw);
  const maybe: TitleFamily[] = [];
  for (const [re, fams] of AMBIGUOUS)
    if (re.test(raw)) for (const f of fams) if (!families.has(f)) maybe.push(f);
  for (const f of fieldOnly) if (!families.has(f) && !maybe.includes(f)) maybe.push(f);
  const orgText = ` ${normalizeTitle(org ?? '')} `;
  // investing is read on its own: a title that only mentions investors is not an investor's, and one that names the
  // industry without the job is a maybe a reader settles
  const investing = raw ? readInvesting(raw, org, saidJob) : undefined;
  if (investing === 'sure') families.add('investing');
  else if (investing === 'maybe' && !maybe.includes('investing')) maybe.push('investing');
  // the group can be in the org field ("Berkeley Fintech Club") or in the title itself ("Founder, Fintech Club")
  const club = CLUB.test(orgText) || (families.has('founder') && CLUB.test(t));
  const founder = families.has('founder') && !club && status !== 'aspiring';
  if (!founder) families.delete('founder');
  if (status === 'student' || status === 'incoming') families.add('student');
  // "product" alone matches the word anywhere ("Product Designer"); keep it only when it is the role
  if (families.has('product') && families.has('design') && /\bproduct design/.test(t))
    families.delete('product');
  if (families.has('product') && families.has('marketing') && /\bproduct marketing/.test(t))
    families.delete('product');
  const read: TitleRead = {
    families: [...families],
    seniority: yearOnly ? 'student' : raw ? seniorityOfTitle(raw, founder, families.size > 0) : undefined,
    founder,
    club,
    status,
    earlyEmployee,
    maybe,
  };
  if (cache.size > 50_000) cache.clear();
  cache.set(key, read);
  return read;
}

function foldAccents(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function seniorityOfTitle(raw: string, founder: boolean, hasFamily: boolean): SearchSeniority | undefined {
  const t = ` ${normalizeTitle(raw)} `;
  if (/\b(intern|internship|summer analyst|summer associate|co ?op)\b/.test(t)) return 'intern';
  const level = titleLevel(raw);
  if (founder) return 'c_level';
  if (/\bchief\b|\b(ceo|cto|coo|cfo|cpo|cmo)\b|\bpresident\b(?! of)/.test(t) && !/\bvice president\b/.test(t))
    return 'c_level';
  if (/\b(general partner|managing partner|managing director|partner)\b/.test(t)) return 'c_level';
  switch (level) {
    case 'student':
      return 'student';
    case 'entry':
      return 'entry';
    case 'mid':
      // 'mid' is titleLevel's fallback: a part that names no role ("CS", "Hackathon Winner") has no level
      return hasFamily ? 'mid' : undefined;
    case 'senior':
      return 'senior';
    case 'lead':
      return /\bmanager\b/.test(t) ? 'manager' : 'staff_lead';
    case 'director':
      return 'director_head';
    case 'vp':
      return 'vp';
    case 'exec':
      return 'c_level';
    default:
      return hasFamily ? 'mid' : undefined;
  }
}

/**
 * Title words the student typed ("PM", "growth lead", "SWE", "angel") read as families plus the normalized words, so a
 * query can ask for a family, a seniority, or the exact words.
 */
export function readQueryTitle(text: string): {
  families: TitleFamily[];
  seniority?: SearchSeniority;
  words: string;
} {
  const r = readTitle(text);
  const words = normalizeTitle(text);
  // a bare role word ("founders", "investors") is the family, not a level
  const bare = words.split(' ').length <= 2;
  return { families: r.families, seniority: bare ? undefined : r.seniority, words };
}

/** The titles that name a whole kind of work: asking for one asks for everyone in it. */
export const GENERIC_TITLES: Partial<Record<TitleFamily, RegExp>> = {
  investing: /^(investor|vc|venture capitalist|venture capital)$/,
  founder: /^(founder|co founder|cofounder)$/,
  engineering: /^(engineer|software engineer|developer|software developer|programmer)$/,
  design: /^(designer)$/,
  people_recruiting: /^(recruiter|recruiting|recruitment)$/,
  product: /^(product manager|product management|product)$/,
  sales: /^(sales|salesperson|sales rep|sales representative)$/,
  marketing: /^(marketer|marketing)$/,
  consulting: /^(consultant|consulting)$/,
  research: /^(researcher|research)$/,
  student: /^(student)$/,
  creator: /^(creator|content creator)$/,
  operations: /^(operations|ops)$/,
  growth: /^(growth)$/,
};

/** Whether a title asked for (normalized words) is the name of one of these kinds of work. */
export function isGenericTitle(words: string, families: Iterable<TitleFamily>): boolean {
  const w = words.trim();
  const one = w.replace(/s$/, '');
  for (const f of families) if (GENERIC_TITLES[f]?.test(w) || GENERIC_TITLES[f]?.test(one)) return true;
  return false;
}

/**
 * Other names for the same job, for a job asked for by name ("lawyers" are attorneys and counsel too). Only names
 * that are the same job: a paralegal is not a lawyer, a nurse is not a doctor.
 */
const SAME_JOB: string[][] = [
  ['lawyer', 'attorney', 'counsel', 'solicitor', 'barrister', 'general counsel'],
  ['doctor', 'physician', 'surgeon', 'medical doctor'],
  ['recruiter', 'talent acquisition', 'sourcer', 'headhunter'],
  ['software engineer', 'software developer', 'programmer'],
  ['data scientist', 'data science'],
  ['professor', 'lecturer'],
];
/** A title asked for, with the other names of the same job. */
export function sameJobTitles(words: string): string[] {
  const w = words.trim();
  const one = w.replace(/s$/, '');
  const group = SAME_JOB.find((g) => g.includes(w) || g.includes(one));
  return group ? [...new Set([w, ...group])] : [w];
}

/**
 * How a title says a job asked for by name. 'yes': it is the title, or one item of it ("Doctor", "Founder, Tax
 * Lawyer"). 'likely': the words are there in a longer line, which may only mention the job ("Text a safe and free AI
 * doctor", "I show up before the lawyer has to"): a reader settles it.
 */
export function titleSays(title: string | undefined, queryWords: string): 'yes' | 'likely' | undefined {
  if (!title) return undefined;
  let found: 'yes' | 'likely' | undefined;
  for (const item of title.split(/\s*[,;|•·/]\s*|\s+[-–—]\s+/)) {
    if (!item.trim() || !titleHasWords(item, queryWords)) continue;
    if (normalizeTitle(item).split(' ').filter(Boolean).length <= 6) return 'yes';
    found = 'likely';
  }
  return found;
}

/** A word that may stand between two words of a title without making it another job. */
const BETWEEN_OK =
  /^(?:of|the|and|&|development|senior|staff|principal|lead|technical|associate|group|ii|iii|2|3)$/;

/** Whether a title's normalized words contain every word of a query title ("product manager" in "senior product manager, payments"). */
export function titleHasWords(title: string, queryWords: string): boolean {
  const words = queryWords.trim().split(' ').filter(Boolean);
  if (!words.length) return false;
  const tokens = normalizeTitle(title).split(' ').filter(Boolean);
  const is = (token: string, w: string) => token === w || token === `${w}s`;
  // the words in the order asked, close together: "venture partner" is in "Venture Partner, Europe" and in "Venture &
  // Growth Partner", and not in "design partner to top venture capital firms"
  const from = (start: number, k: number): boolean => {
    if (k === words.length) return true;
    const end = k === 0 ? tokens.length : Math.min(tokens.length, start + 3);
    for (let i = start; i < end; i++) {
      if (is(tokens[i]!, words[k]!) && from(i + 1, k + 1)) return true;
      // between two words asked for, only a word that does not change the job ("Software Development Engineer")
      if (k > 0 && !BETWEEN_OK.test(tokens[i]!)) return false;
    }
    return false;
  };
  return from(0, 0);
}

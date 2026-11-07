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

/** Whole-word patterns over the normalized title (abbreviations already written out), per family. */
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
    /\b(ingeniero|ingeniera|ingenieur|ingenieurin|ingenieure|engenheiro|engenheira|ingegnere|desarrollador|entwickler|developpeur|software|engineer|developer|programmer|fullstack|frontend|backend|devops|sre|site reliability|firmware|embedded|infrastructure|platform engineer|mobile|ios|android|web developer|hardware|mechanical|electrical|civil|aerospace|robotics)\b/,
  ],
  [
    'data_ml',
    /\b(data scientist|data science|data engineer|data analyst|analytics|ml|ai|machine learning|deep learning|nlp|computer vision|quant|quantitative|statistician|applied scientist|llm)\b/,
  ],
  [
    'research',
    /\b(research|researcher|scientist|phd|postdoc|post doctoral|lab|fellow at .*lab|professor|research assistant|ra)\b/,
  ],
  [
    'product',
    /\b(product manager|product management|product lead|head of product|product owner|associate product manager|technical program manager|program manager|product)\b/,
  ],
  [
    'design',
    /\b(design|designer|ux|ui|user research|creative director|art director|illustrator|brand designer)\b/,
  ],
  [
    'sales',
    /\b(sales|account executive|account manager|business development|sdr|bdr|partnerships|revenue|go to market|gtm)\b/,
  ],
  [
    'marketing',
    /\b(marketing|brand|content|communications|comms|social media|pr|public relations|seo|demand gen)\b/,
  ],
  ['growth', /\b(growth|user acquisition|lifecycle|retention)\b/],
  [
    'operations',
    /\b(operations|ops|bizops|strategy & operations|supply chain|logistics|procurement|program coordinator|project manager|chief of staff)\b/,
  ],
  [
    'finance',
    /\b(finance|financial|fp&a|financial planning analysis|accountant|accounting|controller|treasury|cpa|audit|tax|actuar\w*|wealth|asset management|hedge fund|trader|sales trading|equity research|credit|portfolio manager)\b/,
  ],
  [
    'investing',
    /\b(venture capital|investor|angel|general partner|limited partner|managing partner|venture partner|scout|vc|investment (associate|analyst|partner|team)|private equity|principal at|partner at .*(capital|ventures|fund|partners))\b/,
  ],
  [
    'consulting',
    /\b(consultant|consulting|strategy consultant|management consultant|engagement manager|case team|business analyst at (mckinsey|bain|bcg|deloitte|accenture))\b/,
  ],
  [
    'banking',
    /\b(investment banking|investment banker|banker|mergers acquisitions|capital markets|leveraged finance|restructuring|coverage|ecm|dcm)\b/,
  ],
  ['legal', /\b(legal|counsel|attorney|lawyer|paralegal|law clerk|jd|associate at .* llp)\b/],
  [
    'people_recruiting',
    /\b(recruit\w*|talent|sourcer|people operations|people|human resources|hrbp|people partner|university relations|campus)\b/,
  ],
  [
    'customer',
    /\b(customer success|customer support|customer experience|support engineer|solutions engineer|implementation|onboarding specialist)\b/,
  ],
  [
    'education_academia',
    /\b(professor|lecturer|teacher|instructor|tutor|teaching assistant|ta|dean|faculty|educator|curriculum)\b/,
  ],
  [
    'healthcare',
    /\b(physician|doctor|md|nurse|rn|resident|surgeon|clinician|clinical|pharmacist|dentist|therapist|medical|healthcare|emt|paramedic)\b/,
  ],
  [
    'student',
    /\b(student|undergrad\w*|graduate student|grad student|phd candidate|mba candidate|candidate|class of|freshman|sophomore|junior at|senior at|incoming|estudiante|etudiant|etudiante|studentin|estudante|studente|alumno|alumna)\b/,
  ],
  [
    'creator',
    /\b(creator|content creator|youtuber|podcast\w*|writer|author|influencer|streamer|newsletter)\b/,
  ],
  [
    'policy_government',
    /\b(policy|government|public sector|legislative|congress\w*|senator|senate|assembly|city council|mayor|diplomat|foreign service|civil servant|federal|state department|white house|regulatory affairs|public affairs)\b/,
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

/** "Founding engineer", "founding designer": an early employee, not a founder. */
const EARLY =
  /\b(founding (engineer|designer|team|member|pm|product|scientist|researcher|hire|employee|ae|gtm|marketer)|first (engineer|hire|employee)|employee #?\d{1,2})\b/;
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
  const raw = (title ?? '').trim();
  const key = `${raw}\u0000${org ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const t = ` ${normalizeTitle(foldAccents(raw))} `;
  const families = new Set<TitleFamily>();
  if (t.trim()) for (const [f, re] of FAMILY_PATTERNS) if (re.test(t) || re.test(raw)) families.add(f);
  const earlyEmployee = EARLY.test(t);
  if (earlyEmployee && !/\b(co ?founder|founder)\b/.test(t)) families.delete('founder');
  const yearOnly = YEAR_ONLY.test(t.toLowerCase());
  const status = yearOnly ? 'student' : titleStatus(raw);
  const maybe: TitleFamily[] = [];
  for (const [re, fams] of AMBIGUOUS)
    if (re.test(raw)) for (const f of fams) if (!families.has(f)) maybe.push(f);
  const orgText = ` ${normalizeTitle(org ?? '')} `;
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

/** Whether a title's normalized words contain every word of a query title ("product manager" in "senior product manager, payments"). */
export function titleHasWords(title: string, queryWords: string): boolean {
  const t = ` ${normalizeTitle(title)} `;
  const q = queryWords.trim();
  if (!q) return false;
  return q.split(' ').every((w) => new RegExp(`\\b${escapeRe(w)}s?\\b`).test(t));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

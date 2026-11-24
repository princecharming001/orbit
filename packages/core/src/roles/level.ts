/**
 * Plan 44 §4.5: a role's level, term and kind of employment, read from its title (and its text when the title says
 * nothing). No model and no guess: a title that names no level ("Software Engineer", "Analyst") has none, and the
 * search ranks it below roles that say they fit and lets the close read decide.
 *
 * Words are read in their place, not as a bag of keywords:
 * - "Analyst Relations Senior Manager" is a manager (lead), not an analyst and not entry level.
 * - "University Recruiter" and "Early Career Program Manager" hire students; they are not student roles.
 * - "Product Manager" and "Account Manager" are jobs, not managers of a team; "Engineering Manager" and "Manager,
 *   Solutions Architecture" are.
 * - "Associate" is entry level ("Operations Associate", "Associate Product Manager") except when it is part of a
 *   senior title ("Associate Director", "Associate General Counsel") or a banking and fund ladder step.
 * - "Staff Engineer" is lead; "Staff Accountant" is not.
 */
import type { Employment, JobLevel } from './types';

/** Lower case, abbreviations written out, punctuation turned to spaces. */
function norm(raw: string): string {
  return ` ${raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\bco-op\b|\bco op\b/g, 'coop')
    .replace(/\bsr\b\.?|\bsnr\b\.?/g, 'senior')
    .replace(/\bjr\b\.?/g, 'junior')
    .replace(/\bmgr\b\.?/g, 'manager')
    .replace(/\bassoc\b\.?/g, 'associate')
    .replace(/\b(svp|evp)\b/g, 'vice president')
    .replace(/\bavp\b/g, 'associate vice president')
    .replace(/\bvp\b/g, 'vice president')
    .replace(/\bnew-grad\b/g, 'new grad')
    .replace(/\bpost-doc/g, 'postdoc')
    .replace(/\bpost doc/g, 'postdoc')
    .replace(/\bentry-level\b/g, 'entry level')
    .replace(/\bmid-level\b/g, 'mid level')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9+ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
}

/**
 * Phrases whose level words describe someone else (the students a recruiter hires, a program that is run) or are not
 * level words at all. They are taken out before the title is read.
 */
const NOT_LEVEL: [RegExp, string][] = [
  [/ lead gen(eration)? /g, ' '],
  [/ chief of staff /g, ' cos '],
  [/ office of the (ceo|cto|cfo|coo|president|chief \w+ officer) /g, ' '],
  [
    / (account|executive) (executive|assistant|search|recruiter|communications|protection|producer|editor|chef) /g,
    ' $1x ',
  ],
  [/ solutions? architect(ure|s)? /g, ' solarch '],
  [/ art director /g, ' artdir '],
  [/ senior (care|living|housing|citizens?|services) /g, ' eldercare '],
  [/ seniors /g, ' eldercare '],
  [/ head (chef|cook|cashier|coach) /g, ' $1 '],
  [/ (internal|international) /g, ' '],
  [/ (directors?|presidents?|ceo|chief \w+ officer) s office /g, ' '],
  [/ office of the director /g, ' '],
  [/ chief (\w+ )?office /g, ' '],
  [/ (member of|members of|member) (the )?(\w+ )?staff /g, ' mts '],
  [/ (\w+ )?engineering staff /g, ' mts '],
  // the students a team hires or serves: "University Recruiter", "Early Careers Program Manager"
  [
    / (university|campus|college|early careers?|emerging talent|early talent|new grads?|students?|graduate|intern(ship)?s?) (?=(recruit\w*|relations|talent|hiring|outreach|coordinator|programs? (manager|coordinator|lead|specialist|director|partner|management|operations)) )/g,
    ' ',
  ],
];

/** Words before "manager" that name a job held alone, not a team managed. */
const IC_MANAGER =
  /(product|program|programme|project|account|accounts|success|activation|marketing|partner|partners|partnerships?|development|relationship|community|brand|content|campaigns?|events?|office|workplace|experience|facilities|facility|territory|category|merchant|vendor|case|services|solutions|implementation|onboarding|release|delivery|payroll|benefits|compliance|risk|policy|portfolio|fund|wealth|investment|procurement|sourcing|inventory|supply|demand|growth|lifecycle|performance|pricing|revenue|alliances?|channel|escalation|response|operations|engagement|media|communications|insights|enablement|programs|readiness|launch|quality|privacy|security|integration|integrations|business|commercial|field|regional marketing|partnership|platform|coe|asset|property|grants?|deal|transaction|treasury|tax|audit|credit|loan|relations|social|data|systems|automation|configuration|change|knowledge|learning|training|vendor management|ecosystem|developer relations)$/;
/** Words before "manager" that name a team: the manager runs it. */
const TEAM_MANAGER =
  /(engineering|software|design|research|science|sales|recruiting|recruitment|people|support|team|store|district|area|general|hiring|line|plant|site|shift|branch|country|solarch|development team|qa|test|analytics team|data science|product design|customer support|sales development|inside sales)$/;

const ROMAN: Record<string, JobLevel> = {
  i: 'entry',
  '1': 'entry',
  ii: 'mid',
  '2': 'mid',
  iii: 'senior',
  '3': 'senior',
  iv: 'lead',
  '4': 'lead',
  v: 'lead',
  '5': 'lead',
};
const JOB_NOUN =
  '(engineer|developer|analyst|specialist|technician|scientist|designer|associate|administrator|consultant|accountant|representative|coordinator|programmer|architect|researcher|level|tester|operator|writer|editor|agent|officer|auditor|underwriter|planner|buyer|advisor|adviser)';
const NUMBERED = new RegExp(` ${JOB_NOUN} (i{1,3}|iv|v|[1-5]) (?!d |\\+)`);

function managerLevel(t: string): JobLevel | undefined {
  if (!/ managers? /.test(t)) return undefined;
  if (/ senior managers? /.test(t)) return 'lead';
  if (/^ managers? /.test(t)) return 'lead';
  if (/ (staff|principal|group|general) (\w+ ){0,2}managers? /.test(t)) return 'lead';
  if (/ managers? (of|for) /.test(t)) return 'lead';
  for (const m of t.matchAll(/ ((?:[a-z0-9+]+ ){1,3})managers? /g)) {
    const before = m[1]!.trim();
    if (TEAM_MANAGER.test(before)) return 'lead';
    if (IC_MANAGER.test(before)) continue;
  }
  return undefined;
}

function associateLevel(t: string): JobLevel | undefined {
  if (!/ associates? /.test(t)) return undefined;
  if (
    / associate (director|vice president|partner|principal|general counsel|counsel|professor|dean|creative director|chief|head) /.test(
      t,
    )
  )
    return 'lead';
  // a ladder step in banking and funds, not a first job
  if (
    / (investment banking|private equity|venture|growth equity|investment|investments|m and a|capital markets|leveraged finance|restructuring|real estate private equity|credit) associates? /.test(
      t,
    )
  )
    return undefined;
  if (/ associates? (investment banking|private equity|investments?) /.test(t)) return undefined;
  return 'entry';
}

/** How many years of experience the text asks for, at the least. */
export function yearsAsked(text: string): number | undefined {
  let min: number | undefined;
  const re =
    /\b(\d{1,2})\s*(?:\+|plus|or more)?\s*(?:(?:-|–|to)\s*(\d{1,2})\s*)?\+?\s*years?\b(?:[^.\n]{0,40}?)\b(experience|work|working|industry|professional)/gi;
  for (const m of text.matchAll(re)) {
    const n = Number(m[1]);
    if (n > 25) continue;
    min = min === undefined ? n : Math.min(min, n);
  }
  return min;
}

function textLevel(text: string): JobLevel | undefined {
  const t = text.slice(0, 12_000);
  if (
    /\b(this (is a )?(paid )?(summer |fall |spring |winter )?internship|internship program|co-?op (term|program|position))\b/i.test(
      t,
    )
  )
    return 'intern';
  const years = yearsAsked(t);
  if (
    /\b(new grad(uate)?s?|recent (college |university )?graduates?|early[- ]career (program|role|position|candidates?))\b/i.test(
      t,
    ) &&
    (years === undefined || years <= 2)
  )
    return 'entry';
  if (years === undefined) return undefined;
  if (years <= 2) return 'entry';
  if (years <= 4) return 'mid';
  return 'senior';
}

/**
 * The role's level from its title, and from its text only when the title names none. Undefined: the posting does not
 * say (plain "Software Engineer").
 */
export function roleLevel(title: string, text?: string): JobLevel | undefined {
  const fromTitle = titleLevelOf(title);
  if (fromTitle || !text) return fromTitle;
  return textLevel(text);
}

function titleLevelOf(title: string): JobLevel | undefined {
  let t = norm(title ?? '');
  if (!t.trim()) return undefined;
  const raw = t;
  for (const [re, to] of NOT_LEVEL) t = t.replace(re, to);
  // a recruiter's or program's title names the students it serves, unless the role itself is an internship
  const hires = /\b(recruit\w*|sourcer|talent acquisition)\b/.test(t);

  // 1. students
  if (
    / (intern|interns|internship|internships|coop|coops|extern|externship|werkstudent\w*|praktikant\w*|stagiaire|practicum) /.test(
      t,
    ) ||
    / summer (analyst|associate|scholar|student|undergraduate)s? /.test(t) ||
    / (student) (employee|worker|researcher|assistant|ambassador|trainee|engineer|developer|programmer|technician) /.test(
      t,
    ) ||
    / working student /.test(t) ||
    / graduate (student|research assistant|researcher|teaching assistant) /.test(t)
  )
    return 'intern';
  // a term with no other word ("Software Engineer, Summer 2027") is a student's summer
  if (
    / (summer|fall|winter|spring|autumn) (20\d\d|\d\d) /.test(t) &&
    !/ (new grad|graduate|full time|start) /.test(t) &&
    !hires
  )
    return 'intern';

  // 2. the top
  if (/ (associate|assistant) (director|vice president) /.test(t)) return 'lead';
  if (
    / (chief|vice president|director|directors|president|ceo|cto|cfo|coo|cmo|cpo|ciso|cio|managing partner|general partner|founding partner) /.test(
      t,
    ) ||
    / head of /.test(t) ||
    /^ (global |regional )?head /.test(t) ||
    / head (?=[a-z]+ (engineering|product|design|sales|marketing|operations|research|data)\b)/.test(t)
  )
    return 'exec';

  // 3. first jobs
  if (!hires || /^ (junior|associate|entry level) /.test(t)) {
    if (
      / (new grads?|new graduates?|recent grads?|recent graduates?|university grads?|university graduates?|college grads?|entry level|early careers?|early talent|junior|apprentice\w*|trainee|trainees|rotational|rotation program|development program|leadership program|graduate program|grad program|university program|campus program|campus hire|fellowship|fellows program|entry to mid|postdoc\w*|postdoctoral|post doctoral) /.test(
        t,
      )
    )
      return 'entry';
    // "Graduate Systems Engineer", "Backend Software Engineer Graduate", "Digital Graduate Analyst", "PhD Graduate"
    if (/ graduate /.test(t) && !/ graduate (school|admissions|studies|program manager|advisor) /.test(t))
      return 'entry';
  }
  if (
    / fellows? /.test(t) &&
    !/ (distinguished|technical|senior|principal|corporate|ieee) fellow /.test(t) &&
    !/ (senior|staff|principal) /.test(t)
  )
    return 'entry';

  // 4. leading people or the work
  if (/ (distinguished|technical|corporate) fellow /.test(t)) return 'lead';
  if (/ principal /.test(t) && !/ principal (investigator|s) /.test(t)) return 'lead';
  if (
    / staff /.test(t) &&
    !/ staff (accountant|auditor|accounting|nurse|nurses|writer|attorney|assistant|pharmacist|physician|therapist|reporter|photographer|counsel|member|augmentation|scientist i) /.test(
      t,
    ) &&
    !/ (medical|support|clinical|wait|kitchen|nursing|office) staff /.test(t)
  )
    return 'lead';
  if (/ (leads?|lead) /.test(t) && !/ lead (to|by) /.test(t)) return 'lead';
  if (/ (supervisor|supervisors|superintendent|foreman) /.test(t)) return 'lead';
  if (/ architect(s)? /.test(t)) return 'lead';
  const manager = managerLevel(t);
  if (manager) return manager;

  // 5. senior
  if (/ senior /.test(t)) return 'senior';

  // 6. a step on a numbered ladder ("Software Engineer II", "Specialist 1", "Level 2")
  const step = NUMBERED.exec(raw);
  if (step) return ROMAN[step[2]!];

  // 7. associate, and a bank's level after the job ("Software Engineer - Analyst")
  const assoc = associateLevel(t);
  if (assoc) return assoc;
  if (/(engineer|developer)\s*[-,|–]?\s*analyst\b/i.test(title)) return 'entry';

  // 8. said outright
  if (/ (mid level|midlevel|intermediate) /.test(t)) return 'mid';
  return undefined;
}

const SEASONS: Record<string, string> = {
  summer: 'Summer',
  fall: 'Fall',
  autumn: 'Fall',
  winter: 'Winter',
  spring: 'Spring',
};

function termsIn(s: string): string[] {
  const out: string[] = [];
  const add = (season: string, year: string) => {
    const y = year.length === 2 ? `20${year}` : year;
    const n = Number(y);
    if (n < 2020 || n > 2035) return;
    const term = `${SEASONS[season.toLowerCase()]} ${y}`;
    if (!out.includes(term)) out.push(term);
  };
  // "Winter/Spring 2027", in the order written
  for (const m of s.matchAll(
    /\b(summer|fall|autumn|winter|spring)\s*(?:\/|and|or|&|-)\s*(summer|fall|autumn|winter|spring)\s+(20\d\d)\b/gi,
  )) {
    add(m[1]!, m[3]!);
    add(m[2]!, m[3]!);
  }
  for (const m of s.matchAll(/\b(summer|fall|autumn|winter|spring)\s*(?:of\s+)?['’]?(20\d\d|\d\d)\b/gi))
    add(m[1]!, m[2]!);
  for (const m of s.matchAll(/\b(20\d\d)\s+(summer|fall|autumn|winter|spring)\b/gi)) add(m[2]!, m[1]!);
  return out;
}

/**
 * The term of a student role ("Summer 2027", "Fall 2026"; several joined with a comma). From the title, or from the
 * text when it names the term beside the internship or program it describes.
 */
export function termOf(title: string, text?: string): string | undefined {
  const fromTitle = termsIn(title ?? '');
  if (fromTitle.length) return fromTitle.join(', ');
  if (!text) return undefined;
  const near: string[] = [];
  for (const m of text
    .slice(0, 12_000)
    .matchAll(/[^.\n]{0,80}\b(intern(ship)?s?|co-?ops?|program|start date|starting|term)\b[^.\n]{0,80}/gi))
    for (const t of termsIn(m[0])) if (!near.includes(t)) near.push(t);
  return near.length ? near.slice(0, 3).join(', ') : undefined;
}

/** A source's own word for the kind of employment ("FullTime", "Full-time", "intern", "contract"). */
export function employmentWord(word: string | undefined): Employment | undefined {
  const w = (word ?? '').toLowerCase();
  if (!w) return undefined;
  if (/intern|co-?op|student|trainee/.test(w)) return 'internship';
  if (/part/.test(w)) return 'part_time';
  if (/contract|freelance|consult/.test(w)) return 'contract';
  if (/temp|seasonal|fixed/.test(w)) return 'temporary';
  if (/full|permanent|regular|^full$/.test(w)) return 'full_time';
  return undefined;
}

/**
 * The kind of employment: the title's own words first ("(Contract)", "Part-Time"), then the source's field, then an
 * internship when the level is one.
 */
export function employmentOf(title: string, text?: string, sourceWord?: string): Employment | undefined {
  const t = norm(title ?? '');
  if (/ (part time|parttime) /.test(t)) return 'part_time';
  if (/ (contract|contractor|contract to hire|freelance) /.test(t)) return 'contract';
  if (/ (temporary|temp|seasonal|fixed term) /.test(t)) return 'temporary';
  if (titleLevelOf(title) === 'intern') return 'internship';
  if (/ full time /.test(t)) return 'full_time';
  const fromSource = employmentWord(sourceWord);
  if (fromSource) return fromSource;
  if (text && /\bthis is a (paid )?(part[- ]time|contract|temporary) (role|position)\b/i.test(text)) {
    const m = /\bthis is a (?:paid )?(part[- ]time|contract|temporary)/i.exec(text)!;
    return employmentWord(m[1]);
  }
  return undefined;
}

// own keys only: a word like "constructor" or "toString" in someone's data must not find a built-in
for (const table of [ROMAN, SEASONS]) Object.setPrototypeOf(table, null);

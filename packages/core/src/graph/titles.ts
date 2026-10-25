/**
 * What a job title says about someone, for how two people relate (plan 21 §3.6) and how receptive a target is (plan
 * 16 §4.2): a seniority class, and the function they work in. Keyword rules, deliberately coarse: a title neither
 * rule recognises gives undefined, and undefined never moves a score.
 */

const C_LEVEL =
  /\b(ceo|cfo|coo|cto|cmo|cpo|cio|ciso|chief|president|partner|managing director|founder|co-founder|cofounder)\b/i;
const SENIOR = /\b(director|vp|vice president|head of|principal|general manager|svp|evp)\b/i;
const JUNIOR_OR_MANAGER =
  /\b(intern|analyst|associate|engineer|developer|designer|scientist|researcher|manager|coordinator|specialist|consultant|representative|recruiter|assistant|lead|student|fellow)\b/i;

/** 2 = C-level or partner, 1 = senior (director, VP, head of), 0 = up to manager; undefined when unclear. */
export type SeniorityClass = 0 | 1 | 2;

export function seniorityClass(title: string | undefined): SeniorityClass | undefined {
  const t = title ?? '';
  if (!t.trim()) return undefined;
  if (C_LEVEL.test(t)) return 2;
  if (SENIOR.test(t)) return 1;
  if (JUNIOR_OR_MANAGER.test(t)) return 0;
  return undefined;
}

const FUNCTIONS: [string, RegExp][] = [
  ['engineering', /\b(engineer\w*|developer|software|swe|devops|sre|programmer)\b/i],
  ['product', /\b(product manager|product lead|head of product|pm|product owner)\b/i],
  ['design', /\b(design\w*|ux|ui)\b/i],
  ['data', /\b(data|machine learning|ml|analytics)\b/i],
  ['research', /\b(research\w*|scientist|phd)\b/i],
  ['sales', /\b(sales|account executive|business development|bdr|sdr)\b/i],
  ['marketing', /\b(marketing|growth|brand|content)\b/i],
  [
    'finance',
    /\b(finance|financial|investment|investor|banking|banker|private equity|venture|vc|trader|accountant)\b/i,
  ],
  ['operations', /\b(operations|ops|supply chain|logistics)\b/i],
  ['recruiting', /\b(recruit\w*|talent|people ops|hr)\b/i],
  ['legal', /\b(legal|counsel|attorney|lawyer|paralegal)\b/i],
  ['consulting', /\b(consult\w*)\b/i],
];

/** The function a title works in (engineering, product, sales, …), or undefined. */
export function functionOf(title: string | undefined): string | undefined {
  const t = title ?? '';
  for (const [name, re] of FUNCTIONS) if (re.test(t)) return name;
  return undefined;
}

/** Whether two titles are at the same seniority ('same'), two classes apart ('gap'), or unclear (undefined). */
export function seniorityFit(a: string | undefined, b: string | undefined): 'same' | 'gap' | undefined {
  const x = seniorityClass(a);
  const y = seniorityClass(b);
  if (x === undefined || y === undefined) return undefined;
  if (x === y) return 'same';
  return Math.abs(x - y) >= 2 ? 'gap' : undefined;
}

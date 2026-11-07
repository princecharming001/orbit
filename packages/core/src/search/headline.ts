/**
 * Everything a LinkedIn headline says, read into roles, schools and YC badges (plan 32 §7.1). The headline is the one
 * field almost every person has (85% of a real network; title and company only 43%), and it is dense: "Co-founder &
 * CTO @ Knowlify (YC S25) | ex-Stripe | CS @ Georgia Tech '27".
 *
 * Deterministic and cheap: a headline is read once when its person's search document is built. Each value carries the
 * part of the headline it came from, which is the evidence a search shows.
 */
import { titleStatus } from '../recommend/title';
import { readTitle, type TitleRead } from './titles';

export interface HeadlineRole {
  title?: string;
  org?: string;
  current: boolean;
  /** "Incoming SWE @ Google": not held yet, neither current nor past */
  future?: boolean;
  /** read from "Building X" or "Building" alone: likely a founder, said less plainly */
  weak?: boolean;
  /** the headline part this came from, verbatim */
  text: string;
  read: TitleRead;
}

export interface HeadlineSchool {
  name: string;
  gradYear?: number;
  field?: string;
  text: string;
}

export interface HeadlineYc {
  org?: string;
  /** canonical batch: W26, S25, F24, X25 (spring), IK12 */
  batch?: string;
  text: string;
}

export interface HeadlineRead {
  roles: HeadlineRole[];
  schools: HeadlineSchool[];
  yc: HeadlineYc[];
  /** parts that named no role, org or school: what they do or care about ("AI agents", "Hard tech") */
  topics: string[];
}

/** Separators between headline parts. A hyphen splits only with spaces around it ("Co-founder" stays whole). */
const SPLIT =
  /\s*[|•·;▪◦●►➤⚡✦★☆]\s*|\s+[–—-]\s+|\s*\/\/\s*|\s+\/\s+|\s*\p{Extended_Pictographic}+\s*|\n+|\s{3,}/u;
const PAST =
  /^(?:ex[\s-]+|ex\b|former(?:ly)?\b|previously\b|prev\.?\b|past\b|alum(?:nus|na|ni)?\s+(?:of|@)\b|retired\b)/i;
const FUTURE = /^(?:incoming\b|future\b|soon\s+to\s+be\b|starting\b)/i;
const AT = /^(.*?)(?:\s+at\s+|\s*@\s*|\s+for\s+(?=[A-Z]))(.+)$/i;
const YC_BADGE =
  /\b(?:YC|Y\s?Combinator)\s*[-:]?\s*\(?\s*((?:W|S|F|X|P|IK|Winter|Summer|Fall|Spring)\s*'?\s*(?:20)?\d{2})\s*\)?/i;
const YC_PAREN =
  /\(\s*(?:YC|Y\s?Combinator)\s*,?\s*((?:W|S|F|X|P|IK|Winter|Summer|Fall|Spring)\s*'?\s*(?:20)?\d{2})?[^)]*\)/i;
const BATCH_TOKEN = /\b(?:W|S|F|X|P|IK|Winter|Summer|Fall|Spring)\s?'?(?:20)?\d{2}\b/i;
const YC_WORD = /\b(?:YC|Y\s?Combinator)\b/i;
/** "'27", "27'", "’28", "Class of 2027", "2027" right after a school name */
const YEAR = /(?:class\s+of\s+|['’`]\s?)(\d{2}(?:\d{2})?)\b|\b(\d{2})['’`](?!\w)|\b(20[1-4]\d)\b/i;
/** A part with no org is a role only when it names one; "Python, SQL, NLP" and "Helping firms stay secure" are topics. */
const ROLE_NOUN =
  /\b(founder|co-?founder|owner|ceo|cto|coo|cfo|cpo|cmo|chief|president|partner|principal|director|head|vp|vice president|lead|manager|engineer|developer|programmer|scientist|researcher|analyst|associate|consultant|designer|architect|investor|angel|scout|recruiter|sourcer|intern|student|undergrad\w*|candidate|fellow|professor|lecturer|teacher|instructor|tutor|attorney|lawyer|counsel|paralegal|accountant|controller|banker|trader|physician|doctor|nurse|surgeon|resident|pharmacist|therapist|writer|author|creator|editor|journalist|producer|strategist|specialist|coordinator|officer|administrator|advisor|adviser|mentor|executive|representative|swe|sde|pm|apm|tpm|sre|ae|sdr|bdr|gp|lp|md)s?\b/i;
const NOT_ROLE =
  /^(?:helping|help|passionate|love|loving|obsessed|curious|i\b|we\b|my\b|on a mission|driven|dedicated|making|turning|empowering|transforming|exploring|learning|interested|open to|seeking|looking)/i;

/** Canonical YC batch from any spelling: "W26", "Winter 2026", "S 25", "F'24", "Spring 2025" and "P26" (both X), "IK12". */
export function canonicalBatch(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = /^\s*(W|S|F|X|P|IK|Winter|Summer|Fall|Spring)\s*'?\s*(?:20)?(\d{2})\s*$/i.exec(raw.trim());
  if (!m) return undefined;
  const season = m[1]!.toLowerCase();
  const code =
    season === 'winter' || season === 'w'
      ? 'W'
      : season === 'summer' || season === 's'
        ? 'S'
        : season === 'fall' || season === 'f'
          ? 'F'
          : season === 'spring' || season === 'x' || season === 'p'
            ? 'X'
            : 'IK';
  return `${code}${m[2]}`;
}

/** yc-oss writes batches as "Winter 2026", "Summer 2025", "Fall 2024", "Spring 2025". */
export function batchFromYcOss(batch: string | undefined): string | undefined {
  return canonicalBatch(batch);
}

function cleanOrg(s: string): string {
  return s
    .replace(YC_PAREN, ' ')
    .replace(/\((?:acq(?:uired)?\.?|acquired by|exited|backed by)[^)]*\)/gi, ' ')
    .replace(/\s*\([^)]*\)\s*$/, ' ')
    .split(/\s*,\s+(?=[A-Za-z])|\s+\/\s+|\s+&\s+(?=[A-Z][a-z]+\s+(?:at|@))/)[0]!
    .replace(/[.,;!:]+$/, '')
    .replace(/^the\s+/i, '')
    .split(/\s*:\s|\s+#|\.\s+[A-Z]|\s+[–—-]\s+/)[0]!
    .trim();
}

function yearOf(s: string): number | undefined {
  const m = YEAR.exec(s);
  if (!m) return undefined;
  const y = m[1] ?? m[2] ?? m[3];
  if (!y) return undefined;
  const n = Number(y);
  const full = y.length === 2 ? 2000 + n : n;
  return full >= 1960 && full <= 2040 ? full : undefined;
}

/** The canonical school for a name or alias ("Cal", "UCB", "Georgia Tech"), when it is one. */
export type SchoolLookup = (text: string) => string | undefined;

/**
 * Read a headline. `isSchool` resolves a name to a canonical school (from schools.json); without it schools are found
 * only through student words ("CS @ X", "X '27").
 */
export function readHeadline(headline: string | undefined, isSchool?: SchoolLookup): HeadlineRead {
  const out: HeadlineRead = { roles: [], schools: [], yc: [], topics: [] };
  const h = (headline ?? '').replace(/\s+/g, ' ').trim();
  if (!h) return out;
  const parts = pairRoles(
    h
      .split(SPLIT)
      .map((p) => p.trim())
      .filter(Boolean),
  );
  for (const part of parts) readPart(part, out, isSchool);
  return out;
}

/** "Founder", "Co-founder & CEO", "CTO": a founder's title with no org in the same part. */
const BARE_FOUNDER =
  /^(?:(?:co-?\s?)?founder|ceo|cto|coo|cpo)(?:\s*(?:&|and|,|\/|\+)\s*(?:ceo|cto|coo|cpo|president|(?:co-?\s?)?founder))*$/i;
const YC_TAGGED = (part: string) => YC_PAREN.test(part) || YC_BADGE.test(part);

/**
 * "Founder | Archal (YC S26)", "Co-founder • Tuneloop (YC)", "Archal (YC S26) | Founder": a founder's title and the
 * YC-tagged company it belongs to, split into neighbouring parts, read as one ("Founder @ Archal (YC S26)").
 */
function pairRoles(parts: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i]!;
    const b = parts[i + 1];
    const orgOnly = (x: string) => YC_TAGGED(x) && !AT.test(x) && !ROLE_NOUN.test(x.replace(YC_PAREN, ''));
    if (b && BARE_FOUNDER.test(a) && orgOnly(b)) {
      out.push(`${a} @ ${b}`);
      i++;
    } else if (b && orgOnly(a) && BARE_FOUNDER.test(b)) {
      out.push(`${b} @ ${a}`);
      i++;
    } else out.push(a);
  }
  return out;
}

const IDIOM_ORG =
  /^(?:scale|heart|night|work|home|large|best|all|any|once|times|the intersection|intersection|the edge|the forefront|the core|its core|the crossroads|every level|the same time|speed)\b/i;
const JOB_WORD =
  /\b(engineer\w*|developer|manager|analyst|intern|founder|co-?founder|ceo|cto|coo|associate|consultant|designer|recruiter|director|head|lead|swe|sde|pm|scientist|officer|partner|fellow|ambassador|advisor|tutor|instructor|lecturer|professor|staff|operations|ops|sales|marketing|growth|placement|co-?op)\b/i;
const PAST_ROLE_TAIL =
  /\s+((?:senior |junior |summer |research |software |investment banking |ib )?(?:analyst|intern|engineer|associate|consultant|researcher|swe|sde|pm|apm|trader|scientist|fellow|designer|developer))$/i;

function readPart(partRaw: string, out: HeadlineRead, isSchool?: SchoolLookup): void {
  let part = partRaw.replace(/^[\s"'“”]+|[\s"'“”]+$/g, '');
  if (!part || !/[a-z]/i.test(part)) return;
  const badge = YC_PAREN.exec(part) ?? YC_BADGE.exec(part);
  const hasYc = !!badge || YC_WORD.test(part);
  const past = PAST.test(part);
  const future = FUTURE.test(part);
  if (past) part = part.replace(PAST, '').trim();
  if (future) part = part.replace(FUTURE, '').trim();
  const status = titleStatus(partRaw);
  // "Microsoft, Yahoo, SAP, Carnegie Mellon", "Python, SQL, NLP": a list, read item by item
  if (
    !AT.test(part) &&
    (part.match(/,/g)?.length ?? 0) >= 2 &&
    !/\b(?:founder|ceo|cto|owner|president)\b/i.test(part)
  ) {
    for (const item of part.split(/\s*,\s*/)) if (item) readPart(past ? `ex ${item}` : item, out, isSchool);
    return;
  }

  // a school: "CS @ Georgia Tech", "Student at UC Berkeley", "UCR '28 Neuroscience", "CS, IIT Delhi", "Michigan State University"
  const school = schoolOf(part, isSchool);
  if (school) {
    out.schools.push({ ...school, text: partRaw });
    return;
  }

  let title: string | undefined;
  let orgs: string[] = [];
  let weak = false;
  const at = AT.exec(part);
  // "AI systems at scale", "Builder at heart": an idiom, not an employer
  const idiom = at?.[2] && IDIOM_ORG.test(at[2].trim());
  if (at?.[2]?.trim() && !idiom) {
    title = at[1]?.trim() || undefined;
    orgs = splitOrgs(at[2]);
  } else {
    const of =
      /^(.*?\b(?:founder|co-?founder|ceo|cto|coo|owner|president|partner)\b[^,]*?)\s+of\s+(.+)$/i.exec(
        part,
      ) ?? /^((?:co-?)?founder\b[^,]*?|ceo|cto|coo|owner|president)\s*,\s*(.+)$/i.exec(part);
    const building = /^(?:building|started|founded|founding)\b\s*(.*)$/i.exec(part);
    if (of) {
      title = of[1]!.trim();
      orgs = [cleanOrg(of[2]!)];
    } else if (building) {
      const rest = cleanOrg(building[1] ?? '');
      title = 'Founder';
      weak = true;
      // "Building Knowlify", "Building HarnessRouter.ai": a name; "Building products with AI" is not one
      if (
        rest &&
        /^[A-Z0-9][\w.&'-]*(?:\s+[A-Z0-9][\w.&'-]*){0,3}$/.test(rest) &&
        !/\s(with|for|that|to|the)\s/i.test(rest)
      )
        orgs = [rest];
      else if (rest && !/\b(stealth|something|new|cool)\b/i.test(rest)) {
        if (rest.length <= 80) out.topics.push(part);
        return;
      }
    } else if (past && part.split(' ').length <= 6) {
      // "ex-Stripe", "Former Goldman Sachs", "Ex-HSBC Analyst", "Prev. Polarity, Chatbase"
      const tail = PAST_ROLE_TAIL.exec(part);
      if (tail) {
        title = tail[1];
        part = part.slice(0, tail.index);
      }
      orgs = part
        .split(/\s*,\s*|\s+and\s+|\s+&\s+|\s*\/\s*/)
        .map(cleanOrg)
        .filter(Boolean);
    } else {
      title = part;
    }
  }
  if (title) title = title.replace(/[,;:\-–—]+$/, '').trim() || undefined;
  if (badge || hasYc) {
    // "YC Alum (W21)": the batch may stand apart from the YC word
    const batch = canonicalBatch(badge?.[1] ?? BATCH_TOKEN.exec(part)?.[0]);
    // a part that is only the badge ("YC W26", "YC Alum (W21)", "Y Combinator alum") names no company
    const bare = title
      ?.replace(YC_PAREN, ' ')
      .replace(YC_BADGE, ' ')
      .replace(YC_WORD, ' ')
      .replace(/\b(?:alum(?:nus|na|ni)?|backed|company|startup|batch)\b/gi, ' ')
      .replace(BATCH_TOKEN, ' ')
      .replace(/[()[\]\s,.'’`:-]+/g, ' ')
      .trim();
    const ycOrg = orgs[0] ?? (title && bare && !ROLE_NOUN.test(title) ? cleanOrg(title) : undefined);
    out.yc.push({ org: ycOrg || undefined, batch, text: partRaw });
  }
  const read = readTitle(title, orgs[0]);
  const namesRole = !!title && ROLE_NOUN.test(title) && !NOT_ROLE.test(title);
  // "Economics & Engineering at UC Berkeley": a field at a school, not a job
  const atSchool = orgs.length === 1 && !namesRole && !past && !future ? isSchool?.(orgs[0]!) : undefined;
  if (atSchool) {
    out.schools.push({ name: atSchool, field: title, gradYear: yearOf(partRaw), text: partRaw });
    return;
  }
  if (!orgs.length && (!namesRole || title!.split(' ').length > 8)) {
    if (part.length <= 80) out.topics.push(part);
    return;
  }
  if (orgs.length && title && !namesRole && !read.families.length) {
    // "Molecular Biology @ X" where X is no school we know, "SMB Manufacturing, West at AddaxLab": keep the org, drop the title
    out.topics.push(title);
    title = undefined;
  }
  const current = !past && !future && status !== 'aspiring';
  const roleRead = title === undefined ? readTitle(undefined, orgs[0]) : read;
  const fut = future || /\bincoming\b/i.test(partRaw) || undefined;
  if (!orgs.length)
    out.roles.push({ title, current: current && !fut, future: fut, text: partRaw, read: roleRead, weak });
  for (const org of orgs.slice(0, 4))
    out.roles.push({
      title,
      org,
      current: current && !fut,
      future: fut,
      text: partRaw,
      read: roleRead,
      weak,
    });
}

function splitOrgs(s: string): string[] {
  return s
    .split(/\s*,\s*(?=[A-Z0-9@])|\s+and\s+(?=[A-Z])|\s+&\s+(?=[A-Z][\w.]*\s*(?:\(|$))|\s*\/\s*(?=[A-Z])/)
    .map((o) => cleanOrg(o.replace(/^@\s*/, '')))
    .filter((o) => o && o.length <= 60);
}

const SCHOOL_TYPE = /\b(high school|college|university|institute|academy|school|polytechnic)\b/i;

/**
 * The school named by the start of an org: "UC Berkeley M.E.T." and "Berkeley Haas (Spieker)" give UC Berkeley, but
 * "Brooklyn Technical High School" is not Brooklyn College: at most three trailing words may be dropped, and never
 * words that name another school.
 */
function schoolPrefix(text: string, isSchool?: SchoolLookup): string | undefined {
  if (!isSchool) return undefined;
  const t = text
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+(?:for|in|with)\s+.*$/i, '')
    .trim();
  const whole = isSchool(t);
  if (whole) return whole;
  const words = t.split(/\s+/).filter(Boolean);
  for (let n = words.length - 1; n >= Math.max(1, words.length - 3); n--) {
    const dropped = words.slice(n).join(' ');
    if (SCHOOL_TYPE.test(dropped)) return undefined;
    const head = words.slice(0, n).join(' ');
    if (n === 1 && head.length <= 3) return undefined;
    const hit = isSchool(head);
    if (hit) return hit;
  }
  return undefined;
}

function schoolOf(part: string, isSchool?: SchoolLookup): Omit<HeadlineSchool, 'text'> | undefined {
  const year = yearOf(part);
  const bare = part.replace(YEAR, ' ').replace(/\s+/g, ' ').trim();
  // "CS @ Georgia Tech", "Economics at Stanford", "Molecular Biology @ San José State University"
  const at = AT.exec(bare);
  if (at?.[2]) {
    const org = cleanOrg(at[2]);
    const lhs = at[1]?.trim() ?? '';
    const rawOrg = at[2]
      .replace(/\s*\([^)]*\)\s*/g, ' ')
      .replace(/[.,;]+\s*$/, '')
      .trim();
    const canonical = schoolPrefix(rawOrg, isSchool) ?? schoolPrefix(org, isSchool);
    const job = JOB_WORD.test(lhs) && !/\b(student|undergrad\w*|phd|mba|major|minor)\b/i.test(lhs);
    if (canonical && !job) return { name: canonical, gradYear: year, field: lhs || undefined };
    const studentish =
      /\b(student|undergrad\w*|phd|mba|major|minor|studying|freshman|sophomore|junior|senior|b\.?s\.?|b\.?a\.?|m\.?s\.?|bsc|msc)\b/i.test(
        lhs,
      );
    if (!canonical && studentish && /\b(university|college|institute|school|polytechnic)\b/i.test(org))
      return { name: org, gradYear: year, field: lhs || undefined };
    return undefined;
  }
  if (!isSchool) return undefined;
  // "CS, IIT Delhi", "M.Tech IIT Kharagpur", "Michigan State University", "UCR '28 Neuroscience B.S.", "Purdue 30'"
  const cleaned = bare.replace(
    /\b(b\.?s\.?c?|b\.?a\.?|m\.?s\.?c?|m\.?tech|b\.?tech|b\.?e\.?|mba|phd|ph\.d\.?)(?=\s|,|$)\.?/gi,
    ' ',
  );
  const words = cleaned.split(/[\s,]+/).filter(Boolean);
  if (!words.length || words.length > 9) return undefined;
  for (let n = Math.min(6, words.length); n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const cand = words.slice(i, i + n).join(' ');
      // a single short word ("Cal", "MIT") stands alone only with a year or as the whole part
      if (n === 1 && cand.length <= 4 && !year && words.length > 1) continue;
      const canonical = isSchool(cand);
      if (!canonical) continue;
      const restWords = [...words.slice(0, i), ...words.slice(i + n)];
      const rest = restWords.join(' ').trim();
      if (JOB_WORD.test(rest) && !/\b(student|undergrad\w*|phd|mba|alum\w*)\b/i.test(rest)) return undefined;
      // the school is most of the part, or the rest is a short field ("CS", "Economics & Political Science")
      if (!year && restWords.length > 4) return undefined;
      return { name: canonical, gradYear: year, field: rest || undefined };
    }
  }
  return undefined;
}

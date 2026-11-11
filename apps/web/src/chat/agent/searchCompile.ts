/**
 * Network search without a model (plan 32 §6.9): the no-key router's reading of the common shapes of "who in my
 * network fits this", into a QuerySpec. It only claims a sentence that says it is about the student's own network
 * (YC, "in my network", "I know", alums, "I haven't talked to"); anything it cannot read stays with the other phrases.
 * Criteria are never produced here: with no model, nothing could check them.
 */
import { INDUSTRY_WORDS, type PositionSpec, type QuerySpec, type TitleFamily } from '@orbit/core/search';

const ROLE_WORDS: [RegExp, { families?: TitleFamily[]; founder?: boolean; titles?: string[] }][] = [
  [/\b(co-?founders?|founders?|founding team)\b/i, { founder: true }],
  [/\b(engineers?|swes?|developers?|programmers?)\b/i, { families: ['engineering'] }],
  [/\b(pms?|product managers?|product people)\b/i, { families: ['product'] }],
  [/\b(designers?)\b/i, { families: ['design'] }],
  [/\b(investors?|vcs?|venture capitalists?|angels?)\b/i, { families: ['investing'] }],
  [/\b(recruiters?)\b/i, { families: ['people_recruiting'] }],
  [/\b(data scientists?|ml engineers?|ai researchers?)\b/i, { families: ['data_ml'] }],
  [/\b(researchers?|professors?|phds?)\b/i, { families: ['research', 'education_academia'] }],
  [/\b(bankers?|analysts? at banks?)\b/i, { families: ['banking'] }],
  [/\b(consultants?)\b/i, { families: ['consulting'] }],
  [/\b(lawyers?|attorneys?)\b/i, { families: ['legal'] }],
  [/\b(marketers?)\b/i, { families: ['marketing'] }],
  [/\b(salespeople|sales people|account executives?)\b/i, { families: ['sales'] }],
];

const NETWORK =
  /\b(in my network|my network|i know|do i know|people i know|my connections|my contacts|alums?|alumni|y ?c\b|y combinator|(?:not|haven'?t|have not|never) (?:talked|spoken|reached out)|(?:went to|go to|from|at|attended) my (?:high ?school|hs|secondary school|college|university|uni|school|alma mater))\b/i;

const BATCH =
  /\b(?:yc\s*)?([wsfx])\s?'?(\d{2})\b|\b(winter|summer|fall|spring)\s+(?:of\s+)?'?(\d{2}|\d{4})\b/gi;
const SEASON: Record<string, string> = { winter: 'W', summer: 'S', fall: 'F', spring: 'X' };

const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };

function batchesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(BATCH)) {
    if (m[1] && m[2]) out.add(`${m[1].toUpperCase()}${m[2]}`);
    else if (m[3] && m[4]) out.add(`${SEASON[m[3].toLowerCase()]}${m[4].slice(-2)}`);
  }
  return [...out];
}

/** "at Stripe", "at Google or Meta": the company names after "at" (stopping at "in", "from", "who", a comma). */
function companiesIn(text: string): string[] {
  const m =
    /\b(?:at|from|who work at|working at)\s+([A-Z0-9][\w.&' -]*?)(?=\s+(?:[Ii]n|from|who|that|and [Ii]|[Ii])\b|[,?.]|$)/.exec(
      text,
    );
  // "ex-Google founders", "former Stripe engineers"
  const ex = /\b(?:ex-|former\s+)([A-Z][\w.&]*)/.exec(text);
  if (!m?.[1]) return ex?.[1] && !/^(yc|y)$/i.test(ex[1]) ? [ex[1]] : [];
  const raw = m[1].trim();
  if (/^(my|the|a|an|yc|y combinator)\b/i.test(raw)) return [];
  return raw
    .split(/\s+or\s+|\s*,\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "in SF", "in New York", "based in London": a place after "in" that is not "in my network" or a time. */
function placesIn(text: string): string[] {
  const m =
    /\b(?:in|based in|living in|around)\s+(?!my\b|the last\b|a\b|an\b|\d)([A-Z][\w.' -]*?)(?=\s+(?:who|that|at|from|and)\b|[,?.]|$)/.exec(
      text,
    );
  const raw = m?.[1]?.trim();
  if (!raw || /^(network|years?|months?|weeks?|days?|a while)$/i.test(raw)) return [];
  return raw
    .split(/\s+or\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "Berkeley alums", "alumni of Stanford", "from Michigan" (when it names a school). */
function schoolsIn(text: string): string[] {
  const a = /\b([A-Z][\w&.' -]*?)\s+(?:alums?|alumni|grads?)\b/.exec(text);
  if (a?.[1] && !/^(my|our|the|school)$/i.test(a[1].trim()))
    return [a[1].trim().replace(/^(?:all\s+)?/i, '')];
  const b =
    /\b(?:alums?|alumni|grads?) (?:of|from)\s+([A-Z][\w&.' -]*?)(?=\s+(?:in|at|who|that)\b|[,?.]|$)/.exec(
      text,
    );
  if (b?.[1]) return [b[1].trim()];
  // "who in my network went to Michigan" (YC is a batch, not a school)
  const c =
    /\b(?:went to|studied at|graduated from)\s+([A-Z][\w&.' -]*?)(?=\s+(?:in|at|who|that)\b|[,?.]|$)/.exec(
      text,
    );
  return c?.[1] && !/^(y ?c|y combinator)$/i.test(c[1].trim()) ? [c[1].trim()] : [];
}

/** Compiles one sentence, or undefined when it is not a network search this reader understands. */
/** The field an ask names after "in" ("works in climate", "in the fintech space"), when it is one Orbit knows. */
export function fieldIn(t: string): string | undefined {
  const m =
    /\bin\s+(?:the\s+)?([a-z][a-z-]{1,20}(?:\s[a-z-]{2,20})?)(?:\s+(?:space|industry|sector|world))?\s*\??$/i.exec(
      t,
    );
  if (!m) return undefined;
  const words = m[1]!.toLowerCase();
  const known = (w: string) =>
    w in INDUSTRY_WORDS || Object.values(INDUSTRY_WORDS).some((list) => list.includes(w));
  if (known(words)) return words;
  const first = words.split(' ')[0]!;
  return known(first) ? first : undefined;
}

export function compileSearch(text: string): QuerySpec | undefined {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!NETWORK.test(t)) return undefined;
  // other screens' words: the map, prep questions, friends' reach, routes into one company
  if (/\b(map|question|through (?:a |my )?friends?|routes? into|intro(?:duction)?s? to)\b/i.test(t))
    return undefined;
  const lower = t.toLowerCase();
  // a bare batch ("W25 founders") is YC too; the case-sensitive capital keeps "s23" in prose out
  const yc = /\b(y ?c|y combinator)\b/i.test(t) || /\b[WSFX]'?\d{2}\b/.test(t);
  const role: PositionSpec['role'] = {};
  for (const [re, r] of ROLE_WORDS)
    if (re.test(t)) {
      if (r.founder) role.founder = true;
      if (r.families) role.families = [...new Set([...(role.families ?? []), ...r.families])];
    }
  const companies = yc ? [] : companiesIn(t);
  const spec: QuerySpec = { ask: t };
  const hasRole = !!role.founder || !!role.families?.length;
  if (yc || hasRole || companies.length) {
    const position: PositionSpec = {};
    if (hasRole) position.role = role;
    if (yc || companies.length) {
      position.company = {};
      if (yc) {
        const batches = batchesIn(t);
        position.company.yc = batches.length ? { batches } : { any: true };
      }
      if (companies.length) position.company.names = companies;
    }
    // YC founders: they founded one, whether or not it is their job now
    if (yc && role.founder) position.when = 'ever';
    const ex = /\b(?:ex-|former\s+)([A-Z][\w.&]*)/.exec(t)?.[1];
    if (ex && hasRole && companies.includes(ex) && companies.length === 1) {
      // "ex-Google founders": a founder now, who was at Google before (two jobs, both must hold)
      delete position.company;
      spec.positions = [position, { company: { names: [ex] }, when: 'past' }];
    } else {
      if (/\b(ex-|former|used to|previously|formerly)\b/i.test(t)) position.when = 'past';
      spec.positions = [position];
    }
  }
  // "my high school", "my college", "my school": the student's own (their LinkedIn profile names them)
  const own =
    /\bmy (high ?school|hs|secondary school|college|university|uni|grad(?:uate)? school|business school|alma mater|school)\b/i.exec(
      t,
    )?.[1];
  const schools = own ? [] : schoolsIn(t);
  if (own) {
    const w = own.toLowerCase();
    spec.relationship = {
      ...spec.relationship,
      alumOfMySchool: true,
      ...(/high ?school|hs|secondary/.test(w)
        ? { mySchoolLevel: 'high_school' as const }
        : /college|university|uni/.test(w)
          ? { mySchoolLevel: 'college' as const }
          : /grad|business/.test(w)
            ? { mySchoolLevel: 'graduate' as const }
            : {}),
    };
  } else if (schools.length) spec.schools = [{ names: schools }];
  else if (/\b(alums?|alumni)\b/i.test(t) && /\b(my network|i know|my connections|my contacts)\b/i.test(t))
    spec.relationship = { ...spec.relationship, alumOfMySchool: true };
  const places = placesIn(t);
  if (places.length) spec.places = [{ names: places }];
  // a field ("who do I know who works in climate", "anyone I know in fintech"): the ask's topic, which the search and
  // its ladder widen to the field's neighbours (plan 36)
  const field = fieldIn(t);
  if (field && !places.length) spec.keywords = { terms: [field] };
  const quiet =
    /\b(?:not|haven'?t|have not|never)\s+(?:talked|spoken)(?: to)?(?: (?:them|in|for))*\s+(?:(a|an|one|\d+)\s+)?(day|week|month|year)s?\b/i.exec(
      t,
    );
  if (quiet) {
    const n = !quiet[1] || /^(a|an|one)$/i.test(quiet[1]) ? 1 : Number(quiet[1]);
    spec.relationship = { ...spec.relationship, quietForDays: n * UNIT_DAYS[quiet[2]!.toLowerCase()]! };
  } else if (/\b(?:never|haven'?t ever)\s+(?:talked|spoken)\b/i.test(t))
    spec.relationship = { ...spec.relationship, everTalked: false };
  if (/\b(close|know well|closest)\b/.test(lower))
    spec.relationship = { ...spec.relationship, warmthAtLeast: 'strong' };
  // "who do I know at Stripe" alone is a company question (routes into it); a search needs a kind of person, YC, a
  // school, or how the student knows them
  const kind =
    !!spec.keywords ||
    yc ||
    hasRole ||
    schools.length > 0 ||
    !!spec.relationship?.alumOfMySchool ||
    !!spec.relationship?.quietForDays ||
    spec.relationship?.everTalked === false;
  if (!kind) return undefined;
  return spec;
}

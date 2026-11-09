/**
 * Network search as chat tools (plan 32 §6.7): the model compiles the student's sentence into a QuerySpec (this file's
 * schema), the engine checks everyone, and the card lists the matches with the evidence behind each.
 *   search_network        one ask over the student's whole network (or a refinement of the last one)
 *   search_network_more   the next page of a result set, after the judge checks more people; or why one person is
 *                         (or is not) in it
 */
import type { Person } from '@orbit/core';
import { COMPANY_KINDS, type QuerySpec, SENIORITIES, STAGES, TITLE_FAMILIES } from '@orbit/core/search';
import { db } from '../../db/schema';
import { flagOn } from '../../engine/flags';
import {
  bandOfSet,
  explainInSet,
  moreOfSet,
  runNetworkSearch,
  type SearchOutcome,
} from '../../engine/networkSearch';
import { climbLadder, type Ladder } from '../../engine/networkSearch/ladder';
import { z } from '../../zod';
import type { ResultEnvelope, ToolContext } from '../types';
import { defineTool, err, ok } from './_shared';
import { searchPeople } from './read';

const need = z
  .enum(['must', 'nice'])
  .optional()
  .describe(
    'must: only people who meet it (default). nice: ranks people who meet it higher, keeps the rest.',
  );
const negate = z.boolean().optional().describe('true: people who do NOT meet this block ("not at Google").');

const role = z
  .object({
    titles: z
      .array(z.string())
      .optional()
      .describe('Job titles as said ("product manager", "partner", "SWE"). OR between them.'),
    families: z
      .array(z.enum(TITLE_FAMILIES))
      .optional()
      .describe(
        'Kinds of work, when the student names a field rather than a title ("engineers", "investors").',
      ),
    seniority: z.array(z.enum(SENIORITIES)).optional().describe('Exact levels ("interns", "VPs").'),
    seniorityAtLeast: z
      .enum(SENIORITIES)
      .optional()
      .describe('This level or above ("senior people": senior).'),
    founder: z.boolean().optional().describe('true for founders and co-founders.'),
  })
  .strict()
  .describe('What they do.');

const company = z
  .object({
    names: z
      .array(z.string())
      .optional()
      .describe('Company names as said ("Stripe", "McKinsey", "Google"). OR between them.'),
    withSubsidiaries: z
      .boolean()
      .optional()
      .describe('A named parent includes its brands (Google includes YouTube, DeepMind). Default true.'),
    kinds: z
      .array(z.enum(COMPANY_KINDS))
      .optional()
      .describe('Kinds of company ("big tech", "a bank", "a VC firm").'),
    yc: z
      .object({
        batches: z
          .array(z.string())
          .optional()
          .describe(
            'YC batches as said ("W26", "S25", "winter 2026", "spring 2025"). Empty means any batch.',
          ),
        any: z.boolean().optional().describe('true for any YC company.'),
      })
      .strict()
      .optional()
      .describe('Y Combinator companies. Use for "YC founders", "YC W26", "YC startups".'),
    stages: z.array(z.enum(STAGES)).optional().describe('Funding stage ("seed-stage", "Series A").'),
    sizeMin: z.number().int().optional().describe('At least this many employees.'),
    sizeMax: z.number().int().optional().describe('At most this many employees.'),
    industries: z
      .array(z.string())
      .optional()
      .describe('Industries as said ("fintech", "AI", "climate", "healthcare"). OR between them.'),
  })
  .strict()
  .describe('Where they work.');

const position = z
  .object({
    id: z.string().optional().describe('A short id ("p1") when anyOf refers to this block.'),
    role: role.optional(),
    company: company.optional(),
    when: z
      .enum(['current', 'past', 'ever'])
      .optional()
      .describe('current (default): their job now. past: "used to work at", "ex-Google". ever: either.'),
    startedWithinYears: z
      .number()
      .optional()
      .describe('Started this role within this many years ("joined recently": 1).'),
    endedWithinYears: z
      .number()
      .optional()
      .describe('Left within this many years ("recently left Meta": 2).'),
    need,
    negate,
  })
  .strict()
  .describe('One job: the role and the company must hold for the same job ("PMs at Stripe").');

const spec = z
  .object({
    ask: z.string().describe("The student's sentence, as they said it."),
    positions: z
      .array(position)
      .optional()
      .describe('Jobs. Several blocks are AND (all must hold); use anyOf for OR between blocks.'),
    anyOf: z
      .array(z.array(z.string()))
      .optional()
      .describe('Groups of position ids where one is enough ("founders or VCs": [["p1","p2"]]).'),
    schools: z
      .array(
        z
          .object({
            names: z
              .array(z.string())
              .describe('Schools as said ("Berkeley", "Stanford GSB"). OR between them.'),
            fields: z.array(z.string()).optional().describe('Fields of study ("CS", "EECS").'),
            degree: z
              .array(z.enum(['undergrad', 'masters', 'mba', 'phd', 'high_school']))
              .optional()
              .describe('Degrees.'),
            gradFrom: z.number().int().optional().describe('Class year from (inclusive).'),
            gradTo: z.number().int().optional().describe('Class year to (inclusive).'),
            need,
            negate,
          })
          .strict(),
      )
      .optional()
      .describe('Schools they went to or attend. Several blocks are AND.'),
    places: z
      .array(
        z
          .object({
            names: z
              .array(z.string())
              .describe('Places as said ("SF", "the Bay Area", "NYC", "London"). OR between them.'),
            need,
            negate,
          })
          .strict(),
      )
      .optional()
      .describe('Where they live or work.'),
    keywords: z
      .object({
        terms: z
          .array(z.string())
          .describe('Words or topics to find in what they wrote ("robotics", "LLM evals").'),
        need,
        negate,
      })
      .strict()
      .optional()
      .describe('Topics. Prefer positions or criteria when the ask says a role or a company.'),
    relationship: z
      .object({
        warmthAtLeast: z
          .enum(['light', 'warm', 'strong', 'close'])
          .optional()
          .describe('At least this close ("people I know well": strong).'),
        types: z
          .array(
            z.enum([
              'recruiter',
              'alumni',
              'peer',
              'mentor',
              'professor',
              'family_friend',
              'colleague',
              'other',
            ]),
          )
          .optional()
          .describe('How the student knows them.'),
        everTalked: z
          .boolean()
          .optional()
          .describe('true: they have emailed, met or messaged. false: never.'),
        talkedWithinDays: z.number().int().optional().describe('Talked within this many days.'),
        quietForDays: z
          .number()
          .int()
          .optional()
          .describe('Not talked for at least this many days ("haven\'t talked in a while": 90).'),
        touched: z
          .array(
            z
              .object({
                channel: z.enum(['email', 'meeting', 'text', 'linkedin']).describe('The channel.'),
                direction: z
                  .enum(['in', 'out', 'any'])
                  .optional()
                  .describe('in: they wrote. out: the student wrote.'),
                withinDays: z.number().int().optional().describe('Within this many days.'),
                beforeDays: z.number().int().optional().describe('Longer ago than this many days.'),
                negate: z.boolean().optional().describe('true: never on this channel in that window.'),
              })
              .strict(),
          )
          .optional()
          .describe('Contact on a channel ("people I emailed this month").'),
        connectedWithinDays: z
          .number()
          .int()
          .optional()
          .describe('Connected on LinkedIn within this many days.'),
        hasChat: z.boolean().optional().describe('true: there is a chat with them in Orbit.'),
        tags: z.array(z.string()).optional().describe("The student's own tags on people."),
        alumOfMySchool: z.boolean().optional().describe("true: went to the student's school."),
      })
      .strict()
      .optional()
      .describe('The tie to the student, from their email, calendar, texts and LinkedIn.'),
    criteria: z
      .array(
        z
          .object({
            text: z
              .string()
              .describe(
                'One thing a person must be, said plainly ("works on AI agents", "has raised a seed round").',
              ),
            need,
          })
          .strict(),
      )
      .optional()
      .describe(
        'At most 3 things no field above can say. Each is checked by reading each person, with a quote.',
      ),
    unsupported: z
      .array(z.string())
      .optional()
      .describe(
        'Parts of the ask Orbit cannot check at all (age, ethnicity, salary). Said back to the student, never guessed.',
      ),
    sort: z
      .enum(['match', 'warmth', 'recent', 'name'])
      .optional()
      .describe('match (default): best evidence first. warmth: closest first. recent: last talked first.'),
    refine: z
      .object({
        resultSetId: z.string().describe('The setId of the earlier search.'),
        mode: z
          .enum(['narrow', 'widen', 'replace'])
          .describe('narrow: add a condition. widen: drop one. replace: change one.'),
        onlyThese: z
          .boolean()
          .optional()
          .describe(
            'true: only among the earlier results ("of those, who is in SF"). Default: the whole network again.',
          ),
      })
      .strict()
      .optional()
      .describe('A follow-up to an earlier search: send the WHOLE revised spec, plus this.'),
    limit: z.number().int().min(1).max(50).optional().describe('Rows to show (default 25).'),
  })
  .strict();

type Outcome = SearchOutcome;

export interface TableRow {
  person: Pick<
    Person,
    'id' | 'displayName' | 'currentTitle' | 'currentOrganizationRaw' | 'photoUrl' | 'linkedinUrl'
  >;
  band: string;
  evidence?: string;
  missing?: string;
  warmth: string;
  lastTalk?: string;
}

/** Result rows as the card shows them, with each person's photo and LinkedIn from this browser's records. */
async function toTableRows(list: Outcome['rows']): Promise<TableRow[]> {
  const people = await db.people.bulkGet(list.map((r) => r.personId));
  const byId = new Map(people.filter((p): p is Person => !!p).map((p) => [p.id, p]));
  return list.map((r) => {
    const p = byId.get(r.personId);
    return {
      person: {
        id: r.personId,
        displayName: r.name,
        currentTitle: r.title,
        currentOrganizationRaw: r.company,
        photoUrl: p?.photoUrl,
        linkedinUrl: p?.linkedinUrl,
      },
      band: r.band,
      evidence: r.evidence,
      missing: r.missing,
      warmth: r.warmth,
      lastTalk: r.lastTalk,
    };
  });
}

/** The card's Confirmed or Likely tab, read from the set kept in this tab; undefined once it is gone. */
export async function bandTableRows(
  setId: string,
  band: 'strong' | 'likely',
): Promise<TableRow[] | undefined> {
  const list = bandOfSet(setId, band);
  return list ? toTableRows(list) : undefined;
}

/** The next rungs on the card (plan 36): who to show when nobody fits, each section labelled with its tier. */
export interface FallbackSection {
  tier: string;
  label: string;
  rows: TableRow[];
}

async function fallbackSections(l: Ladder | undefined): Promise<FallbackSection[] | undefined> {
  if (!l?.rungs.length) return undefined;
  const ids = l.rungs.flatMap((r) => r.rows.map((x) => x.personId));
  const people = await db.people.bulkGet(ids);
  const byId = new Map(people.filter((p): p is Person => !!p).map((p) => [p.id, p]));
  return l.rungs.map((r) => ({
    tier: r.tier,
    label: r.label,
    rows: r.rows.map((x) => ({
      person: {
        id: x.personId,
        displayName: x.name,
        currentTitle: x.title,
        currentOrganizationRaw: x.company,
        photoUrl: byId.get(x.personId)?.photoUrl,
        linkedinUrl: byId.get(x.personId)?.linkedinUrl,
      },
      band: r.tier,
      evidence: x.why,
      warmth: x.warmth,
    })),
  }));
}

async function tableData(o: Outcome, ladder?: Ladder) {
  const rows = await toTableRows(o.rows);
  const c = o.set.result.counts;
  const unknownBy = Object.entries(o.set.result.unknownBy)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([label, n]) => ({ label, n }));
  return {
    setId: o.set.id,
    ask: o.set.ask,
    askHash: o.set.askHash,
    counts: c,
    notes: o.set.notes,
    relaxed: o.set.relaxed,
    unknownBy,
    remaining: o.remaining,
    judgeFailed: o.set.judgeFailed,
    judgeUnavailable: o.set.judgeUnavailable,
    profilesRead: o.set.profilesRead,
    unsupported: o.set.spec.unsupported ?? [],
    rows,
    /** what the ask was about, for the next rungs' wording */
    topic: ladder?.topic,
    /** someone in a related field or who used to work there: close to a match, not only someone to ask */
    nearFit: ladder?.nearFit,
    fallback: await fallbackSections(ladder),
  };
}

type TableData = Awaited<ReturnType<typeof tableData>>;

/** "3 in a related field (Ana Ruiz, Ben Ode), 2 who could know someone" */
function fallbackLine(d: TableData): string {
  return (d.fallback ?? [])
    .map((s) => {
      const names = s.rows
        .slice(0, 2)
        .map((r) => r.person.displayName)
        .join(', ');
      const what =
        s.tier === 'related'
          ? 'in a related field'
          : s.tier === 'former'
            ? 'who used to work there'
            : s.tier === 'intro'
              ? 'who can introduce you'
              : 'who could know someone';
      return `${s.rows.length} ${what} (${names})`;
    })
    .join(', ');
}

function summaryOf(d: TableData): string {
  const c = d.counts;
  const sure = c.strong;
  const likely = c.likely;
  // plan 36: an empty answer is never the whole answer; the next tier comes first
  if (!sure && !likely && d.fallback?.length)
    return `No exact match for ${d.topic ?? 'that'} yet. Closest: ${fallbackLine(d)}.`;
  const parts: string[] = [];
  if (sure) parts.push(`${sure} ${sure === 1 ? 'person matches' : 'people match'}`);
  if (likely) parts.push(`${likely} likely`);
  if (!sure && !likely) parts.push('No exact match in your network yet');
  let s = parts.join(', ');
  // who could not be checked stays out of the answer when someone matched: the student asked who fits
  if (!sure && !likely && d.unknownBy[0])
    s += `. ${d.unknownBy[0].label} is not on file for most of your network`;
  if (d.relaxed) s += `. Loosened: ${d.relaxed}`;
  return `${s}.`;
}

/** Rows of a result set the model reads (plan 35 A3); the rest are on the card and a search_network_more away. */
export const SEARCH_MODEL_ROWS = 10;

/** What the model reads of a search: counts, guidance and the first SEARCH_MODEL_ROWS rows (the card shows all). */
export function forModel(d: TableData) {
  const found = d.counts.strong + d.counts.likely;
  return {
    setId: d.setId,
    // who could not be checked is only for explaining an empty answer
    counts: found ? { strong: d.counts.strong, likely: d.counts.likely } : d.counts,
    replyStyle: found
      ? 'The card already lists everyone. Answer in one or two short sentences: how many match, then name the two or three the student is closest to or talked with most recently, with their company. Write names exactly as given. Do not mention people who could not be checked.'
      : NO_MATCH_STYLE,
    notes: d.notes,
    relaxed: d.relaxed,
    unsupported: d.unsupported,
    notOnFile: found ? undefined : d.unknownBy,
    nextStep: found ? undefined : nextRung(d),
    nextTier: found
      ? undefined
      : d.fallback?.map((s) => ({
          tier: s.tier,
          label: s.label,
          rows: s.rows.slice(0, 5).map((r) => ({
            personId: r.person.id,
            name: r.person.displayName,
            title: r.person.currentTitle,
            company: r.person.currentOrganizationRaw,
            why: r.evidence,
            warmth: r.warmth,
          })),
        })),
    stillToCheck: d.remaining,
    judgeFailed: d.judgeFailed || undefined,
    profilesReadNow: d.profilesRead || undefined,
    noAiCheck: d.judgeUnavailable || undefined,
    rows: d.rows.slice(0, SEARCH_MODEL_ROWS).map((r) => ({
      personId: r.person.id,
      name: r.person.displayName,
      title: r.person.currentTitle,
      company: r.person.currentOrganizationRaw,
      band: r.band,
      evidence: r.evidence,
      missing: r.missing,
      warmth: r.warmth,
      lastTalk: r.lastTalk,
    })),
    shownToStudent: d.rows.length,
  };
}

/** How to word an answer whose exact search found nobody (plan 36): the tier in one clause, then people. */
const NO_MATCH_STYLE =
  'Nobody matched exactly, so never answer with nobody. The card shows the next tier (nextTier). Open with one honest clause on the tier ("Nobody you know works in climate itself; the closest are"), then name two or three people from nextTier with why each is there, in its words. A related-field or used-to-work-there person is someone the student knows, never a match; a could-know-someone person is a guess, never a fact about who they know. Then do nextStep.';

/** The paid rung that comes next, for the model to run without asking (plan 36 §2). */
function nextRung(d: TableData): string {
  const topic = d.topic ?? 'that';
  const source = `call find_people with the same ask (purpose, query, and the organization, school or topic) to show people in ${topic} the student could reach, labelled as new people they do not know yet`;
  if (d.nearFit)
    return `Present the closest people above. Then, if the student asked for people to reach or meet, ${source}, in this turn; if they only asked who they know, end with one short question offering to find people in ${topic} beyond their network.`;
  return `Nobody the student knows is in ${topic} or near it. In this same turn, without asking, ${source}. If find_people cannot run or finds nobody, use web_search for people in ${topic} (for a named person: how others have reached them, and who works with them) and list them as rows with the source in words. Then answer with both tiers: the new people first, then who could introduce the student.`;
}

const strings = (what: string) => z.array(z.string()).optional().describe(what);

/**
 * The model's form of a network search (plan 35 A1): the sentence plus a few flat filters, expanded into a QuerySpec
 * here. The full spec (blocks, anyOf, negation per block) stays for the router's compiled specs (search_network_spec).
 */
const flat = z
  .object({
    ask: z.string().describe("The student's sentence, as they said it."),
    roles: strings('Jobs or kinds of work as said ("PM", "engineers", "founders"). OR.'),
    companies: strings('Companies as said ("Stripe"). OR; with roles, the same job.'),
    companyKinds: z.array(z.enum(COMPANY_KINDS)).optional().describe('Kinds of company.'),
    yc: strings('YC batches as said ("W26"); [] for any YC company.'),
    industries: strings('Industries as said ("fintech").'),
    when: z
      .enum(['current', 'past', 'ever'])
      .optional()
      .describe('current (default), past ("ex-Google") or ever.'),
    notAt: strings('Companies to leave out ("not at Google").'),
    schools: strings('Schools as said ("Berkeley").'),
    places: strings('Places ("SF").'),
    topics: strings('Topics in what they wrote ("robotics").'),
    warmthAtLeast: z
      .enum(['light', 'warm', 'strong', 'close'])
      .optional()
      .describe('At least this close ("know well": strong).'),
    talkedWithinDays: z.number().int().optional().describe('Talked within this many days.'),
    quietForDays: z.number().int().optional().describe('Not talked for this many days or more.'),
    neverTalked: z.boolean().optional().describe('true: never emailed, met or messaged.'),
    alumOfMySchool: z.boolean().optional().describe("true: went to the student's school."),
    criteria: strings(
      'At most 3 things no field can say ("works on AI agents"), checked by reading each person.',
    ),
    unsupported: strings('Parts Orbit cannot check (age, salary): said back, never guessed.'),
    refine: z
      .string()
      .optional()
      .describe('For a follow-up: the earlier setId; send every filter again, revised.'),
    onlyThese: z.boolean().optional().describe('With refine: only among the earlier results.'),
    sort: z
      .enum(['match', 'warmth', 'recent', 'name'])
      .optional()
      .describe('match (default), warmth (closest first) or recent (last talked first).'),
    limit: z.number().int().min(1).max(50).optional().describe('Rows to show (default 25).'),
  })
  .strict();

type FlatSearch = z.infer<typeof flat>;

const some = (xs: string[] | undefined) => (xs ?? []).map((x) => x.trim()).filter(Boolean);

/** The flat filters as the engine's QuerySpec: one job block for roles, companies and YC, then the rest. */
export function specOfFlat(f: FlatSearch): QuerySpec {
  const spec: QuerySpec = { ask: f.ask };
  const roles = some(f.roles);
  const companies = some(f.companies);
  const industries = some(f.industries);
  const positions: NonNullable<QuerySpec['positions']> = [];
  if (roles.length || companies.length || f.companyKinds?.length || f.yc || industries.length) {
    const company: NonNullable<NonNullable<QuerySpec['positions']>[number]['company']> = {};
    if (companies.length) company.names = companies;
    if (f.companyKinds?.length) company.kinds = f.companyKinds;
    if (f.yc) company.yc = some(f.yc).length ? { batches: some(f.yc) } : { any: true };
    if (industries.length) company.industries = industries;
    positions.push({
      ...(roles.length ? { role: { families: roles as never } } : {}),
      ...(Object.keys(company).length ? { company } : {}),
      ...(f.when ? { when: f.when } : {}),
    });
  }
  if (some(f.notAt).length) positions.push({ company: { names: some(f.notAt) }, negate: true });
  if (positions.length) spec.positions = positions;
  if (some(f.schools).length) spec.schools = [{ names: some(f.schools) }];
  if (some(f.places).length) spec.places = [{ names: some(f.places) }];
  if (some(f.topics).length) spec.keywords = { terms: some(f.topics) };
  const rel: NonNullable<QuerySpec['relationship']> = {};
  if (f.warmthAtLeast) rel.warmthAtLeast = f.warmthAtLeast;
  if (f.talkedWithinDays) rel.talkedWithinDays = f.talkedWithinDays;
  if (f.quietForDays) rel.quietForDays = f.quietForDays;
  if (f.neverTalked) rel.everTalked = false;
  if (f.alumOfMySchool) rel.alumOfMySchool = true;
  if (Object.keys(rel).length) spec.relationship = rel;
  if (some(f.criteria).length)
    spec.criteria = some(f.criteria)
      .slice(0, 3)
      .map((text) => ({ text }));
  if (some(f.unsupported).length) spec.unsupported = some(f.unsupported);
  if (f.refine) spec.refine = { resultSetId: f.refine, mode: 'replace', onlyThese: f.onlyThese };
  if (f.sort) spec.sort = f.sort;
  if (f.limit) spec.limit = f.limit;
  return spec;
}

async function runSearch(input: QuerySpec, ctx: ToolContext): Promise<ResultEnvelope> {
  // switched off (engine/flags): the plain name, company and title search, on the words the spec names
  if (!(await flagOn('networkSearch'))) {
    const query =
      input.positions?.flatMap((p) => p.company?.names ?? [])[0] ??
      input.schools?.[0]?.names[0] ??
      input.keywords?.terms[0];
    return searchPeople.execute({ query }, ctx);
  }
  const out = await runNetworkSearch(ctx.user, input, {
    caller: ctx.caller,
    signal: ctx.signal,
    shown: input.limit,
  });
  if (!out.ok) return err(out.message);
  // plan 36: nobody who fits, so the free rungs run now (related field, past jobs, intro paths, people to ask)
  const found = out.set.result.counts.strong + out.set.result.counts.likely;
  const ladder = found
    ? undefined
    : await climbLadder(ctx.user, out.set, { now: ctx.now, signal: ctx.signal }).catch(() => undefined);
  const d = await tableData(out, ladder);
  return ok('people_table', d, forModel(d), summaryOf(d));
}

export const searchNetwork = defineTool({
  name: 'search_network',
  kind: 'read',
  description:
    'Call this when the student asks who in their network fits a description: a role, company, kind of company (YC, big tech, a VC firm), school, place, industry, topic, or how they know them ("YC founders I know", "Berkeley alums at Stripe in SF", "PMs I have not talked to in a year"). Put each part of the sentence in its field; criteria only for what no field can say. Rows come with their evidence: strong rows are sure, likely rows rest on weaker evidence, people with nothing on file are counted, never guessed. Use search_people to find one person by name.',
  input: flat,
  capabilities: ['network_search'],
  progress: 'Checking your network',
  execute: (input, ctx) => runSearch(specOfFlat(input), ctx),
  toModel: (data: unknown) => (data as { forModel: unknown }).forModel,
});

/** The router's form: a QuerySpec compiled without a model (agent/searchCompile.ts). Never offered to the model. */
export const searchNetworkSpec = defineTool({
  name: 'search_network_spec',
  kind: 'read',
  description:
    'Call this when the no-key router compiled a network search into a full QuerySpec; the model uses search_network instead.',
  input: spec,
  capabilities: ['network_search'],
  progress: 'Checking your network',
  execute: (input, ctx) => runSearch(input as QuerySpec, ctx),
  toModel: (data: unknown) => (data as { forModel: unknown }).forModel,
});

export const searchNetworkMore = defineTool({
  name: 'search_network_more',
  kind: 'read',
  description:
    'Call this after search_network when the student wants more of the same results ("show more", "check the rest"), or asks why someone is or is not in them ("why Maya?", "is Sam not a match?"). more: the judge checks the next people and the next page is shown. explain: every check for one person with its evidence.',
  input: z
    .object({
      setId: z.string().describe('The setId search_network returned.'),
      action: z
        .enum(['more', 'explain'])
        .describe('more: the next page. explain: why one person is or is not a match.'),
      personId: z
        .string()
        .optional()
        .describe('For explain: the person (an id from the rows or from search_people).'),
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('For more: which page (1 is the second page, default 1).'),
    })
    .strict(),
  capabilities: ['network_search'],
  progress: 'Checking more people',
  async execute(input, ctx) {
    if (input.action === 'explain') {
      if (!input.personId) return err('Say which person to explain.');
      const v = explainInSet(input.setId, input.personId);
      if (!v) return err('That search is no longer open here, or that person is not in Orbit. Ask it again.');
      const verdict =
        v.band === 'strong'
          ? 'matches'
          : v.band === 'likely'
            ? 'likely matches'
            : v.band === 'no'
              ? 'does not match'
              : 'could not be checked';
      const lines = v.checks.map((c) => `${c.label}: ${c.answer}${c.evidence ? ` (${c.evidence})` : ''}`);
      return ok(
        'list',
        {
          title: `${v.name} ${verdict}`,
          items: v.checks.map((c) => ({ text: c.label, sub: c.evidence, chip: c.answer })),
        },
        { name: v.name, band: v.band, checks: v.checks },
        `${v.name} ${verdict}. ${lines.slice(0, 3).join('. ')}`,
        `/people/${v.personId}`,
      );
    }
    const out = await moreOfSet(input.setId, { page: input.page, signal: ctx.signal });
    if (!out.ok) return err(out.message);
    const d = await tableData(out);
    return ok(
      'people_table',
      d,
      forModel(d),
      d.rows.length ? summaryOf(d) : 'That is everyone in this search.',
    );
  },
  toModel: (data: unknown) => (data as { forModel: unknown }).forModel,
});

export const searchTools = [searchNetwork, searchNetworkMore, searchNetworkSpec];

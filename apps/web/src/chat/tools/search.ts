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
import { z } from '../../zod';
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

async function tableData(o: Outcome) {
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
  };
}

function summaryOf(d: Awaited<ReturnType<typeof tableData>>): string {
  const c = d.counts;
  const sure = c.strong;
  const likely = c.likely;
  const parts: string[] = [];
  if (sure) parts.push(`${sure} ${sure === 1 ? 'person matches' : 'people match'}`);
  if (likely) parts.push(`${likely} likely`);
  if (!sure && !likely) parts.push('Nobody in your network clearly matches');
  let s = parts.join(', ');
  // who could not be checked stays out of the answer when someone matched: the student asked who fits
  if (!sure && !likely && d.unknownBy[0])
    s += `. ${d.unknownBy[0].label} is not on file for most of your network`;
  if (d.relaxed) s += `. Loosened: ${d.relaxed}`;
  return `${s}.`;
}

function forModel(d: Awaited<ReturnType<typeof tableData>>) {
  const found = d.counts.strong + d.counts.likely;
  return {
    setId: d.setId,
    // who could not be checked is only for explaining an empty answer
    counts: found ? { strong: d.counts.strong, likely: d.counts.likely } : d.counts,
    replyStyle:
      'The card already lists everyone. Answer in one or two short sentences: how many match, then name the two or three the student is closest to or talked with most recently, with their company. Write names exactly as given. Do not mention people who could not be checked.',
    notes: d.notes,
    relaxed: d.relaxed,
    unsupported: d.unsupported,
    notOnFile: found ? undefined : d.unknownBy,
    stillToCheck: d.remaining,
    judgeFailed: d.judgeFailed || undefined,
    profilesReadNow: d.profilesRead || undefined,
    noAiCheck: d.judgeUnavailable || undefined,
    rows: d.rows.slice(0, 15).map((r) => ({
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

export const searchNetwork = defineTool({
  name: 'search_network',
  kind: 'read',
  description:
    'Call this when the student asks who in their network fits a description: a role, company, kind of company (YC, big tech, a VC firm, seed stage), school, class year, place, industry, topic, or how they know them ("YC founders I know", "Berkeley alums at Stripe in SF", "PMs I have not talked to in a year", "investors who reply to me"). Compile the sentence into the spec: positions for jobs (role and company in ONE block when they go together), schools, places, relationship for the tie, criteria only for what no field can say (at most 3), unsupported for what Orbit cannot check. Every row comes with the evidence behind it; strong rows are sure, likely rows rest on weaker evidence, and people whose details are not on file are counted, never guessed. For a follow-up ("only the ones in SF", "what about Stanford") send the whole revised spec with refine. Use search_people instead to find one person by name.',
  input: spec,
  capabilities: ['network_search'],
  progress: 'Checking your network',
  async execute(input, ctx) {
    // switched off (engine/flags): the plain name, company and title search, on the words the spec names
    if (!(await flagOn('networkSearch'))) {
      const s = input as QuerySpec;
      const query =
        s.positions?.flatMap((p) => p.company?.names ?? [])[0] ??
        s.schools?.[0]?.names[0] ??
        s.keywords?.terms[0];
      return searchPeople.execute({ query }, ctx);
    }
    const out = await runNetworkSearch(ctx.user, input as QuerySpec, {
      caller: ctx.caller,
      signal: ctx.signal,
      shown: input.limit,
    });
    if (!out.ok) return err(out.message);
    const d = await tableData(out);
    return ok('people_table', d, forModel(d), summaryOf(d));
  },
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

export const searchTools = [searchNetwork, searchNetworkMore];

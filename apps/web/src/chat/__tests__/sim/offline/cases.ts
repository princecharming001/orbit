/**
 * Single-turn requests for the offline simulation: every capability's example requests (capabilities.ts) on the
 * sample student, the first of each on the real-looking student, and hand-written requests phrased the ways students
 * type them (casual, typos, lowercase, terse, polite, two asks in one, a follow-up with nothing before it), each with
 * what should happen.
 */
import { CAPABILITIES } from '../../../capabilities';
import type { AccountId } from './accounts';
import { CAP_EXPECT } from './expectations';
import { type Case, capabilityTools, type Expect } from './runner';

/** Names in the capability examples, mapped to people each account has (one match each, at the stage the example
 * implies). A name followed by a capitalised word ("Priya Shah") is a new person and stays. */
const NAMES: Record<'demo' | 'student', Record<string, string>> = {
  demo: {
    Priya: 'Hannah',
    Sam: 'Caleb',
    Mei: 'Ethan',
    Tom: 'Jonah',
    Jordan: 'Noah',
    Marcus: 'Daniel',
    Jane: 'Victor',
    Sana: 'Theo',
    Felix: 'Chloe',
    Mateo: 'Rhea',
    Dan: 'Daniel',
  },
  student: {
    Priya: 'Priya Raman',
    Omar: 'Ava',
    Lena: 'Tomás',
    Sam: 'Marcus',
    Mei: 'Priya Raman',
    Tom: 'Jake',
    Jordan: 'Aisha',
    Jane: 'Ben',
    Maya: 'Lauren',
    Daniel: 'Jake',
    Sana: 'Rachel',
    Felix: 'Chris',
    Mateo: 'Kevin',
    Dan: 'Marcus',
    Hannah: 'Ava',
    Diego: 'Grace',
  },
};

export function withNames(text: string, account: AccountId): string {
  const map = account === 'demo' ? NAMES.demo : NAMES.student;
  let out = text;
  for (const [from, to] of Object.entries(map))
    out = out.replace(new RegExp(`(?<![\\p{L}])${from}(?![\\p{L}])(?! [A-Z][a-z])`, 'gu'), to);
  return out;
}

const claimers = capabilityTools();

/** What a capability's example should do: its own expectation, or one of the tools that claim it (or a question). */
export function capExpect(capId: string): Expect {
  const own = CAP_EXPECT[capId];
  if (own) return own;
  return { tool: claimers.get(capId) ?? [], ask: true };
}

function capabilityCases(): Case[] {
  const out: Case[] = [];
  for (const c of CAPABILITIES) {
    // every example once on each account would be 1,200 runs; the first runs on both, the second on the sample
    // student and the third on the real-looking one
    c.utterances.forEach((u, i) => {
      const on: AccountId[] = i === 0 ? ['demo', 'student'] : i === 1 ? ['demo'] : ['student'];
      for (const account of on)
        out.push({
          id: `cap:${c.id}:${i}${account === 'demo' ? '' : ':student'}`,
          account,
          area: c.area,
          cap: c.id,
          variant: 'as listed',
          text: withNames(u, account),
          expect: capExpect(c.id),
        });
    });
  }
  return out;
}

// ---- requests phrased the way students type them ----------------------------------------------------------------

interface Base {
  text: string;
  account: AccountId;
  area: string;
  expect: Expect;
  /** skip the generated typo, lowercase or polite versions (a phrase where they change the meaning) */
  only?: boolean;
}

const B = (account: AccountId, area: string, text: string, expect: Expect, only?: boolean): Base => ({
  account,
  area,
  text,
  expect,
  only,
});

const BASES: Base[] = [
  B('student', 'today', "What's on today?", { tool: 'get_today_brief' }),
  B('student', 'today', 'Who should I message today?', { tool: 'get_today_brief' }),
  B('student', 'pipeline', 'Show my pipeline', { tool: 'list_pipeline' }),
  B('student', 'pipeline', 'Who went quiet?', { tool: 'list_pipeline' }),
  B('student', 'pipeline', 'Who is scheduled?', { tool: 'list_pipeline' }),
  B('student', 'pipeline', 'Who replied?', { tool: 'list_pipeline' }),
  B('student', 'pipeline', 'Move Marcus to no response', {
    tool: 'move_pipeline_stage',
    stage: ['Marcus Lee', 'no_response'],
  }),
  B('student', 'people', 'Who is Priya Raman?', { tool: 'get_person' }),
  B('student', 'people', 'Prep me for my chat with Priya Raman', { tool: 'get_person' }),
  B('student', 'people', 'Prep me for my next chat', { tool: 'get_person' }),
  B('student', 'people', 'What do I know about Tomás?', { tool: 'get_person' }),
  B('student', 'people', 'Add Jordan Kim at Stripe, jordan.kim@stripe.com', {
    tool: 'add_person',
    personAdded: 'Jordan Kim',
  }),
  B('student', 'drafts', 'Draft a thank you to Tomás', { tool: 'create_draft', draftFor: 'Tomás Herrera' }),
  B('student', 'drafts', 'Follow up with Marcus', { tool: 'create_draft', draftFor: 'Marcus Lee' }),
  B('student', 'drafts', 'Write to Jake Morrison', { tool: 'create_draft' }),
  B('student', 'drafts', 'Show my drafts', { tool: 'list_drafts' }),
  B('student', 'drafts', 'Send my draft to Marcus', { tool: 'send_draft', pending: true }),
  B('student', 'drafts', 'Ask Ava for a referral', { tool: 'create_draft' }),
  B('student', 'drafts', 'Congratulate Lauren', { tool: 'create_draft' }),
  B('student', 'notes', 'Note about Ava: she will look at my resume before applications open', {
    tool: 'add_note',
    noteAdded: true,
  }),
  B('student', 'notes', 'Show my notes', { tool: 'list_notes' }),
  B('student', 'map', 'Who do I know at Stripe?', { tool: 'find_routes' }),
  B('student', 'map', 'Who can introduce me to Jake Morrison?', { tool: 'find_routes' }),
  B('student', 'map', 'Who knows Lauren Park?', { tool: ['get_mutual_connections', 'find_routes'] }),
  B('student', 'discover', 'Who should I meet?', { tool: 'list_recommendations' }),
  B('student', 'integrations', 'Connect my Gmail', { tool: 'show_setup' }),
  B('student', 'integrations', 'Import my LinkedIn connections', { tool: 'show_setup' }),
  B('student', 'settings', 'Set my tone to formal', { tool: 'update_settings' }),
  B('student', 'settings', 'Add Notion to my target companies', { tool: 'manage_target_company' }),
  B('student', 'goals', 'Show my goals', { tool: 'list_goals' }),
  B('demo', 'today', "What's on today?", { tool: 'get_today_brief' }),
  B('demo', 'pipeline', 'Who went quiet?', { tool: 'list_pipeline' }),
  B('demo', 'drafts', 'Draft a thank you to Lena', { tool: 'create_draft' }),
  B('demo', 'drafts', 'Follow up with Daniel', { tool: 'create_draft' }),
  B('demo', 'map', 'Who can introduce me to Stripe?', { tool: 'find_routes' }),
  B('demo', 'people', 'Prep me for my next chat', { tool: 'get_person' }),
  B('demo', 'discover', 'Show my recommendations', { tool: 'list_recommendations' }),
  B('demo', 'drafts', 'Unsent drafts', { tool: 'list_drafts' }),
];

/** Swap two letters inside the longest word that is not a name: "pipeline" -> "pipleine". */
function typo(text: string): string | undefined {
  const words = text.split(' ');
  let best = -1;
  words.forEach((w, i) => {
    const clean = w.replace(/[^a-z]/g, '');
    if (
      clean.length >= 5 &&
      clean === w.replace(/[?.!,]/g, '') &&
      (best < 0 || clean.length > words[best]!.length)
    )
      best = i;
  });
  if (best < 0) return undefined;
  const w = words[best]!;
  const j = Math.floor(w.length / 2);
  words[best] = w.slice(0, j - 1) + w[j] + w[j - 1] + w.slice(j + 1);
  return words.join(' ');
}

const lowerCase = (t: string) =>
  t
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[?.!]+$/, '');
/** "Hey Orbit, could you show my pipeline please?"; a question stays a question: "Hey Orbit, who went quiet?" */
const polite = (t: string) =>
  /^(who|what|how|where|which|when|is|are|do|does|can)\b/i.test(t)
    ? `Hey Orbit, ${t.charAt(0).toLowerCase()}${t.slice(1).replace(/[?.!]$/, '')}?`
    : `Hey Orbit, could you ${t.charAt(0).toLowerCase()}${t.slice(1).replace(/[?.!]$/, '')} please?`;
const terse = (t: string) =>
  t
    .replace(/^(show|show me|open)\s+/i, '')
    .replace(/\b(my|the)\s+/gi, '')
    .replace(/[?.!]$/, '');

function phrasedCases(): Case[] {
  const out: Case[] = [];
  BASES.forEach((b, n) => {
    const add = (variant: string, text: string | undefined) => {
      if (!text) return;
      out.push({
        id: `say:${n}:${variant}`,
        account: b.account,
        area: b.area,
        variant,
        text,
        expect: b.expect,
      });
    };
    add('as written', b.text);
    if (b.only) return;
    add('lowercase', lowerCase(b.text));
    add('typo', typo(b.text));
    add('polite', polite(b.text));
    const t = terse(b.text);
    if (t.split(' ').length >= 2 && t !== b.text.replace(/[?.!]$/, '')) add('terse', t);
  });
  return out;
}

/** Requests that only make sense in context, sent cold: a question back, never a guess. */
const COLD: Case[] = [
  ['and her?', 'student'],
  ['do it', 'student'],
  ['the second one', 'student'],
  ['send it', 'student'],
  ['make it shorter', 'student'],
  ['write to her', 'student'],
  ['draft to the top 3', 'student'],
  ['ask Aisha', 'student'],
].map(([text, account], i) => ({
  id: `cold:${i}`,
  account: account as AccountId,
  area: 'follow-ups',
  variant: 'follow-up, cold',
  text: text!,
  expect: { cold: true } as Expect,
}));

/** Two asks in one message: the first one runs (and nothing is guessed about the second). */
const MULTI: Case[] = [
  ['show my pipeline and draft a follow up to Marcus', ['list_pipeline', 'create_draft']],
  ["what's on today, then who went quiet", ['get_today_brief', 'list_pipeline']],
  ['thank Tomás and add a note that he offered a referral', ['create_draft', 'add_note']],
  ['who do I know at Stripe and who should I meet', ['find_routes', 'list_recommendations']],
].map(([text, tools], i) => ({
  id: `multi:${i}`,
  account: 'student' as AccountId,
  area: 'multi-intent',
  variant: 'multi',
  text: text as string,
  expect: { tool: tools as string[] },
}));

export const CASES: Case[] = [...capabilityCases(), ...phrasedCases(), ...COLD, ...MULTI];

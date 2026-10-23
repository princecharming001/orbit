/**
 * The offline simulation runner: drives the REAL chat engine (router mode, no key) over the REAL registry and tools on
 * a seeded account, renders each result card the way the thread does, and checks every step: the intended tool ran
 * (or a clarifying question when the request is ambiguous), the card kind is right, nothing threw, no "I can't" for
 * something Orbit can do, nothing named that the account does not hold, the words stay short, every next-step chip
 * and tap-to-answer pill routes to something the router handles, and the data changed (or did not) as it should.
 */
import type { ChatStage } from '@orbit/core';
import { MESSAGE_KIND_LABELS, STAGE_LABELS } from '@orbit/core';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { db } from '../../../../db/schema';
import { createChatEngine } from '../../../agent';
import { NOT_FOLLOWED_LEAD, type RouterIntent, routeUtterance } from '../../../agent/router';
import { routerContextFor } from '../../../agent/routerContext';
import { CAPABILITIES } from '../../../capabilities';
import { execute, registry } from '../../../registry';
import type { ChatEngine, ResultEnvelope, ResultKind, TurnEvent } from '../../../types';
import { ResultCard } from '../../../ui/cards/ResultCard';
import { readChoices } from '../../../ui/cards/shapes';
import { NOW } from '../../helpers';
import {
  type AccountId,
  clearTouched,
  type DbSnapshot,
  restoreDb,
  seedAccount,
  snapshotDb,
  watchWrites,
} from './accounts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---- what a case or a thread step expects ---------------------------------------------------------------------------

export interface Expect {
  /** the tool that should run (any of these) */
  tool?: string | string[];
  /** the kind of the last card (any of these) */
  kind?: ResultKind | ResultKind[];
  /** a clarifying question is the right answer (a question in words, a row of choices, or a "which one" list) */
  ask?: boolean;
  /** a plain answer in words, with no tool, is the right answer */
  answer?: boolean;
  /** an honest "this needs a Claude key" is the right answer (a judgement call the router cannot make) */
  needsKey?: boolean;
  /** the words the student reads (the lead and the card) say this */
  says?: RegExp;
  notSays?: RegExp;
  /** a confirmation is waiting for Approve */
  pending?: boolean;
  /** after the step, an unsent draft to this person exists */
  draftFor?: string;
  /** after the step, this person's chat is at this stage */
  stage?: [string, ChatStage];
  /** after the step, the chat stages did not change */
  noMove?: boolean;
  noteAdded?: boolean;
  personAdded?: string;
  /** an error card is the right answer (a refusal the tool explains) */
  error?: boolean;
  /** a word budget for the lead and the card's own sentences (default per kind) */
  words?: number;
  /** a follow-up sent with nothing before it: a question back or a look-up, never a change */
  cold?: boolean;
}

export type Step =
  | { say: string; expect?: Expect }
  /** tap a next-step chip or a tap-to-answer pill on the last card: by position or by its label */
  | { tap: number | RegExp; expect?: Expect }
  | { approve: true; expect?: Expect }
  | { cancel: true; expect?: Expect };

export interface Case {
  id: string;
  account: AccountId;
  area: string;
  /** the capability the request comes from (capabilities.ts), for the per-capability pass rate */
  cap?: string;
  /** how it was phrased: as listed, casual, typo, terse, polite, multi, follow-up */
  variant?: string;
  text: string;
  expect: Expect;
}

export interface Thread {
  id: string;
  account: AccountId;
  area: string;
  title: string;
  steps: Step[];
}

// ---- what a step did ------------------------------------------------------------------------------------------------

export interface StepResult {
  student: string;
  tools: string[];
  kinds: ResultKind[];
  /** what the assistant said in words, before the card */
  lead: string;
  /** the last envelope's summary */
  summary: string;
  /** the text the card shows */
  card: string;
  /** rows the card draws (list items, person rows, paragraphs): a stand-in for its height */
  rows: number;
  /** next-step chips and tap-to-answer pills, as the message each one sends */
  chips: { label: string; message: string; routes: string }[];
  pending?: string;
  failures: string[];
  ms: number;
}

export interface CaseResult {
  id: string;
  account: AccountId;
  area: string;
  cap?: string;
  variant?: string;
  thread?: string;
  steps: StepResult[];
  pass: boolean;
}

const DASH = /[—–]/;
const CODE = /(^|[\s(])[a-z]+_[a-z_]+\b/;
/** words that mean the chat gave up on something it can do */
const REFUSAL =
  /needs a Claude key|I did not understand|cannot .{0,40} from the chat yet|out of step with its|is not something I can/i;
const KEY_REFUSAL = /needs a Claude key/i;

/** The most words the lead and the card's own sentences should take, by card kind. */
const WORD_BUDGET: Partial<Record<ResultKind | 'none', number>> = {
  none: 45,
  text: 55,
  choices: 40,
  setup: 40,
  needs_confirmation: 60,
  error: 45,
};
const DEFAULT_BUDGET = 45;
/** Rows a card may draw before it is too tall for the thread (a fold shows five per list). */
const ROW_BUDGET = 16;

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

// ---- the session ----------------------------------------------------------------------------------------------------

/** Words the app itself uses: never a made-up entity. */
const APP_WORDS =
  `Calendly Jordan Lee Figma Tom example Triage Available Connect Connected Saved Line Lines Unsent Started Opened Snoozed Facts Reset Label Link Local Outreach Person Cooldown Hours Cap Bumps Enabled Days Functions Industries Locations Roles Cycle Ambition Brief Channels Quiet Weekly Daily Max Tone Style Scheduling Learned Domain Graduation ${Object.values(STAGE_LABELS).join(' ')} ${Object.values(MESSAGE_KIND_LABELS).join(' ')} Preset Hidden Orbit Gmail Google LinkedIn Claude Anthropic Calendar Settings Drafts Draft Today Pipeline People Map Discover
Notes Note Profile Integrations Integration Goals Goal Writing Limits Data Privacy Approve Cancel Reach Inbox Outbox Send Sent
Open Show Hide Reasoning Write Thank Follow Check Congratulate Propose Reply Ask Find Add Prep Who Warm Weak Close Recent Questions
I I'm I'll I've You You're Your We Here There This That These Those Nothing Nobody Someone Everyone Anytime Okay Sure Great
Hey Hi Hello Good Morning Afternoon Evening Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March
April May June July August September October November December Jan Feb Mar Apr Jun Jul Aug Sep Sept Oct Nov Dec Mon Tue Wed
Thu Fri Sat Sun ET PT CT MT UTC AM PM Zoom Meet Mail Contacts Export Import CSV ZIP PDF Word URL OK Stage Stages Chat Chats
Coffee Card Cards Brief Strength Score Closeness Close Tie Ties Pick Skip Snooze Dismiss Undo Move Moved Moving First Message
Messages Bump Nudge Referral Intro Introduction Introductions Warm-up Warm Up Research Dossier Sources Memory Autonomy Level
Smart Quick New Next Last Not Now Yes No Done Later More Less All None Everything Some Any Each Both Top Plus Name Email Phone
Title Company Companies Role School University College Student Students Recruiter Recruiting Internship Internships Job Jobs
Product Manager Engineer Designer Analyst Associate Partner Founder Director Head Lead Senior Staff Principal Intern APM PM SWE
Software Engineering Design Data Science Investment Banking Consulting Operations Marketing Sales Research Researcher Professor
Domain Year Graduation Major Majors Timezone Degree City Michigan Cornell MIT Stanford Berkeley Harvard Yale NYU UCLA Ann Arbor Ithaca SF NYC USA US`.split(
    /\s+/,
  );

export interface Vocab {
  has: (word: string) => boolean;
}

/** Every word the account's own data holds, so a name in a reply can be traced to a row. */
async function buildVocab(userId: string): Promise<Set<string>> {
  const out = new Set<string>(APP_WORDS.map((w) => w.toLowerCase()));
  const add = (s?: string | null) => {
    if (!s) return;
    for (const w of s.split(/[^\p{L}\p{N}'&.-]+/u)) {
      const t = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
      if (t) {
        out.add(t);
        out.add(t.replace(/'s$/, ''));
      }
    }
  };
  const user = await db.users.get(userId);
  for (const v of Object.values(user ?? {})) if (typeof v === 'string') add(v);
  for (const p of await db.people.where('userId').equals(userId).toArray()) {
    add(p.displayName);
    add(p.currentOrganizationRaw);
    add(p.currentTitle);
    add(p.headline);
    add(p.location);
  }
  for (const o of await db.organizations.toArray()) add(JSON.stringify(o));
  for (const t of await db.targetCompanies.where('userId').equals(userId).toArray()) add(t.nameRaw);
  for (const n of await db.notes.toArray()) add(`${n.title ?? ''} ${n.rawText}`);
  for (const e of await db.events.toArray()) add(e.title);
  for (const f of await db.resumeFacets.toArray())
    add(`${f.title ?? ''} ${f.organizationName ?? ''} ${f.text}`);
  for (const g of await db.userGoals.toArray()) add(g.title);
  for (const g of await db.goals.toArray()) add(JSON.stringify(g));
  for (const m of await db.messages.toArray())
    add(`${m.subject ?? ''} ${m.fromName ?? ''} ${m.bodyText ?? ''}`);
  for (const o of await db.outbound.toArray())
    add(`${o.subject ?? ''} ${o.bodyDraft ?? ''} ${o.bodyFinal ?? ''}`);
  for (const d of await db.dossiers.toArray()) add(JSON.stringify(d));
  for (const r of await db.recommendations.toArray()) add(JSON.stringify(r));
  return out;
}

/** Capitalised words that are not the first word of a sentence and that the account does not hold. */
export function unknownNames(text: string, vocab: Set<string>, extra: string): string[] {
  const allowed = new Set(vocab);
  for (const w of extra.split(/[^\p{L}\p{N}'&.-]+/u)) {
    allowed.add(w.toLowerCase());
    allowed.add(w.toLowerCase().replace(/'s$/, ''));
  }
  // a word made from one the account holds ("Cornellian" from Cornell) is not new
  const stems = [...allowed].filter((w) => w.length >= 5);
  const known = (w: string) => allowed.has(w) || stems.some((s) => w.startsWith(s));
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.?!:;])\s+|\n+|\s[·|]\s/)) {
    const toks = sentence.split(/\s+/).filter(Boolean);
    toks.forEach((raw, i) => {
      if (i === 0) return;
      // a word the card cut short ("Softwa…") is part of a known one
      if (/(…|\.\.\.)$/.test(raw)) return;
      const w = raw.replace(/^[^\p{L}]+|[^\p{L}\p{N}]+$/gu, '').replace(/'s$/, '');
      if (!/^\p{Lu}[\p{Ll}]/u.test(w)) return;
      if (known(w.toLowerCase())) return;
      out.push(w);
    });
  }
  return [...new Set(out)];
}

interface State {
  sentOut: number;
  stages: Map<string, ChatStage>;
  drafts: Map<string, number>;
  notes: number;
  people: Set<string>;
  /** each person's name, company and title, so a person a step adds joins the words the account holds */
  words: Map<string, string>;
}

async function stateOf(userId: string): Promise<State> {
  const [out, chats, notes, people] = await Promise.all([
    db.outbound.where('userId').equals(userId).toArray(),
    db.chats.where('userId').equals(userId).toArray(),
    db.notes.where('userId').equals(userId).count(),
    db.people.where('userId').equals(userId).toArray(),
  ]);
  const drafts = new Map<string, number>();
  for (const o of out) if (o.status === 'draft') drafts.set(o.personId, (drafts.get(o.personId) ?? 0) + 1);
  return {
    sentOut: out.filter((o) => ['sent', 'queued', 'scheduled', 'sending'].includes(o.status as string))
      .length,
    stages: new Map(chats.map((c) => [c.personId, c.stage])),
    drafts,
    notes,
    people: new Set(people.filter((p) => !p.hiddenAt).map((p) => p.displayName)),
    words: new Map(
      people.map((p) => [
        p.displayName,
        `${p.displayName} ${p.currentOrganizationRaw ?? ''} ${p.currentTitle ?? ''}`,
      ]),
    ),
  };
}

/** A tool that writes or asks to write: the state is dirty after it (or after any approve). */
const WRITES = new Set([...registry.values()].filter((t) => t.kind !== 'read').map((t) => t.name));

export class Session {
  engine!: ChatEngine;
  userId = '';
  private snap?: DbSnapshot;
  private vocab = new Set<string>();
  private peopleIds = new Map<string, string>();

  /** `configure` runs once the account is seeded: the Claude-mode suite points the chat at Claude there. */
  constructor(
    readonly account: AccountId,
    private readonly configure?: () => void | Promise<void>,
  ) {}

  async open(): Promise<void> {
    watchWrites();
    const user = await seedAccount(this.account);
    await this.configure?.();
    this.userId = user.id;
    this.engine = createChatEngine({ registry, execute, user: () => user, now: () => NOW });
    this.snap = await snapshotDb();
    clearTouched();
    this.vocab = await buildVocab(user.id);
    for (const p of await db.people.where('userId').equals(user.id).toArray())
      this.peopleIds.set(p.displayName, p.id);
  }

  /** Put the tables the last run wrote back as they were seeded. */
  async reset(): Promise<void> {
    if (this.snap) await restoreDb(this.snap);
  }

  private idOf(name: string): string | undefined {
    if (this.peopleIds.has(name)) return this.peopleIds.get(name);
    const hit = [...this.peopleIds.entries()].find(([n]) => n.toLowerCase().startsWith(name.toLowerCase()));
    return hit?.[1];
  }

  async runCase(c: Case): Promise<CaseResult> {
    await this.reset();
    const conv = await this.engine.startConversation({ temporary: false });
    const r = await this.step(conv.id, { say: c.text, expect: c.expect }, undefined);
    return {
      id: c.id,
      account: c.account,
      area: c.area,
      cap: c.cap,
      variant: c.variant,
      steps: [r.result],
      pass: r.result.failures.length === 0,
    };
  }

  async runThread(t: Thread): Promise<CaseResult> {
    await this.reset();
    const conv = await this.engine.startConversation({ temporary: false });
    const steps: StepResult[] = [];
    let last: Last | undefined;
    for (const s of t.steps) {
      const r = await this.step(conv.id, s, last);
      steps.push(r.result);
      last = r.last;
    }
    return {
      id: t.id,
      account: t.account,
      area: t.area,
      thread: t.title,
      steps,
      pass: steps.every((s) => s.failures.length === 0),
    };
  }

  private async step(
    conversationId: string,
    s: Step,
    last: Last | undefined,
  ): Promise<{ result: StepResult; last: Last }> {
    const t0 = Date.now();
    const before = await stateOf(this.userId);
    const events: TurnEvent[] = [];
    const failures: string[] = [];
    let student: string;
    let approved = false;
    if ('say' in s) {
      student = s.say;
      await this.engine.send(conversationId, s.say, (e) => events.push(e));
    } else if ('tap' in s) {
      const chip =
        typeof s.tap === 'number'
          ? last?.chips[s.tap]
          : last?.chips.find((c) => (s.tap as RegExp).test(c.label) || (s.tap as RegExp).test(c.message));
      if (!chip) {
        failures.push(
          `tap: no chip ${String(s.tap)} on the last card (had: ${last?.chips.map((c) => c.label).join(' | ') || 'none'})`,
        );
        student = `(tap ${String(s.tap)})`;
      } else {
        student = `(tap "${chip.label}") ${chip.message}`;
        await this.engine.send(conversationId, chip.message, (e) => events.push(e));
      }
    } else if ('approve' in s) {
      student = '(Approve)';
      approved = true;
      if (!last?.pending) failures.push('approve: nothing was waiting for approval');
      else {
        const env = await this.engine.approve(last.pending);
        events.push({ type: 'tool_start', toolUseId: last.pending, toolName: '(approve)' });
        events.push({ type: 'tool_result', toolUseId: last.pending, envelope: env });
        events.push({ type: 'done', stopReason: 'end_turn', messageId: last.pending });
      }
    } else {
      student = '(Cancel)';
      if (!last?.pending) failures.push('cancel: nothing was waiting for approval');
      else await this.engine.cancel(last.pending);
      events.push({ type: 'done', stopReason: 'end_turn', messageId: 'cancel' });
    }

    const tools = events.flatMap((e) => (e.type === 'tool_start' ? [e.toolName] : []));
    const envs = events.flatMap((e) => (e.type === 'tool_result' ? [e.envelope] : []));
    const env = envs.at(-1);
    const lead = events
      .flatMap((e) => (e.type === 'text' ? [e.delta] : []))
      .join('')
      .trim();

    const rendered = env ? await renderCard(tools.at(-1) ?? '?', env) : { text: '', rows: 0, chips: [] };
    // where each chip's words go: the same inputs the engine gives the router, read once from the database
    const chips: StepResult['chips'] = [];
    if (rendered.chips.length) {
      const ctx = await routerContextFor(this.userId, NOW);
      for (const c of rendered.chips)
        chips.push({ ...c, routes: describe(routeUtterance(c.message, { registry, ...ctx })) });
    }
    const pending = env?.kind === 'needs_confirmation' && env.confirmationId ? env.confirmationId : undefined;
    const after = await stateOf(this.userId);

    // ---- checks every step gets ----
    const ex = s.expect ?? {};
    const err = events.find((e) => e.type === 'error') as Extract<TurnEvent, { type: 'error' }> | undefined;
    if (err) failures.push(`error event: ${err.kind}: ${err.message}`);
    // what the chat learned from the turn ("Noted for later") arrives after its end, never holding up the reply
    if (!events.some((e) => e.type === 'done') && !failures.length) failures.push('the turn did not finish');
    const errorCard = envs.find((e) => e.kind === 'error');
    if (errorCard && !ex.error) failures.push(`error card: ${errorCard.summary}`);
    if (ex.error && !errorCard) failures.push('expected an error card');

    const said =
      env?.summary && !lead.includes(env.summary.trim())
        ? `${lead} ${env.summary}`
        : lead || env?.summary || '';
    const shown = `${lead}\n${rendered.text}`;
    const isQuestion =
      /\?/.test(lead || env?.summary || '') ||
      env?.kind === 'choices' ||
      (tools.at(-1) === 'search_people' && /pick|which|more than one/i.test(said));
    // "I'm not sure what you mean" with a row of guesses is a dead end dressed as a question: it never counts as one
    if (NOT_FOLLOWED_LEAD.test(lead) && !ex.cold) failures.push(`not understood: "${student}"`);
    if (REFUSAL.test(said) && !ex.needsKey)
      failures.push(`refused: "${said.replace(/\s+/g, ' ').slice(0, 140)}"`);
    if (ex.needsKey && !KEY_REFUSAL.test(said) && !(ex.tool || ex.answer || ex.ask))
      failures.push(`expected an honest "needs a Claude key", got: ${said.slice(0, 120)}`);

    const wanted = ex.tool ? (Array.isArray(ex.tool) ? ex.tool : [ex.tool]) : undefined;
    const ran = tools.filter((n) => n !== '(approve)');
    if (wanted) {
      const ok = ran.some((n) => wanted.includes(n));
      const okAsk = ex.ask && isQuestion;
      const okKey = ex.needsKey && KEY_REFUSAL.test(said);
      const okAnswer = ex.answer && !ran.length && !REFUSAL.test(said);
      if (!ok && !okAsk && !okKey && !okAnswer)
        failures.push(
          `wrong tool: wanted ${wanted.join('/')}, ran ${ran.join(', ') || 'none'} (${said.replace(/\s+/g, ' ').slice(0, 100)})`,
        );
    } else if (
      ex.answer &&
      ran.length &&
      !ex.ask &&
      !['offer_choices', 'show_setup', 'open_page', 'explain_stage'].includes(ran[0]!)
    )
      failures.push(`expected a plain answer, ran ${ran.join(', ')}`);
    else if (ex.ask && !wanted && !isQuestion)
      failures.push(`expected a question back, got: ${said.slice(0, 120)}`);
    if (ex.cold) {
      const wrote = ran.filter((n) => WRITES.has(n) && n !== 'offer_choices' && n !== 'show_setup');
      if (wrote.length)
        failures.push(`a follow-up with nothing before it changed something: ${wrote.join(', ')}`);
      else if (!isQuestion && !ran.length)
        failures.push(`expected a question back, got: ${said.slice(0, 120)}`);
    }
    if (ex.kind && env) {
      const kinds = Array.isArray(ex.kind) ? ex.kind : [ex.kind];
      if (!kinds.includes(env.kind) && !(ex.ask && isQuestion))
        failures.push(`wrong card: wanted ${kinds.join('/')}, got ${env.kind}`);
    }
    if (ex.says && !ex.says.test(shown))
      failures.push(`does not say ${ex.says}: ${shown.replace(/\s+/g, ' ').slice(0, 140)}`);
    if (ex.notSays?.test(shown)) failures.push(`says ${ex.notSays}`);
    if (ex.pending && !pending) failures.push('expected a confirmation waiting for Approve');

    // words: no dashes, no shouting, no internal codes, and short
    if (DASH.test(said)) failures.push('a dash in the reply');
    if (/!/.test(said)) failures.push('an exclamation mark in the reply');
    if (CODE.test(said)) failures.push(`an internal code in the reply: ${said.match(CODE)?.[0]}`);
    const budget = ex.words ?? WORD_BUDGET[env?.kind ?? 'none'] ?? DEFAULT_BUDGET;
    // what the student reads in words: a plain answer's text, or the lead and the card's first line (a text card
    // with its own words, like the warm-up choice, shows those instead of the summary written for the model)
    const prose = !env
      ? said
      : env.kind === 'text'
        ? `${lead} ${rendered.text || env.summary}`
        : `${lead} ${firstSentence(env.summary)}`;
    if (words(prose) > budget) failures.push(`too long: ${words(prose)} words (budget ${budget})`);
    if (rendered.rows > ROW_BUDGET) failures.push(`card too tall: ${rendered.rows} rows`);

    // nothing named that the account does not hold
    // what the tools returned counts as a source: a name there was not made up by the reply
    // (only a tool's result: a plain answer's envelope carries the reply itself)
    const started = new Set(events.flatMap((e) => (e.type === 'tool_start' ? [e.toolUseId] : [])));
    const sources = events
      .flatMap((e) =>
        e.type === 'tool_result' && started.has(e.toolUseId) ? [JSON.stringify(e.envelope.data ?? '')] : [],
      )
      .join(' ');
    const unknown = unknownNames(shown, this.vocab, `${student} ${sources}`);
    if (unknown.length) failures.push(`names not in the data: ${unknown.join(', ')}`);

    // every chip goes somewhere the router handles
    for (const c of chips)
      if (/^(refuse|text:nobody|text:out-of-step)/.test(c.routes))
        failures.push(`chip "${c.label}" (${c.message}) routes to ${c.routes}`);

    // nothing sent without an approval; stages move only when asked
    if (after.sentOut > before.sentOut && !approved) failures.push('something was sent without an approval');
    const moved = [...after.stages].filter(([id, st]) => before.stages.get(id) !== st);
    if (ex.noMove && moved.length)
      failures.push(`a chat moved: ${moved.map(([id, st]) => `${id}->${st}`).join(', ')}`);
    if (ex.draftFor) {
      const id = this.idOf(ex.draftFor);
      if (!id || !(after.drafts.get(id) ?? 0)) failures.push(`no draft to ${ex.draftFor}`);
    }
    if (ex.stage) {
      const id = this.idOf(ex.stage[0]);
      if (!id || after.stages.get(id) !== ex.stage[1])
        failures.push(
          `${ex.stage[0]} is at ${id ? (after.stages.get(id) ?? 'no chat') : 'unknown person'}, not ${ex.stage[1]}`,
        );
    }
    if (ex.noteAdded && after.notes <= before.notes) failures.push('no note was saved');
    if (
      ex.personAdded &&
      ![...after.people].some((n) => n.toLowerCase().includes(ex.personAdded!.toLowerCase()))
    )
      failures.push(`${ex.personAdded} was not added`);
    // a new person the step added joins the names the account holds
    for (const [n, words] of after.words)
      if (!before.words.has(n)) for (const w of words.split(/\s+/)) if (w) this.vocab.add(w.toLowerCase());

    const result: StepResult = {
      student,
      tools: ran,
      kinds: envs.map((e) => e.kind),
      lead,
      summary: env?.summary ?? '',
      card: rendered.text,
      rows: rendered.rows,
      chips,
      pending,
      failures,
      ms: Date.now() - t0,
    };
    return { result, last: { chips: rendered.chips, pending } };
  }
}

interface Last {
  chips: { label: string; message: string }[];
  pending?: string;
}

function firstSentence(s: string): string {
  const m = s.match(/^.*?[.?!](?=\s|$)/);
  return m ? m[0] : s;
}

/** Where an utterance goes, in a few words: "tool:create_draft", "text:...", "refuse". */
function describe(i: RouterIntent): string {
  if (i.kind === 'tool') return `tool:${i.tool}`;
  if (i.kind === 'refuse') return /out of step/.test(i.text) ? 'text:out-of-step' : 'refuse';
  if (/could not find anyone called/.test(i.text)) return 'text:nobody';
  return `text:${i.text.slice(0, 40)}`;
}

/** Render a card the way the thread does and read what it shows: its text, its rows and its next steps. */
async function renderCard(
  toolName: string,
  env: ResultEnvelope,
): Promise<{ text: string; rows: number; chips: { label: string; message: string }[] }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const block = {
    type: 'tool' as const,
    toolUseId: 'sim',
    toolName,
    envelope: env,
    status: env.kind === 'needs_confirmation' ? ('pending' as const) : ('done' as const),
  };
  try {
    await act(async () => {
      root.render(
        createElement(
          MemoryRouter,
          null,
          createElement(ResultCard, {
            block,
            actions: { approve: async () => undefined, cancel: async () => {}, send: () => {} },
          }),
        ),
      );
    });
    // live queries (a draft's text) settle on the next ticks
    for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
    const chips = [...host.querySelectorAll<HTMLElement>('[data-testid="next-step"]')].map((b) => ({
      label: (b.textContent ?? '').trim(),
      message: b.getAttribute('title') ?? '',
    }));
    if (env.kind === 'choices')
      for (const o of readChoices(env.data)) chips.push({ label: o.label, message: o.message });
    // a stand-in for height (jsdom has no layout): the header, each list item, paragraph and person row, a
    // textarea's lines, and the row of next steps
    const rows =
      1 +
      host.querySelectorAll('li, p, h3, tr, [data-testid$="-row"], div.flex.items-center.min-w-0.gap-2\\.5')
        .length +
      [...host.querySelectorAll('textarea')].reduce((n, t) => n + Math.ceil((t.value.length || 1) / 80), 0) +
      (host.querySelector('[data-testid="next-steps"]') ? 1 : 0);
    const text = [...host.querySelectorAll<HTMLElement>('*')]
      .filter((el) => el.children.length === 0 && el.textContent?.trim())
      .map((el) => el.textContent!.trim())
      .concat([...host.querySelectorAll('textarea')].map((t) => t.value))
      .join('\n');
    return { text, rows, chips };
  } finally {
    act(() => root.unmount());
    host.remove();
  }
}

/** Capability ids whose example requests the suite runs, with the tools that claim each. */
export function capabilityTools(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of CAPABILITIES) out.set(c.id, []);
  for (const t of registry.values()) for (const id of t.capabilities) out.get(id)?.push(t.name);
  return out;
}

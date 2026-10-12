/**
 * What each result kind's `data` is expected to hold. The tool registry is built apart from the UI, so every reader
 * here is lenient: it takes the documented shape, or the bare domain object when there is only one, and never throws.
 * Unknown fields are ignored. A card with nothing it can read falls back to the envelope's summary.
 */
import type {
  CoffeeChat,
  MeetingNote,
  Organization,
  OutboundMessage,
  Person,
  PersonFact,
  ReachPath,
  Suggestion,
} from '@orbit/core';

const obj = (d: unknown): Record<string, unknown> =>
  d && typeof d === 'object' ? (d as Record<string, unknown>) : {};
const isPerson = (x: unknown): x is Person =>
  !!x && typeof x === 'object' && typeof (x as Person).displayName === 'string';
const isDraft = (x: unknown): x is OutboundMessage =>
  !!x && typeof x === 'object' && typeof (x as OutboundMessage).bodyDraft === 'string';
const list = <T>(x: unknown, ok: (v: unknown) => v is T): T[] => (Array.isArray(x) ? x.filter(ok) : []);
const present = <T>(x: T | undefined): x is T => x !== undefined;
const strings = (x: unknown): string[] =>
  Array.isArray(x)
    ? x
        .map((v) => (typeof v === 'string' ? v : obj(v).text))
        .filter((v): v is string => typeof v === 'string')
    : [];

/** person: `{ person, chat?, facts?, lastContactAt? }` or a bare Person */
export function readPerson(d: unknown): { person: Person; chat?: CoffeeChat; facts: string[] } | undefined {
  const o = obj(d);
  const person = isPerson(o.person) ? o.person : isPerson(d) ? d : undefined;
  if (!person) return undefined;
  return { person, chat: o.chat as CoffeeChat | undefined, facts: strings(o.facts) };
}

/** people: `{ people: (Person | { person, why? })[] }` or a bare array */
export function readPeople(d: unknown): { person: Person; why?: string }[] {
  const raw = Array.isArray(d) ? d : obj(d).people;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) =>
      isPerson(x)
        ? { person: x }
        : isPerson(obj(x).person)
          ? { person: obj(x).person as Person, why: obj(x).why as string | undefined }
          : undefined,
    )
    .filter((x): x is { person: Person; why?: string } => !!x);
}

/** draft: `{ draft, person? }` or a bare OutboundMessage */
export function readDraft(d: unknown): { draft: OutboundMessage; person?: Person } | undefined {
  const o = obj(d);
  const draft = isDraft(o.draft) ? o.draft : isDraft(d) ? d : undefined;
  if (!draft) return undefined;
  return { draft, person: isPerson(o.person) ? o.person : undefined };
}

/** drafts: `{ drafts: (OutboundMessage | { draft, person? })[] }` or a bare array */
export function readDrafts(d: unknown): { draft: OutboundMessage; person?: Person }[] {
  const raw = Array.isArray(d) ? d : obj(d).drafts;
  if (!Array.isArray(raw)) return [];
  return raw.map(readDraft).filter((x): x is { draft: OutboundMessage; person?: Person } => !!x);
}

/** pipeline: `{ items: { chat, person, nextStep? }[], counts?: Record<stage, number> }` */
export interface PipelineItem {
  chat?: CoffeeChat;
  person: Person;
  nextStep?: string;
}
export function readPipeline(d: unknown): { items: PipelineItem[]; counts: Record<string, number> } {
  const o = obj(d);
  const raw = Array.isArray(d) ? d : o.items;
  const items = (Array.isArray(raw) ? raw : [])
    .map((x): PipelineItem | undefined => {
      const r = obj(x);
      const person = isPerson(r.person) ? r.person : undefined;
      return person
        ? { chat: r.chat as CoffeeChat | undefined, person, nextStep: r.nextStep as string | undefined }
        : undefined;
    })
    .filter(present);
  const counts = Object.fromEntries(
    Object.entries(obj(o.counts)).filter(([, v]) => typeof v === 'number'),
  ) as Record<string, number>;
  return { items, counts };
}

/** routes: `{ to: Person, routes: ReachPath[], people?: Record<id, Person> }` */
export function readRoutes(d: unknown): { to?: Person; routes: ReachPath[]; people: Record<string, Person> } {
  const o = obj(d);
  const routes = list(o.routes, (x): x is ReachPath => Array.isArray(obj(x).hops));
  const people = Object.fromEntries(Object.entries(obj(o.people)).filter(([, v]) => isPerson(v))) as Record<
    string,
    Person
  >;
  const to = isPerson(o.to) ? o.to : undefined;
  if (to) people[to.id] = to;
  return { to, routes, people };
}

/** brief: `{ suggestions: Suggestion[], summary? }`; suggestion: `{ suggestion }` or a bare Suggestion */
const isSuggestion = (x: unknown): x is Suggestion =>
  !!x && typeof x === 'object' && typeof (x as Suggestion).reasonText === 'string';
export function readSuggestions(d: unknown): Suggestion[] {
  const o = obj(d);
  if (isSuggestion(d)) return [d];
  if (isSuggestion(o.suggestion)) return [o.suggestion];
  return list(Array.isArray(d) ? d : o.suggestions, isSuggestion);
}

/** note: `{ note, person?, facts? }` */
export function readNote(d: unknown): {
  note?: MeetingNote;
  person?: Person;
  facts: string[];
  summary?: string;
} {
  const o = obj(d);
  const note = obj(o.note).rawText !== undefined ? (o.note as MeetingNote) : undefined;
  return {
    note,
    person: isPerson(o.person) ? o.person : undefined,
    facts: strings(o.facts),
    summary: typeof o.summary === 'string' ? o.summary : note?.summary,
  };
}

/** facts: `{ person?, facts: (PersonFact | string)[] }` */
export interface FactItem {
  text: string;
  type?: string;
}
export function readFacts(d: unknown): { person?: Person; facts: FactItem[] } {
  const o = obj(d);
  const raw = Array.isArray(d) ? d : o.facts;
  const facts = (Array.isArray(raw) ? raw : [])
    .map((f): FactItem | undefined =>
      typeof f === 'string'
        ? { text: f }
        : typeof obj(f).text === 'string'
          ? { text: (f as PersonFact).text, type: (f as PersonFact).type }
          : undefined,
    )
    .filter(present);
  return { person: isPerson(o.person) ? o.person : undefined, facts };
}

/** company: `{ organization: Organization | { name }, people?: Person[], target?: boolean }` */
export function readCompany(d: unknown): {
  name?: string;
  industry?: string;
  people: Person[];
  target?: boolean;
} {
  const o = obj(d);
  const org = obj(o.organization ?? o.company) as Partial<Organization>;
  return {
    name: typeof org.name === 'string' ? org.name : typeof o.name === 'string' ? o.name : undefined,
    industry: typeof org.industry === 'string' ? org.industry : undefined,
    people: list(o.people, isPerson),
    target: typeof o.target === 'boolean' ? o.target : undefined,
  };
}

/** settings: `{ section?, changes: { label, from?, to }[] }` */
export interface SettingChange {
  label: string;
  from?: string;
  to: string;
}
export function readSettings(d: unknown): SettingChange[] {
  const raw = Array.isArray(d) ? d : obj(d).changes;
  return (Array.isArray(raw) ? raw : [])
    .map((c): SettingChange | undefined => {
      const r = obj(c);
      return typeof r.label === 'string'
        ? { label: r.label, from: r.from === undefined ? undefined : String(r.from), to: String(r.to ?? '') }
        : undefined;
    })
    .filter(present);
}

/** import: `{ source?, counts: Record<string, number> | { label, value }[] }` */
export function readImport(d: unknown): { source?: string; counts: { label: string; value: number }[] } {
  const o = obj(d);
  const raw = o.counts;
  const counts = Array.isArray(raw)
    ? raw
        .map((c) => obj(c))
        .filter((c) => typeof c.label === 'string' && typeof c.value === 'number')
        .map((c) => ({ label: c.label as string, value: c.value as number }))
    : Object.entries(obj(raw))
        .filter(([, v]) => typeof v === 'number')
        .map(([k, v]) => ({ label: k.replace(/_/g, ' '), value: v as number }));
  return { source: typeof o.source === 'string' ? o.source : undefined, counts };
}

/** prep: `{ person, when?, summary?, questions?, facts? }` */
export function readPrep(d: unknown): {
  person?: Person;
  when?: string;
  summary?: string;
  questions: string[];
  facts: string[];
} {
  const o = obj(d);
  return {
    person: isPerson(o.person) ? o.person : undefined,
    when: typeof o.when === 'string' ? o.when : undefined,
    summary: typeof o.summary === 'string' ? o.summary : undefined,
    questions: strings(o.questions),
    facts: strings(o.facts),
  };
}

/** needs_confirmation: `{ toolName?, text?, blockedReason?, draft?, person? }` */
export function readConfirm(d: unknown): {
  toolName?: string;
  text?: string;
  blockedReason?: string;
  draft?: OutboundMessage;
  person?: Person;
} {
  const o = obj(d);
  return {
    toolName: typeof o.toolName === 'string' ? o.toolName : undefined,
    text: typeof o.text === 'string' ? o.text : undefined,
    blockedReason: typeof o.blockedReason === 'string' ? o.blockedReason : undefined,
    draft: isDraft(o.draft) ? o.draft : undefined,
    person: isPerson(o.person) ? o.person : undefined,
  };
}

/** error: `{ message? }` */
export function readError(d: unknown): string | undefined {
  const m = obj(d).message;
  return typeof m === 'string' ? m : undefined;
}

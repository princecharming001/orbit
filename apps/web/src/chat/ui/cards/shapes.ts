/**
 * What each result kind's `data` is expected to hold. The registry's tools return `{ ui, forModel }`: `ui` holds
 * compact references (a person as `{ id, name, title, company }`, a draft as `{ id, person, status, firstLine }`, a
 * card as `{ id, kind, reason }`) and, where a page needs it, the domain object itself. The scripted engine of the UI
 * tests hands bare domain objects. Every reader here takes either, ignores fields it does not know and never throws;
 * a card with nothing it can read falls back to the envelope's summary.
 */

import type {
  CoffeeChat,
  MeetingNote,
  Organization,
  OutboundMessage,
  Person,
  PersonFact,
  Suggestion,
} from '@orbit/core';
import type { SetupStatus } from '../../setupStatus';
import type { ChoiceOption, SetupWhat } from '../../types';

const obj = (d: unknown): Record<string, unknown> =>
  d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
const str = (x: unknown): string | undefined => (typeof x === 'string' && x.trim() ? x : undefined);
const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
const isPerson = (x: unknown): x is Person =>
  !!x && typeof x === 'object' && typeof (x as Person).displayName === 'string';
const isDraft = (x: unknown): x is OutboundMessage =>
  !!x && typeof x === 'object' && typeof (x as OutboundMessage).bodyDraft === 'string';
const isSuggestion = (x: unknown): x is Suggestion =>
  !!x && typeof x === 'object' && typeof (x as Suggestion).reasonText === 'string';
const present = <T>(x: T | undefined): x is T => x !== undefined;
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const strings = (x: unknown): string[] =>
  arr(x)
    .map((v) => (typeof v === 'string' ? v : str(obj(v).text)))
    .filter((v): v is string => typeof v === 'string');

// ---------- unpacking ----------

/** Third-party text reaches the model inside `<untrusted_…>` elements; the student sees the text alone. */
const UNTRUSTED = /<\/?untrusted_[A-Za-z0-9]+(?:\s[^>]*)?>\n?/g;
export function unwrapText(s: string): string {
  return s.includes('<untrusted_') ? s.replace(UNTRUSTED, '').replace(/\n+$/, '').trim() : s;
}
function clean(x: unknown, depth = 0): unknown {
  if (typeof x === 'string') return unwrapText(x);
  if (depth > 6 || !x || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.map((v) => clean(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x)) out[k] = clean(v, depth + 1);
  return out;
}

/** The UI half of a tool's data (`ui` of `{ ui, forModel }`), or the data itself, with untrusted wrappers removed. */
export function unpack(d: unknown): unknown {
  const o = obj(d);
  return clean('ui' in o && 'forModel' in o ? o.ui : d);
}

/** A person from a domain row or a compact reference `{ id, name, title?, company?, closeness? }`. */
export function personOf(x: unknown): Person | undefined {
  if (isPerson(x)) return x;
  const o = obj(x);
  const id = str(o.id) ?? str(o.personId);
  const name = str(o.name) ?? (typeof o.person === 'string' ? str(o.person) : undefined);
  if (!id || !name) return undefined;
  const [first, ...rest] = name.split(' ');
  return {
    id,
    displayName: name,
    firstName: first ?? name,
    lastName: rest.join(' '),
    currentTitle: str(o.title),
    currentOrganizationRaw: str(o.company),
    strength: num(o.closeness) ?? 0,
  } as unknown as Person;
}

// ---------- readers ----------

/** person: `{ person, chat?, facts? }`, a get_person view, or a bare Person */
export function readPerson(d: unknown):
  | {
      person: Person;
      chat?: CoffeeChat;
      facts: string[];
      lastTouch?: string;
      stageLabel?: string;
      questions: string[];
      summary?: string;
    }
  | undefined {
  const o = obj(unpack(d));
  const person = personOf(o.person) ?? personOf(o);
  if (!person) return undefined;
  const chat = str(obj(o.chat).stage) ? (o.chat as CoffeeChat) : undefined;
  const prep = obj(o.prep);
  return {
    person,
    chat,
    facts: strings(o.facts),
    lastTouch: str(o.lastTouch),
    stageLabel: str(o.stage),
    questions: strings(prep.questions).slice(0, 5),
    summary: str(o.summary),
  };
}

/** people: `{ people | recommendations | candidates }` of Person, `{ person, why }` or references; or a bare array */
export function readPeople(d: unknown): { person: Person; why?: string }[] {
  const u = unpack(d);
  const o = obj(u);
  const raw = Array.isArray(u) ? u : (o.people ?? o.recommendations ?? o.candidates ?? o.thereNow);
  return arr(raw)
    .map((x) => {
      const r = obj(x);
      const person = personOf(r.person) ?? personOf(x);
      if (!person) return undefined;
      const why =
        str(r.why) ??
        (strings(r.reasons).length ? strings(r.reasons).slice(0, 2).join('. ') : undefined) ??
        (str(r.stage) ? `Chat: ${r.stage}` : undefined);
      return { person, why };
    })
    .filter(present);
}

/** draft: `{ draft, person? }`, a draft reference `{ id, person, firstLine }`, or a bare OutboundMessage */
export function readDraft(
  d: unknown,
): { draft?: OutboundMessage; draftId: string; person?: Person; personName?: string } | undefined {
  const o = obj(unpack(d));
  const draft = isDraft(o.draft) ? o.draft : isDraft(o) ? (o as unknown as OutboundMessage) : undefined;
  const draftId = draft?.id ?? (str(o.kindLabel) || str(o.body) ? str(o.id) : undefined);
  if (!draftId) return undefined;
  const person = isPerson(o.person) ? o.person : undefined;
  return { draft, draftId, person, personName: person?.displayName ?? str(o.person) };
}

export interface DraftRow {
  id: string;
  personName?: string;
  status?: string;
  kindLabel?: string;
  text?: string;
}

function draftRow(x: unknown): DraftRow | undefined {
  const r = obj(x);
  if (isDraft(r.draft))
    return {
      id: r.draft.id,
      personName: isPerson(r.person) ? r.person.displayName : (r.draft.toEmail ?? undefined),
      status: r.draft.status,
      text: r.draft.bodyFinal ?? r.draft.bodyDraft,
    };
  if (isDraft(x))
    return { id: x.id, personName: x.toEmail, status: x.status, text: x.bodyFinal ?? x.bodyDraft };
  // a card row `{ card, draft? }`: the draft when the card has one
  const ref = r.card || r.draft ? obj(r.draft ?? {}) : r;
  const card = obj(r.card);
  const id = str(ref.id);
  if (!id) return undefined;
  return {
    id,
    personName: str(ref.person) ?? str(card.person),
    status: str(ref.status),
    kindLabel: str(ref.kindLabel) ?? str(card.kindLabel),
    text: str(ref.firstLine) ?? str(card.reason),
  };
}

/** drafts: `{ drafts }`, list_drafts sections (`toSend`, `started`, `opened`, ...), or `{ cards: { card, draft }[] }` */
export function readDrafts(d: unknown): DraftRow[] {
  const u = unpack(d);
  const o = obj(u);
  const raw = Array.isArray(u)
    ? u
    : [
        ...arr(o.drafts),
        ...arr(o.cards),
        ...arr(o.toSend),
        ...arr(o.started),
        ...arr(o.opened),
        ...arr(o.canWait),
        ...arr(o.snoozed),
        ...arr(o.sent),
      ];
  const seen = new Set<string>();
  return raw
    .map(draftRow)
    .filter(present)
    .filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
}

/** pipeline: `{ items: { chat, person, nextStep? }[] }`, list_pipeline `{ rows, counts }`, or one moved `{ chat, person }` */
export interface PipelineItem {
  person: Person;
  stage?: string;
  stageLabel?: string;
  nextStep?: string;
}
export function readPipeline(d: unknown): { items: PipelineItem[]; counts: Record<string, number> } {
  const u = unpack(d);
  const o = obj(u);
  const raw = Array.isArray(u) ? u : (o.items ?? o.rows ?? (o.person ? [o] : []));
  const items = arr(raw)
    .map((x): PipelineItem | undefined => {
      const r = obj(x);
      const person = personOf(r.person) ?? personOf({ ...r, id: r.personId, name: r.person });
      if (!person) return undefined;
      const chat = obj(r.chat);
      const next = obj(r.nextCard);
      return {
        person,
        stage: str(chat.stage) ?? str(r.stage),
        stageLabel: str(chat.stageLabel) ?? str(r.stageLabel),
        nextStep:
          str(r.nextStep) ??
          (str(r.when) ? `Meeting ${r.when}` : undefined) ??
          (str(r.meetingAt) ? `Meeting ${r.meetingAt}` : undefined) ??
          str(next.kindLabel),
      };
    })
    .filter(present);
  const counts = Object.fromEntries(
    Object.entries(obj(o.counts)).filter(([, v]) => typeof v === 'number' && v > 0),
  ) as Record<string, number>;
  return { items, counts };
}

/** routes: `{ to | target, routes }` with hops as ReachPath or `{ to, toId, how }`; intro chains as `{ stories }` */
export interface RouteView {
  band?: string;
  bandLabel?: string;
  score: number;
  names: string[];
  text: string[];
}
export interface WarmIntro {
  introducer: string;
  headline?: string;
  /** the Orbit person who would introduce, when known */
  introducerId?: string;
  warmth: number;
  /** warmth in a word ("warm", "good", "a stretch") */
  warmthWord: string;
  hops: string[];
  note?: string;
}

/** Warmth as a word when the tool did not give one. */
function warmthWordOf(w: number): string {
  return w >= 0.7 ? 'warm' : w >= 0.45 ? 'good' : 'a stretch';
}

/** warm intros: `{ warmIntros: [{ introducer: { name, headline?, personId? }, warmth, warmthWord?, hops, note? }] }` */
export function readWarmIntros(d: unknown): WarmIntro[] {
  const o = obj(unpack(d));
  return arr(o.warmIntros)
    .map((x): WarmIntro | undefined => {
      const w = obj(x);
      const intro = obj(w.introducer);
      const name = str(intro.name);
      if (!name) return undefined;
      const warmth = num(w.warmth) ?? 0;
      return {
        introducer: name,
        headline: str(intro.headline),
        introducerId: str(intro.personId),
        warmth,
        warmthWord: str(w.warmthWord) ?? warmthWordOf(warmth),
        hops: arr(w.hops)
          .map((h) => str(h) ?? '')
          .filter(present),
        note: str(w.note),
      };
    })
    .filter(present);
}

export function readRoutes(d: unknown): {
  to?: Person;
  routes: RouteView[];
  stories: string[];
  warmIntros: WarmIntro[];
} {
  const o = obj(unpack(d));
  const people = obj(o.people);
  const to = personOf(o.to) ?? personOf(o.target);
  const routes = arr(o.routes)
    .map((x): RouteView | undefined => {
      const r = obj(x);
      const hops = arr(r.hops).map(obj);
      if (!hops.length) return undefined;
      return {
        band: str(r.band),
        bandLabel: str(r.bandLabel),
        score: num(r.score) ?? 0,
        names: hops.map((h) => {
          const id = str(h.toId);
          const p = id ? people[id] : undefined;
          return (
            str(h.to) ??
            (isPerson(p) ? p.firstName : undefined) ??
            (id === to?.id ? to?.firstName : 'someone') ??
            'someone'
          );
        }),
        text: hops.map((h) => str(h.how) ?? str(h.text)).filter(present),
      };
    })
    .filter(present);
  const warmIntros = readWarmIntros(d);
  return {
    to,
    routes,
    stories: arr(o.stories)
      .map((s) => str(obj(s).text))
      .filter(present),
    warmIntros,
  };
}

/** brief / suggestion: domain Suggestions, or card references `{ id, kind, reason }` (alone or as `{ card }`) */
export function readSuggestions(d: unknown): { suggestions: Suggestion[]; ids: string[]; summary?: string } {
  const u = unpack(d);
  const o = obj(u);
  if (isSuggestion(u)) return { suggestions: [u], ids: [] };
  if (isSuggestion(o.suggestion)) return { suggestions: [o.suggestion], ids: [] };
  const domain = arr(Array.isArray(u) ? u : o.suggestions).filter(isSuggestion);
  const refs = [o.card, ...arr(o.cards), ...arr(o.more)]
    .map((x) => {
      const r = obj(x);
      return str(obj(r.card).id) ?? (str(r.reason) !== undefined || str(r.kind) ? str(r.id) : undefined);
    })
    .filter(present);
  return { suggestions: domain, ids: [...new Set(refs)], summary: str(o.summary) };
}

/** brief extras: `{ nextUp?: { startAt, title?, person? }, quiet: CoffeeChat[] }`, for the "Coming up" line and the count of chats waiting on a reply */
export function readBriefExtras(d: unknown): {
  nextUp?: { startAt: string; title?: string; person?: string };
  waiting: number;
} {
  const o = obj(unpack(d));
  const n = obj(o.nextUp);
  const startAt = str(n.startAt);
  return {
    nextUp: startAt ? { startAt, title: str(n.title), person: str(n.person) } : undefined,
    waiting: arr(o.quiet).length,
  };
}

/** note: `{ note, person?, facts? }`, an add_note result `{ noteId, person, facts, summary }`, or `{ notes }` */
export function readNote(d: unknown): {
  note?: MeetingNote;
  person?: Person;
  facts: string[];
  summary?: string;
  notes: { when?: string; people: string[]; summary?: string }[];
  candidates: Person[];
} {
  const o = obj(unpack(d));
  const note = obj(o.note).rawText !== undefined ? (o.note as MeetingNote) : undefined;
  return {
    note,
    person: personOf(o.person),
    facts: strings(o.facts),
    summary: str(o.summary) ?? note?.summary,
    notes: arr(o.notes).map((n) => {
      const r = obj(n);
      return { when: str(r.when), people: strings(r.people), summary: str(r.summary) };
    }),
    candidates: arr(o.candidates).map(personOf).filter(present),
  };
}

/** facts: `{ person?, facts: (PersonFact | string)[] }` or one saved fact `{ person, type, typeLabel, text }` */
export interface FactItem {
  text: string;
  type?: string;
}
export function readFacts(d: unknown): { person?: Person; facts: FactItem[] } {
  const u = unpack(d);
  const o = obj(u);
  const raw = Array.isArray(u) ? u : Array.isArray(o.facts) ? o.facts : str(o.text) ? [o] : [];
  const facts = raw
    .map((f): FactItem | undefined =>
      typeof f === 'string'
        ? { text: f }
        : str(obj(f).text)
          ? { text: (f as PersonFact).text, type: str(obj(f).typeLabel) ?? (f as PersonFact).type }
          : undefined,
    )
    .filter(present);
  return { person: personOf(o.person), facts };
}

/** company: `{ organization, people?, target? }` or a find_routes company view `{ company, thereNow, former }` */
export function readCompany(d: unknown): {
  name?: string;
  industry?: string;
  people: Person[];
  former: Person[];
  target?: boolean;
} {
  const o = obj(unpack(d));
  const org = obj(
    o.organization ?? (typeof o.company === 'object' ? o.company : undefined),
  ) as Partial<Organization>;
  return {
    name: str(org.name) ?? str(o.company) ?? str(o.name),
    industry: str(org.industry) ?? str(o.industry),
    people: arr(o.people ?? o.thereNow)
      .map(personOf)
      .filter(present),
    former: arr(o.former).map(personOf).filter(present),
    target: typeof o.target === 'boolean' ? o.target : o.target ? true : undefined,
  };
}

/** settings: `{ changes: { label, from?, to }[] }`, or any settings view, shown as its plain values */
export interface SettingChange {
  label: string;
  from?: string;
  to: string;
}
const SKIP = new Set(['href', 'id', 'userId', 'json', 'ranges', 'isDemo', 'model']);
const human = (k: string) =>
  k
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
function valueText(v: unknown): string | undefined {
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v.trim() || undefined;
  if (Array.isArray(v)) {
    const parts = v
      .map((x) => (typeof x === 'string' ? x : (str(obj(x).label) ?? str(obj(x).name))))
      .filter(present);
    return parts.length ? parts.join(', ') : undefined;
  }
  return undefined;
}
export function readSettings(d: unknown): SettingChange[] {
  const u = unpack(d);
  const o = obj(u);
  const raw = Array.isArray(u) ? u : o.changes;
  if (Array.isArray(raw))
    return raw
      .map((c): SettingChange | undefined => {
        const r = obj(c);
        return typeof r.label === 'string'
          ? {
              label: r.label,
              from: r.from === undefined ? undefined : String(r.from),
              to: String(r.to ?? ''),
            }
          : undefined;
      })
      .filter(present);
  const out: SettingChange[] = [];
  const walk = (x: Record<string, unknown>, depth: number) => {
    for (const [k, v] of Object.entries(x)) {
      if (SKIP.has(k) || out.length >= 14) continue;
      const t = valueText(v);
      if (t !== undefined) out.push({ label: human(k), to: t.length > 120 ? `${t.slice(0, 117)}...` : t });
      else if (v && typeof v === 'object' && !Array.isArray(v) && depth < 1)
        walk(v as Record<string, unknown>, depth + 1);
    }
  };
  walk(o, 0);
  return out;
}

/** import: `{ source?, counts }`, a LinkedIn import result `{ imported, updated, ... }`, or a resume `{ facets }` */
export function readImport(d: unknown): {
  source?: string;
  counts: { label: string; value: number }[];
  lines: string[];
} {
  const o = obj(unpack(d));
  const raw = o.counts;
  const counts = Array.isArray(raw)
    ? raw
        .map((c) => obj(c))
        .filter((c) => typeof c.label === 'string' && typeof c.value === 'number')
        .map((c) => ({ label: c.label as string, value: c.value as number }))
    : Object.entries(raw ? obj(raw) : o)
        .filter(([k, v]) => typeof v === 'number' && !SKIP.has(k))
        .map(([k, v]) => ({ label: human(k).toLowerCase(), value: v as number }));
  const lines = arr(o.facets)
    .map((f) => {
      const r = obj(f);
      return [str(r.title), str(r.organization)].filter(present).join(', ') || str(r.text);
    })
    .filter(present);
  return { source: str(o.source) ?? (lines.length ? str(o.filename) : undefined), counts, lines };
}

/** prep: `{ person, when?, summary?, questions?, facts? }` or picked questions `{ picked }` */
export function readPrep(d: unknown): {
  person?: Person;
  when?: string;
  summary?: string;
  questions: string[];
  facts: string[];
} {
  const o = obj(unpack(d));
  return {
    person: personOf(o.person),
    when: str(o.when),
    summary: str(o.summary),
    questions: strings(o.questions).length ? strings(o.questions) : strings(o.picked),
    facts: strings(o.facts),
  };
}

export interface ListRow {
  text: string;
  sub?: string;
  chip?: string;
  href?: string;
  links: { label: string; url: string }[];
}

/** list: `{ title, items: { text, sub?, chip?, href?, links? }[] }` */
export function readList(d: unknown): { title?: string; items: ListRow[] } {
  const o = obj(unpack(d));
  const items = arr(o.items)
    .map((x): ListRow | undefined => {
      const r = obj(x);
      const text = str(r.text);
      if (!text) return undefined;
      const href = str(r.href);
      return {
        text,
        sub: str(r.sub),
        chip: str(r.chip),
        // only in-app routes become links here; outside pages come as `links`
        href: href?.startsWith('/') ? href : undefined,
        links: arr(r.links)
          .map((l) => {
            const lo = obj(l);
            const url = str(lo.url);
            return url && /^https?:\/\//.test(url) ? { label: str(lo.label) ?? 'source', url } : undefined;
          })
          .filter(present),
      };
    })
    .filter(present);
  return { title: str(o.title), items };
}

/** text: the words to copy or the file to save, when a text result carries one */
export function readText(d: unknown): { quote?: string; file?: { name: string; json: string } } {
  const o = obj(unpack(d));
  const quote = str(o.comment) ?? str(o.textToPaste);
  const file =
    str(o.json) && str(o.filename) ? { name: o.filename as string, json: o.json as string } : undefined;
  return { quote, file };
}

/** needs_confirmation: `{ toolName, input, summary | text, blockedReason?, draft? }` */
export function readConfirm(d: unknown): {
  toolName?: string;
  text?: string;
  blockedReason?: string;
  draft?: OutboundMessage;
  draftId?: string;
  person?: Person;
} {
  const o = obj(d);
  const toolName = str(o.toolName);
  const input = obj(o.input);
  return {
    toolName,
    text: str(o.text) ?? str(o.summary),
    blockedReason: str(o.blockedReason),
    draft: isDraft(o.draft) ? o.draft : undefined,
    draftId: toolName === 'send_draft' ? str(input.draftId) : undefined,
    person: isPerson(o.person) ? o.person : undefined,
  };
}

/** error: `{ message? }` */
export function readError(d: unknown): string | undefined {
  return str(obj(d).message);
}

/** choices: `{ options: { label, message }[] }`; an option without both words is dropped, and three is the most shown */
export function readChoices(d: unknown): ChoiceOption[] {
  return arr(obj(d).options)
    .map((o) => ({ label: str(obj(o).label), message: str(obj(o).message) }))
    .filter((o): o is ChoiceOption => !!o.label && !!o.message)
    .slice(0, 3);
}

/** setup: `{ what, ...status }` (the status the tool read when it ran); the card reads the live status itself */
export function readSetup(d: unknown): { what?: SetupWhat; status?: SetupStatus } {
  const o = obj(d);
  const what = (['google', 'linkedin', 'claude_key', 'resume'] as const).find((w) => w === o.what);
  return what ? { what, status: o as unknown as SetupStatus } : {};
}

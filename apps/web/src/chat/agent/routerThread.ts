import { db } from '../../db/schema';
import type { ChatAction, ChoiceOption, ResultEnvelope } from '../types';
import type { NextStep } from '../ui/cards/parts';
import {
  readChoices,
  readCompany,
  readConfirm,
  readDraft,
  readDrafts,
  readPeople,
  readPerson,
  readPipeline,
  readRoutes,
  readRoutesMany,
  readSkipped,
  readText,
} from '../ui/cards/shapes';
import { cardSteps } from '../ui/cards/steps';
import { mentioned } from './routerMore';
import type { ChatStore } from './store';

/**
 * What the conversation so far shows, for the no-key router: the person it is about, the last list of people, the
 * drafts just made or shown, the target of the last routes, the last card's next steps and a confirmation waiting
 * for Approve. With it the router can follow "write to her", "draft to the top 3", "send the first", "make it
 * shorter", "and Dan?", "do it" or "ask Maya" the way a person would, instead of reading each message alone.
 */
export interface PersonRef {
  id: string;
  name: string;
}

export interface ThreadContext {
  /** the one person the conversation is about now */
  focus?: PersonRef;
  /** the last list of people shown, in the order shown */
  list?: PersonRef[];
  /** the newest thing shown was the list, not one person ("write to them" means all of them) */
  listIsNewest?: boolean;
  /** the drafts made or shown last, in order, with the text of each */
  drafts?: { id: string; personId: string; name: string; status: string; body: string; subject?: string }[];
  /** the person the last routes were found to */
  target?: PersonRef;
  /** the first hops of the last routes, best first */
  introducers?: string[];
  /** the last card's next steps (what "do it" means) */
  steps?: NextStep[];
  /** the last card's tap-to-answer pills */
  choices?: ChoiceOption[];
  /** a confirmation waiting for Approve */
  pending?: { id: string; tool: string };
  /** the kind of the newest card ("yes" after a draft means send it) */
  lastKind?: string;
  /** the last tool and its input, to ask the same about someone else ("and Dan?") */
  last?: { tool: string; input: Record<string, unknown> };
}

const LOOK_BACK = 8;

export async function threadContextFor(store: ChatStore, conversationId: string): Promise<ThreadContext> {
  const [all, messages] = await Promise.all([store.actions(conversationId), store.messages(conversationId)]);
  // newest first: by time, then by the message each run belongs to (runs in one second share a time); a confirmation
  // the registry stored sits with the run that asked for it
  const seq = new Map(messages.map((m) => [m.id, m.seq]));
  const askedBy = new Map(
    all.flatMap((a) => (a.envelope?.confirmationId ? [[a.envelope.confirmationId, a]] : [])),
  );
  const order = (a: ChatAction) => seq.get(a.messageId ?? askedBy.get(a.id)?.messageId ?? '') ?? -1;
  const actions = all
    .filter((a) => a.status === 'done' || a.status === 'pending')
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) ||
        order(b) - order(a) ||
        (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0),
    )
    .slice(0, LOOK_BACK);
  const out: ThreadContext = {};
  // the person the student's last message named, when no card since then has been about anyone ("should I email
  // Marcus again?" then "ok, follow up with him")
  const current = messages.at(-1)?.role === 'user' ? messages.at(-1) : undefined;
  const lastSaid = [...messages].reverse().find((m) => m.role === 'user' && !m.meta && m !== current);
  const spoken = async (): Promise<PersonRef | undefined> => {
    const text = (Array.isArray(lastSaid?.content) ? lastSaid.content : [])
      .map((b: { type?: string; text?: string }) => (b.type === 'text' ? (b.text ?? '') : ''))
      .join(' ');
    if (!text || !lastSaid) return undefined;
    const people = (await db.people.where('userId').equals(lastSaid.userId).toArray()).filter(
      (p) => p.isHuman && !p.hiddenAt,
    );
    const m = mentioned(text, people);
    return m.person ? { id: m.person.id, name: m.person.displayName } : undefined;
  };
  if (!actions.length) {
    const p = await spoken();
    if (p) out.focus = p;
    return out;
  }
  const nameOf = async (id: string) => {
    const p = await db.people.get(id);
    return p ? { id, name: p.displayName } : undefined;
  };
  const newest = actions[0]!;
  if (newest.status === 'pending') out.pending = { id: newest.id, tool: newest.toolName };
  // the newest card answered: its next steps and pills are what "do it" or "the second one" mean
  const shown = actions.find((a) => a.status === 'done' && a.envelope);
  if (shown?.envelope) {
    out.lastKind = shown.envelope.kind;
    out.steps = cardSteps(shown.toolName, shown.envelope);
    if (shown.envelope.kind === 'choices') out.choices = readChoices(shown.envelope.data);
    if (isRunnable(shown))
      out.last = { tool: shown.toolName, input: (shown.input ?? {}) as Record<string, unknown> };
  }
  for (const a of actions) {
    const env = a.envelope;
    if (!env) continue;
    const refs = await peopleIn(a, env, nameOf);
    if (!out.list && refs.list && refs.list.length > 1) {
      out.list = refs.list;
      if (!out.focus) out.listIsNewest = true;
    }
    if (!out.focus && refs.one) out.focus = refs.one;
    if (!out.drafts) {
      const drafts = await draftsIn(env);
      if (drafts.length) out.drafts = drafts;
    }
    if (!out.target && (a.toolName === 'find_routes' || a.toolName === 'get_mutual_connections')) {
      const r = readRoutes(env.data);
      if (r.to) out.target = { id: r.to.id, name: r.to.displayName };
      const firsts = r.routes.map((x) => x.names[0]).filter((n): n is string => !!n && n !== 'someone');
      const warm = r.warmIntros.map((w) => w.introducer);
      const mutuals = readPeople(env.data).map((p) => p.person.displayName);
      out.introducers = [...new Set([...firsts, ...warm, ...mutuals])];
    }
    if (out.focus && out.list && out.drafts) break;
  }
  // the newest turn said something without a card about anyone: the name in the student's words is the focus
  const newestMessage = actions[0]!.messageId;
  const lastUserSeq = lastSaid?.seq ?? -1;
  if (!out.focus || (seq.get(newestMessage ?? '') ?? -1) < lastUserSeq) {
    const p = await spoken();
    if (p) out.focus = p;
  }
  return out;
}

/** A tool whose input names one person, so the same question can be asked about someone else. */
function isRunnable(a: ChatAction): boolean {
  const input = a.input as Record<string, unknown> | undefined;
  return !!input && typeof input.personId === 'string';
}

async function peopleIn(
  a: ChatAction,
  env: ResultEnvelope,
  nameOf: (id: string) => Promise<PersonRef | undefined>,
): Promise<{ one?: PersonRef; list?: PersonRef[] }> {
  const d = env.data;
  const input = (a.input ?? {}) as Record<string, unknown>;
  const ref = (p: { id: string; displayName: string }) => ({ id: p.id, name: p.displayName });
  switch (env.kind) {
    case 'person': {
      const r = readPerson(d);
      return r ? { one: ref(r.person) } : {};
    }
    case 'people': {
      const list = readPeople(d).map((p) => ref(p.person));
      return list.length === 1 ? { one: list[0] } : { list };
    }
    case 'pipeline': {
      const list = readPipeline(d).items.map((i) => ref(i.person));
      return list.length === 1 ? { one: list[0] } : { list };
    }
    case 'company': {
      const list = readCompany(d).people.map(ref);
      return list.length === 1 ? { one: list[0] } : { list };
    }
    case 'routes': {
      const to = readRoutes(d).to;
      const mutuals = readPeople(d).map((p) => ref(p.person));
      return { one: to ? ref(to) : undefined, list: mutuals.length > 1 ? mutuals : undefined };
    }
    case 'routes_many': {
      const list = readRoutesMany(d).map((r) => ref(r.to!));
      return list.length === 1 ? { one: list[0] } : { list };
    }
    case 'drafts': {
      const ids = await Promise.all(readDrafts(d).map((r) => db.outbound.get(r.id)));
      const list = (await Promise.all(ids.filter((o) => !!o).map((o) => nameOf(o!.personId)))).filter(
        (p): p is PersonRef => !!p,
      );
      return list.length === 1 ? { one: list[0] } : { list };
    }
    case 'draft': {
      const r = readDraft(d);
      const row = r ? await db.outbound.get(r.draftId) : undefined;
      const one = row ? await nameOf(row.personId) : undefined;
      return { one };
    }
    case 'needs_confirmation': {
      const c = readConfirm(d);
      if (c.person) return { one: ref(c.person) };
      const row = c.draftId ? await db.outbound.get(c.draftId) : undefined;
      if (row) return { one: await nameOf(row.personId) };
      break;
    }
    case 'text': {
      const t = readText(d);
      const p = t.warmUpFor ?? t.wait?.person;
      if (p) return { one: ref(p) };
      break;
    }
    default:
      break;
  }
  // the tool's own input names the person (a move, a note, a hide, a draft that was skipped)
  if (typeof input.personId === 'string') {
    const one = await nameOf(input.personId);
    if (one) return { one };
  }
  if (Array.isArray(input.personIds)) {
    const list = (await Promise.all(input.personIds.map((id) => nameOf(String(id))))).filter(
      (p): p is PersonRef => !!p,
    );
    return list.length === 1 ? { one: list[0] } : { list };
  }
  const skipped = readSkipped(d);
  if (skipped.length === 1) {
    const p = (await db.people.toArray()).find((x) => x.displayName === skipped[0]!.name);
    if (p) return { one: { id: p.id, name: p.displayName } };
  }
  return {};
}

async function draftsIn(env: ResultEnvelope): Promise<NonNullable<ThreadContext['drafts']>> {
  const ids =
    env.kind === 'draft'
      ? [readDraft(env.data)?.draftId]
      : env.kind === 'drafts'
        ? readDrafts(env.data).map((r) => r.id)
        : env.kind === 'needs_confirmation'
          ? [readConfirm(env.data).draftId]
          : [];
  const out: NonNullable<ThreadContext['drafts']> = [];
  for (const id of ids) {
    if (!id) continue;
    const o = await db.outbound.get(id);
    if (!o) continue;
    const p = await db.people.get(o.personId);
    out.push({
      id: o.id,
      personId: o.personId,
      name: p?.displayName ?? '',
      status: o.status,
      body: o.bodyFinal ?? o.bodyDraft ?? '',
      subject: o.subject ?? undefined,
    });
  }
  return out;
}

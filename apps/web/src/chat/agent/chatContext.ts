/**
 * What a new message is read with beyond this chat's own turns (plan 39):
 *
 * - earlier chats: a short record of the last few conversations (what the student asked, what Orbit did), so opening
 *   Orbit again does not start from nothing, and a search over every past conversation for anything older;
 * - recent activity: who the student wrote to lately and who wrote back, by name and day, so "did anyone reply" and
 *   "the last person I messaged" have an answer before any tool runs.
 *
 * Both are records, not instructions: only the student's own words and Orbit's own summaries go into the prompt, never
 * the text of a message someone else wrote (that stays behind `get_person` and `list_inbox`, which wrap it). Nothing
 * here calls a model or leaves the browser by itself; the lines ride along in the snapshot the turn already sends.
 */
import MiniSearch from 'minisearch';
import { db } from '../../db/schema';
import { neutralizeTags } from '../../integrations/anthropic';
import type { ChatAction, ChatConversation, ChatMessage } from '../types';
import { isOrbitNote, isOrbitText } from './orbitNote';

const DAY = 86_400_000;

/** One earlier conversation, in the student's words and Orbit's. */
export interface ChatDigest {
  id: string;
  title: string;
  /** when it was last active */
  at: string;
  /** what the student said, oldest first */
  said: string[];
  /** what Orbit did (the summaries of the cards it showed), oldest first */
  did: string[];
}

/** One line of plain words: no markup that could pass for a block of the prompt. */
const squash = (s: string) => neutralizeTags(s).replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim();
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** The words of a stored row: its text blocks, without Orbit's own notes. */
export function wordsOf(m: Pick<ChatMessage, 'content'>): string {
  const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
  if (!Array.isArray(blocks)) return '';
  return squash(
    blocks
      .map((b: { type?: string; text?: unknown }) =>
        b?.type === 'text' && typeof b.text === 'string' && !isOrbitText(b.text) ? b.text : '',
      )
      .join(' '),
  );
}

/** A row the student typed: not a decision line, a context block or one of Orbit's notes. */
const isStudentTurn = (m: ChatMessage) => m.role === 'user' && !m.meta && !isOrbitNote(m);
/** A reply in words (context blocks and failed-turn notes are neither side's words). */
const isReply = (m: ChatMessage) => m.role === 'assistant' && !m.meta;

function digestOf(c: ChatConversation, messages: ChatMessage[], actions: ChatAction[]): ChatDigest {
  const said = messages
    .filter(isStudentTurn)
    .sort((a, b) => a.seq - b.seq)
    .map(wordsOf)
    .filter(Boolean);
  const did = actions
    .filter((a) => a.status === 'done' && a.envelope?.summary && a.envelope.kind !== 'error')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((a) => squash(a.envelope!.summary));
  return { id: c.id, title: squash(c.title), at: c.updatedAt, said, did: [...new Set(did)] };
}

async function conversationsOf(userId: string, except?: string): Promise<ChatConversation[]> {
  return (await db.chatConversations.where('userId').equals(userId).toArray())
    .filter((c) => c.id !== except && !c.archivedAt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The most recent earlier conversations that hold something the student said, newest first. */
export async function chatDigests(
  userId: string,
  opts: { except?: string; limit?: number } = {},
): Promise<ChatDigest[]> {
  const out: ChatDigest[] = [];
  for (const c of (await conversationsOf(userId, opts.except)).slice(0, 12)) {
    const [messages, actions] = await Promise.all([
      db.chatMessages.where('conversationId').equals(c.id).toArray(),
      db.chatActions.where('conversationId').equals(c.id).toArray(),
    ]);
    const d = digestOf(c, messages, actions);
    if (d.said.length) out.push(d);
    if (out.length >= (opts.limit ?? 4)) break;
  }
  return out;
}

/** The calendar day of a moment where the student lives, as a day count (so two moments compare by date). */
function dayNumber(d: Date, tz?: string): number {
  let key: string;
  try {
    key = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    key = d.toISOString().slice(0, 10);
  }
  const [y, m, day] = key.split('-').map(Number);
  return Math.round(Date.UTC(y!, m! - 1, day!) / DAY);
}

/** "today", "yesterday", "3 d ago", "2 wk ago": by calendar day in the student's timezone, never by 24-hour blocks. */
export function ago(iso: string, now: Date, tz?: string): string {
  const days = dayNumber(now, tz) - dayNumber(new Date(iso), tz);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return days < 14 ? `${days} d ago` : `${Math.round(days / 7)} wk ago`;
}

export const EARLIER_CHATS_MAX = 900;

/**
 * The earlier chats as one context line: for each, when, the student's first and latest asks, and what Orbit did
 * last. The newest chat gets the most room.
 */
export function earlierChatsLine(
  digests: ChatDigest[],
  now: Date,
  maxChars = EARLIER_CHATS_MAX,
  tz?: string,
): string | undefined {
  if (!digests.length) return undefined;
  const parts = digests.map((d, i) => {
    const room = i === 0 ? 150 : 90;
    const asks = d.said.length > 2 ? [d.said[0]!, d.said.at(-1)!] : d.said;
    const said = asks.map((s) => `"${cut(s, room)}"`).join(' then ');
    const more = d.said.length > asks.length ? ` (${d.said.length} messages)` : '';
    const did = d.did.at(-1) ? `; Orbit: ${cut(d.did.at(-1)!, 80)}` : '';
    return `[${d.id}] ${ago(d.at, now, tz)}: ${said}${more}${did}`;
  });
  const head =
    'Earlier chats (a record of past conversations, newest first; use it when the student refers to before, last time or "what we were doing", and call search_chats for anything not here): ';
  let body = parts.join(' | ');
  while (body.length > maxChars && parts.length > 1) {
    parts.pop();
    body = parts.join(' | ');
  }
  return head + cut(body, maxChars);
}

export const ACTIVITY_DAYS = 14;
const ACTIVITY_ROWS = 6;

/** Who the student wrote to lately and who wrote back: names, channels and days only, never anyone's words. */
export async function recentActivityLine(
  userId: string,
  now: Date,
  tz?: string,
): Promise<string | undefined> {
  const since = new Date(now.getTime() - ACTIVITY_DAYS * DAY).toISOString();
  const [mail, people, outbound] = await Promise.all([
    db.messages.where('sentAt').aboveOrEqual(since).toArray(),
    db.people.where('userId').equals(userId).toArray(),
    // what went out through Orbit, for an account whose mail is not kept in this browser
    db.outbound.where('sentAt').aboveOrEqual(since).toArray(),
  ]);
  const names = new Map(people.filter((p) => p.isHuman && !p.hiddenAt).map((p) => [p.id, p.displayName]));
  const mine = mail.filter((m) => m.userId === userId && !m.isAutomated);
  const viaOrbit = outbound.filter((o) => o.userId === userId && o.status === 'sent' && !!o.sentAt);
  if (!mine.length && !viaOrbit.length) return undefined;
  const threads = new Map(
    (await db.threads.bulkGet([...new Set(mine.map((m) => m.threadId))]))
      .filter((t): t is NonNullable<typeof t> => !!t)
      .map((t) => [t.id, t]),
  );
  // the other person on a message: who wrote it, or the one known person on its thread
  const other = (m: (typeof mine)[number]): string | undefined => {
    if (m.direction === 'inbound')
      return m.fromPersonId && names.has(m.fromPersonId) ? m.fromPersonId : undefined;
    const on = (threads.get(m.threadId)?.participantPersonIds ?? []).filter((id) => names.has(id));
    return on.length === 1 ? on[0] : undefined;
  };
  interface Row {
    personId: string;
    at: string;
    channel: string;
  }
  const latest = (direction: 'inbound' | 'outbound'): Row[] => {
    const seen = new Map<string, Row>();
    for (const m of mine
      .filter((x) => x.direction === direction)
      .sort((a, b) => b.sentAt.localeCompare(a.sentAt))) {
      const personId = other(m);
      if (!personId || seen.has(personId)) continue;
      seen.set(personId, {
        personId,
        at: m.sentAt,
        channel: m.channel === 'linkedin' ? 'LinkedIn' : 'email',
      });
    }
    return [...seen.values()];
  };
  const sentBy = new Map(latest('outbound').map((r) => [r.personId, r]));
  for (const o of viaOrbit) {
    const had = sentBy.get(o.personId);
    if (names.has(o.personId) && (!had || had.at < o.sentAt!))
      sentBy.set(o.personId, {
        personId: o.personId,
        at: o.sentAt!,
        channel: o.channel === 'linkedin' ? 'LinkedIn' : 'email',
      });
  }
  const sent = [...sentBy.values()].sort((a, b) => b.at.localeCompare(a.at));
  const heard = latest('inbound');
  if (!sent.length && !heard.length) return undefined;
  const heardAt = new Map(heard.map((r) => [r.personId, r.at]));
  const sentAt = new Map(sent.map((r) => [r.personId, r.at]));
  const who = (r: Row) => `${names.get(r.personId)} [${r.personId}]`;
  const sentBits = sent.slice(0, ACTIVITY_ROWS).map((r) => {
    const back = heardAt.get(r.personId);
    return `${who(r)} ${r.channel} ${ago(r.at, now, tz)}, ${back && back > r.at ? 'replied' : 'no reply yet'}`;
  });
  const heardBits = heard.slice(0, ACTIVITY_ROWS).map((r) => {
    const answered = sentAt.get(r.personId);
    return `${who(r)} ${r.channel} ${ago(r.at, now, tz)}, ${answered && answered > r.at ? 'answered' : 'not answered yet'}`;
  });
  const more = (n: number) => (n > ACTIVITY_ROWS ? ` (+${n - ACTIVITY_ROWS} more)` : '');
  return [
    `Recent messages, last ${ACTIVITY_DAYS} days (names and days only; call get_person for what was said).`,
    sentBits.length
      ? `Student wrote to: ${sentBits.join('; ')}${more(sent.length)}.`
      : 'Student wrote to nobody.',
    heardBits.length
      ? `Wrote to the student: ${heardBits.join('; ')}${more(heard.length)}.`
      : 'Nobody wrote to the student.',
  ].join(' ');
}

/** One place a past conversation matched. */
export interface ChatHit {
  conversationId: string;
  title: string;
  at: string;
  who: 'student' | 'orbit';
  text: string;
}

/**
 * Search every past conversation for words the student or Orbit said. With no query, the latest conversations in
 * order. Ranked by match, with a nudge for recent chats and for the student's own words.
 */
export async function searchChats(
  userId: string,
  query: string,
  opts: { except?: string; limit?: number; now?: Date } = {},
): Promise<ChatHit[]> {
  const limit = opts.limit ?? 8;
  const now = opts.now ?? new Date();
  const conversations = await conversationsOf(userId, opts.except);
  if (!conversations.length) return [];
  const byId = new Map(conversations.map((c) => [c.id, c]));
  const rows = (
    await Promise.all(
      conversations.map((c) => db.chatMessages.where('conversationId').equals(c.id).toArray()),
    )
  )
    .flat()
    .filter((m) => isStudentTurn(m) || isReply(m))
    .map((m) => ({ id: m.id, conversationId: m.conversationId, seq: m.seq, role: m.role, text: wordsOf(m) }))
    .filter((r) => r.text);
  const hit = (r: (typeof rows)[number]): ChatHit => {
    const c = byId.get(r.conversationId)!;
    return {
      conversationId: c.id,
      title: squash(c.title),
      at: c.updatedAt,
      who: r.role === 'user' ? 'student' : 'orbit',
      text: cut(r.text, 320),
    };
  };
  const q = query.trim();
  if (!q) {
    // "what were we talking about": the student's words from the newest chats, in order
    return conversations
      .flatMap((c) => rows.filter((r) => r.conversationId === c.id && r.role === 'user').slice(-3))
      .slice(0, limit)
      .map(hit);
  }
  const index = new MiniSearch<(typeof rows)[number]>({
    fields: ['text'],
    storeFields: ['id'],
    searchOptions: { prefix: true, fuzzy: 0.15, combineWith: 'OR' },
  });
  index.addAll(rows);
  const rowOf = new Map(rows.map((r) => [r.id, r]));
  return index
    .search(q, {
      boostDocument: (id) => {
        const r = rowOf.get(id as string)!;
        const days = (now.getTime() - new Date(byId.get(r.conversationId)!.updatedAt).getTime()) / DAY;
        return (r.role === 'user' ? 1.3 : 1) * (1 + 1 / (1 + Math.max(0, days) / 7));
      },
    })
    .slice(0, limit)
    .map((m) => hit(rowOf.get(m.id as string)!));
}

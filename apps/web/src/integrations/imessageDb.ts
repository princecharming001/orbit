/**
 * Reading the Mac's Messages database (~/Library/Messages/chat.db), which the student picks in Orbit. It is opened
 * here in the browser with SQLite compiled to WebAssembly (sql.js, loaded only when an import starts); nothing is
 * uploaded. Messages keeps its newest messages in chat.db-wal beside it, so that file is read too when it is given
 * (integrations/sqliteWal.ts).
 *
 * One-to-one chats, and group chats of up to eight people (the student included), are read. Per person and chat Orbit
 * keeps how many texts went each way on which days, counted in the student's own time zone, whether anything was
 * written that day or only tapbacks and shared items, and, for one-to-one chats, the last few messages for that
 * person's page.
 */
import { localDay } from '@orbit/core';
import type { Database, SqlJsStatic } from 'sql.js';
import { applyWal } from './sqliteWal';

/** Messages are dated in seconds (older Macs) or nanoseconds (newer) since 2001-01-01. */
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
const RECENT_KEPT = 8;
/** the largest chat read, the student included (plan 43 §3.8: more than eight counts for nothing) */
export const MAX_GROUP = 8;

/** One day of texting in one chat, each way: texts with words, and tapbacks or shared items without. */
export interface TextDay {
  /** yyyy-mm-dd in the student's time zone */
  day: string;
  inCount: number;
  outCount: number;
  /** tapbacks, reactions and shared items with nothing written */
  inLight: number;
  outLight: number;
  firstAt: string;
  /**
   * the first message each way (a written one when there was one), so a text back at 3pm to one sent at 9am is a
   * six-hour reply, not an instant one
   */
  firstInAt?: string;
  firstOutAt?: string;
}

export interface TextConversation {
  /** the other side: +15551234567 or name@icloud.com, as Messages stores it (in a group, one of its members) */
  handle: string;
  /** "direct" for one-to-one chats (all of them with this handle), else the group chat's own id */
  chat: string;
  /** everyone in the chat, the student included: 2 for one to one */
  group: number;
  /** texts with words, each way (in a group: from this member, and from the student to the group) */
  inCount: number;
  outCount: number;
  firstAt: string;
  lastAt: string;
  days: TextDay[];
  /** one-to-one chats only: the latest messages, oldest first */
  recent: { at: string; fromMe: boolean; text: string }[];
}

export interface MessagesFiles {
  db: Uint8Array;
  /** chat.db-wal, with the newest messages */
  wal?: Uint8Array;
}

export interface MessagesRead {
  conversations: TextConversation[];
  /** group chats found, of any size */
  groupChats: number;
  /** of those, the ones larger than eight, which are not read */
  largeGroups: number;
  /** pages the side file added (0 without it) */
  walFrames: number;
}

let sql: Promise<SqlJsStatic> | undefined;

/** Test hook: SQLite loaded the way Node loads it (the browser fetches the WebAssembly file instead). */
export function setSqlJsForTests(s: Promise<SqlJsStatic> | undefined): void {
  sql = s;
}
async function sqlJs(): Promise<SqlJsStatic> {
  sql ??= (async () => {
    const [{ default: init }, { default: wasm }] = await Promise.all([
      import('sql.js'),
      import('sql.js/dist/sql-wasm.wasm?url'),
    ]);
    return init({ locateFile: () => wasm });
  })();
  return sql;
}

export function appleDate(raw: number | bigint | null | undefined): Date | undefined {
  if (raw === null || raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // nanoseconds on any Mac since 2017; seconds before that
  const ms = n > 1e14 ? n / 1e6 : n * 1000;
  return new Date(APPLE_EPOCH_MS + ms);
}

/**
 * The text inside a message's attributedBody, for messages whose `text` column is empty (most messages on recent
 * macOS). It is an NSAttributedString in Apple's typedstream format: the string follows the "NSString" class name,
 * after a "+" marker and a length (one byte, or 0x81 and two bytes, or 0x82 and four).
 */
export function textFromAttributedBody(blob: Uint8Array | null | undefined): string | undefined {
  if (!blob?.length) return undefined;
  const marker = [0x4e, 0x53, 0x53, 0x74, 0x72, 0x69, 0x6e, 0x67]; // "NSString"
  let at = -1;
  for (let i = 0; i + marker.length <= blob.length; i++) {
    if (marker.every((b, j) => blob[i + j] === b)) {
      at = i + marker.length;
      break;
    }
  }
  if (at < 0) return undefined;
  const plus = blob.indexOf(0x2b, at);
  if (plus < 0 || plus - at > 12) return undefined;
  let i = plus + 1;
  let len = blob[i]!;
  i++;
  if (len === 0x81) {
    len = blob[i]! | (blob[i + 1]! << 8);
    i += 2;
  } else if (len === 0x82) {
    len = blob[i]! | (blob[i + 1]! << 8) | (blob[i + 2]! << 16) | (blob[i + 3]! << 24);
    i += 4;
  }
  if (len <= 0 || i + len > blob.length) return undefined;
  const t = new TextDecoder().decode(blob.subarray(i, i + len)).trim();
  return t || undefined;
}

/**
 * What one row of the message table is: a text, something without words (a tapback, a sticker, a shared photo or
 * link with nothing written), or nothing at all (a tapback taken back, a member added, a chat renamed).
 */
export function messageKind(
  associatedType: number | null | undefined,
  itemType: number | null | undefined,
  text: string | undefined,
): 'words' | 'light' | 'skip' {
  if (itemType) return 'skip';
  const assoc = Number(associatedType ?? 0);
  // 2000s are tapbacks and reactions; 3000s take one back
  if (assoc >= 3000 && assoc < 4000) return 'skip';
  if (assoc !== 0) return 'light';
  return text ? 'words' : 'light';
}

const NOT_MESSAGES = "That file isn't a Messages database. Pick chat.db from your Messages folder.";

interface Acc {
  conv: TextConversation;
  days: Map<string, TextDay & { firstInWords?: string; firstOutWords?: string }>;
}

/**
 * Every one-to-one chat and every group chat of up to eight in a Messages database, from `since` on, with days
 * counted in `timeZone` (the student's; UTC when unknown).
 */
export async function readMessagesDb(
  input: Uint8Array | MessagesFiles,
  opts: { since?: Date; timeZone?: string } = {},
): Promise<MessagesRead> {
  const files: MessagesFiles = input instanceof Uint8Array ? { db: input } : input;
  const SQL = await sqlJs();
  const { bytes, frames } = applyWal(files.db, files.wal);
  let db: Database;
  try {
    db = new SQL.Database(bytes);
  } catch {
    throw new Error(NOT_MESSAGES);
  }
  try {
    let tables: unknown[];
    try {
      tables = db.exec("select name from sqlite_master where type = 'table'")[0]?.values.flat() ?? [];
    } catch {
      throw new Error(NOT_MESSAGES);
    }
    if (
      !['message', 'handle', 'chat', 'chat_handle_join', 'chat_message_join'].every((t) => tables.includes(t))
    )
      throw new Error(NOT_MESSAGES);
    const cols = new Set(
      (db.exec('pragma table_info(message)')[0]?.values ?? []).map((r) => String(r[1]).toLowerCase()),
    );
    const col = (name: string, fallback: string) => (cols.has(name.toLowerCase()) ? `m.${name}` : fallback);
    // every chat with its members (the other side; the student is not in chat_handle_join)
    const memberRows =
      db.exec(`
      select chj.chat_id, h.ROWID, h.id from chat_handle_join chj join handle h on h.ROWID = chj.handle_id`)[0]
        ?.values ?? [];
    const members = new Map<number, Map<number, string>>();
    for (const [chatId, handleId, handle] of memberRows) {
      const h = String(handle ?? '').trim();
      if (!h) continue;
      const m = members.get(Number(chatId)) ?? new Map<number, string>();
      m.set(Number(handleId), h);
      members.set(Number(chatId), m);
    }
    const ids = db.exec('select ROWID, chat_identifier from chat')[0]?.values ?? [];
    const chatName = new Map(ids.map(([id, ident]) => [Number(id), String(ident ?? id)]));
    let groupChats = 0;
    let largeGroups = 0;
    for (const m of members.values())
      if (m.size > 1) {
        groupChats++;
        if (m.size + 1 > MAX_GROUP) largeGroups++;
      }
    const direct = new Map<string, Acc>();
    const out: Acc[] = [];
    const stmt = db.prepare(`
      select m.date, m.is_from_me, ${col('text', 'null')}, ${col('attributedBody', 'null')},
             ${col('associated_message_type', '0')}, ${col('item_type', '0')}, ${col('handle_id', '0')}
        from message m join chat_message_join cmj on cmj.message_id = m.ROWID
       where cmj.chat_id = ?
       order by m.date`);
    const since = opts.since?.getTime() ?? 0;
    const fresh = (handle: string, chat: string, group: number): Acc => ({
      conv: {
        handle,
        chat,
        group,
        inCount: 0,
        outCount: 0,
        firstAt: '',
        lastAt: '',
        days: [],
        recent: [],
      },
      days: new Map(),
    });
    for (const [chatId, who] of members) {
      const size = who.size + 1;
      if (size > MAX_GROUP) continue;
      const one = size === 2;
      const accs = new Map<number, Acc>();
      if (one) {
        const [, h] = [...who.entries()][0]!;
        let a = direct.get(h);
        if (!a) {
          a = fresh(h, 'direct', 2);
          direct.set(h, a);
          out.push(a);
        }
        for (const id of who.keys()) accs.set(id, a);
      } else {
        const chat = chatName.get(chatId) ?? String(chatId);
        for (const [id, h] of who) {
          const a = fresh(h, chat, size);
          accs.set(id, a);
          out.push(a);
        }
      }
      stmt.bind([chatId]);
      while (stmt.step()) {
        const [date, fromMe, text, body, assoc, item, sender] = stmt.get() as [
          number,
          number,
          string | null,
          Uint8Array | null,
          number | null,
          number | null,
          number | null,
        ];
        const at = appleDate(date);
        if (!at || at.getTime() < since) continue;
        const words = (text ?? textFromAttributedBody(body))?.replace(/￼/g, '').trim() || undefined;
        const kind = messageKind(assoc, item, words);
        if (kind === 'skip') continue;
        const mine = fromMe === 1;
        // the student's message goes to everyone in the chat; theirs to the member who sent it
        const targets = mine
          ? [...new Set(accs.values())]
          : one
            ? [...new Set(accs.values())]
            : accs.has(Number(sender))
              ? [accs.get(Number(sender))!]
              : [];
        const iso = at.toISOString();
        const day = localDay(iso, opts.timeZone);
        for (const a of targets) {
          note(a, day, iso, mine, kind === 'words');
          if (one && kind === 'words') {
            a.conv.recent.push({ at: iso, fromMe: mine, text: words!.slice(0, 500) });
            if (a.conv.recent.length > RECENT_KEPT * 4) a.conv.recent.splice(0, RECENT_KEPT * 2);
          }
        }
      }
      stmt.reset();
    }
    stmt.free();
    const conversations: TextConversation[] = [];
    for (const a of out) {
      if (!a.days.size) continue;
      a.conv.days = [...a.days.values()]
        .map(({ firstInWords, firstOutWords, ...d }) => ({
          ...d,
          firstInAt: firstInWords ?? d.firstInAt,
          firstOutAt: firstOutWords ?? d.firstOutAt,
        }))
        .sort((x, y) => x.day.localeCompare(y.day));
      a.conv.recent = a.conv.recent.sort((x, y) => x.at.localeCompare(y.at)).slice(-RECENT_KEPT);
      conversations.push(a.conv);
    }
    return { conversations, groupChats, largeGroups, walFrames: frames };
  } finally {
    db.close();
  }
}

function note(a: Acc, day: string, iso: string, mine: boolean, words: boolean) {
  const c = a.conv;
  if (words) {
    if (mine) c.outCount++;
    else c.inCount++;
  }
  if (!c.firstAt || iso < c.firstAt) c.firstAt = iso;
  if (!c.lastAt || iso > c.lastAt) c.lastAt = iso;
  const d = a.days.get(day) ?? { day, inCount: 0, outCount: 0, inLight: 0, outLight: 0, firstAt: iso };
  if (iso < d.firstAt) d.firstAt = iso;
  if (mine) {
    if (words) d.outCount++;
    else d.outLight++;
    if (!d.firstOutAt || iso < d.firstOutAt) d.firstOutAt = iso;
    if (words && (!d.firstOutWords || iso < d.firstOutWords)) d.firstOutWords = iso;
  } else {
    if (words) d.inCount++;
    else d.inLight++;
    if (!d.firstInAt || iso < d.firstInAt) d.firstInAt = iso;
    if (words && (!d.firstInWords || iso < d.firstInWords)) d.firstInWords = iso;
  }
  a.days.set(day, d);
}

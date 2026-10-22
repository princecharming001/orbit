/**
 * Reading the Mac's Messages database (~/Library/Messages/chat.db), which the student drops into Orbit. It is opened
 * here in the browser with SQLite compiled to WebAssembly (sql.js, loaded only when an import starts); nothing is
 * uploaded. Only one-to-one conversations are read: group chats say little about any one tie.
 *
 * Per conversation Orbit keeps who it was with (a number or an address), how many messages went each way on which
 * days, and the last few messages for that person's page.
 */
import type { Database, SqlJsStatic } from 'sql.js';

/** Messages are dated in seconds (older Macs) or nanoseconds (newer) since 2001-01-01. */
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
const RECENT_KEPT = 8;

export interface TextConversation {
  /** the other side: +15551234567 or name@icloud.com, as Messages stores it */
  handle: string;
  inCount: number;
  outCount: number;
  firstAt: string;
  lastAt: string;
  /** each day with messages, and how many each way (yyyy-mm-dd) */
  days: { day: string; inCount: number; outCount: number; firstAt: string }[];
  recent: { at: string; fromMe: boolean; text: string }[];
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

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/** Every one-to-one conversation in a Messages database, from `since` on. */
export async function readMessagesDb(
  bytes: Uint8Array,
  opts: { since?: Date } = {},
): Promise<{ conversations: TextConversation[]; groupChats: number }> {
  const SQL = await sqlJs();
  let db: Database;
  try {
    db = new SQL.Database(bytes);
  } catch {
    throw new Error("That file isn't a Messages database. Pick chat.db from your Messages folder.");
  }
  try {
    const tables = db.exec("select name from sqlite_master where type = 'table'")[0]?.values.flat() ?? [];
    if (
      !['message', 'handle', 'chat', 'chat_handle_join', 'chat_message_join'].every((t) => tables.includes(t))
    )
      throw new Error("That file isn't a Messages database. Pick chat.db from your Messages folder.");
    // one-to-one chats: exactly one other person
    const chats =
      db.exec(`
      select c.ROWID, h.id from chat c
        join chat_handle_join chj on chj.chat_id = c.ROWID
        join handle h on h.ROWID = chj.handle_id
       group by c.ROWID having count(*) = 1`)[0]?.values ?? [];
    const groupChats =
      Number(
        db.exec(
          `select count(*) from (select chat_id from chat_handle_join group by chat_id having count(*) > 1)`,
        )[0]?.values[0]?.[0] ?? 0,
      ) || 0;
    const byHandle = new Map<string, TextConversation>();
    const stmt = db.prepare(`
      select m.date, m.is_from_me, m.text, m.attributedBody
        from message m join chat_message_join cmj on cmj.message_id = m.ROWID
       where cmj.chat_id = ? and coalesce(m.associated_message_type, 0) = 0 and coalesce(m.item_type, 0) = 0
       order by m.date`);
    const since = opts.since?.getTime() ?? 0;
    for (const [chatId, handle] of chats) {
      const h = String(handle ?? '').trim();
      if (!h) continue;
      const conv = byHandle.get(h) ?? {
        handle: h,
        inCount: 0,
        outCount: 0,
        firstAt: '',
        lastAt: '',
        days: [],
        recent: [],
      };
      const days = new Map(conv.days.map((d) => [d.day, d]));
      stmt.bind([chatId as number]);
      while (stmt.step()) {
        const [date, fromMe, text, body] = stmt.get() as [number, number, string | null, Uint8Array | null];
        const at = appleDate(date);
        if (!at || at.getTime() < since) continue;
        const iso = at.toISOString();
        const mine = fromMe === 1;
        if (mine) conv.outCount++;
        else conv.inCount++;
        if (!conv.firstAt || iso < conv.firstAt) conv.firstAt = iso;
        if (!conv.lastAt || iso > conv.lastAt) conv.lastAt = iso;
        const day = dayOf(at);
        const d = days.get(day) ?? { day, inCount: 0, outCount: 0, firstAt: iso };
        if (mine) d.outCount++;
        else d.inCount++;
        days.set(day, d);
        const words = (text ?? textFromAttributedBody(body))?.replace(/￼/g, '').trim();
        if (words) {
          conv.recent.push({ at: iso, fromMe: mine, text: words.slice(0, 500) });
          if (conv.recent.length > RECENT_KEPT) conv.recent.shift();
        }
      }
      stmt.reset();
      conv.days = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
      if (conv.inCount + conv.outCount) byHandle.set(h, conv);
    }
    stmt.free();
    return { conversations: [...byHandle.values()], groupChats };
  } finally {
    db.close();
  }
}

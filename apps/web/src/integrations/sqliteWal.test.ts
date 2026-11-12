/**
 * The Messages side file (plan 43 §6): a real database built with sql.js, a write-ahead log made from known pages with
 * SQLite's own checksums, and the newest rows present only when the log is given.
 */
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { readMessagesDb, setSqlJsForTests } from './imessageDb';
import { applyWal, walChecksum } from './sqliteWal';

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
  setSqlJsForTests(Promise.resolve(SQL));
});

const pageSizeOf = (db: Uint8Array) => {
  const n = (db[16]! << 8) | db[17]!;
  return n === 1 ? 65536 : n;
};

interface Txn {
  /** the database before and after this transaction: every page of `to` that differs from `from` is a frame */
  from: Uint8Array;
  to: Uint8Array;
  /** leave the commit mark off the last frame */
  uncommitted?: boolean;
  /** spoil the checksum of this transaction's frame number (0-based) */
  corrupt?: number;
}

/** A WAL file, as SQLite writes it, carrying `txns` in order. */
function buildWal(txns: Txn[], opts: { bigEndian?: boolean; salts?: [number, number] } = {}): Uint8Array {
  const bigEndian = opts.bigEndian ?? false;
  const [salt1, salt2] = opts.salts ?? [0x1234_5678, 0x9abc_def0];
  const pageSize = pageSizeOf(txns[0]!.to);
  const frames: { pgno: number; commit: number; page: Uint8Array; corrupt: boolean }[] = [];
  for (const t of txns) {
    const pages = t.to.length / pageSize;
    const mine: typeof frames = [];
    for (let p = 0; p < pages; p++) {
      const page = t.to.subarray(p * pageSize, (p + 1) * pageSize);
      const old = t.from.subarray(p * pageSize, (p + 1) * pageSize);
      if (old.length === pageSize && old.every((b, i) => b === page[i])) continue;
      mine.push({ pgno: p + 1, commit: 0, page, corrupt: t.corrupt === mine.length });
    }
    if (!t.uncommitted) mine[mine.length - 1]!.commit = pages;
    frames.push(...mine);
  }
  const out = new Uint8Array(32 + frames.length * (24 + pageSize));
  const view = new DataView(out.buffer);
  view.setUint32(0, bigEndian ? 0x377f0683 : 0x377f0682);
  view.setUint32(4, 3007000);
  view.setUint32(8, pageSize);
  view.setUint32(12, 0);
  view.setUint32(16, salt1);
  view.setUint32(20, salt2);
  let [s0, s1] = walChecksum(out.subarray(0, 24), bigEndian);
  view.setUint32(24, s0);
  view.setUint32(28, s1);
  frames.forEach((f, i) => {
    const at = 32 + i * (24 + pageSize);
    view.setUint32(at, f.pgno);
    view.setUint32(at + 4, f.commit);
    view.setUint32(at + 8, salt1);
    view.setUint32(at + 12, salt2);
    out.set(f.page, at + 24);
    [s0, s1] = walChecksum(out.subarray(at, at + 8), bigEndian, s0, s1);
    [s0, s1] = walChecksum(out.subarray(at + 24, at + 24 + pageSize), bigEndian, s0, s1);
    view.setUint32(at + 16, f.corrupt ? s0 ^ 1 : s0);
    view.setUint32(at + 20, s1);
  });
  return out;
}

/** A Messages database in WAL mode, as the Mac keeps it (header versions 2). */
function walMode(bytes: Uint8Array): Uint8Array {
  const b = new Uint8Array(bytes);
  b[18] = 2;
  b[19] = 2;
  return b;
}

const appleNs = (iso: string) => (Date.parse(iso) - Date.UTC(2001, 0, 1)) * 1e6;

function rows(bytes: Uint8Array): string[] {
  const d = new SQL.Database(bytes);
  try {
    return (d.exec('select v from t order by id')[0]?.values ?? []).map((r) => String(r[0]));
  } finally {
    d.close();
  }
}

describe('the write-ahead log, replayed in the browser', () => {
  it('adds the committed pages, and only with the log', () => {
    const d = new SQL.Database();
    d.run('create table t (id integer primary key, v text)');
    for (let i = 0; i < 20; i++) d.run('insert into t (v) values (?)', [`old ${i}`]);
    const base = d.export();
    // enough rows to take new pages, so the database grows
    for (let i = 0; i < 200; i++) d.run('insert into t (v) values (?)', [`new ${i} ${'x'.repeat(40)}`]);
    const after = d.export();
    d.close();
    expect(after.length).toBeGreaterThan(base.length);
    for (const bigEndian of [false, true]) {
      const wal = buildWal([{ from: base, to: after }], { bigEndian });
      const without = applyWal(walMode(base), undefined);
      expect(without.frames).toBe(0);
      expect(rows(without.bytes)).toHaveLength(20);
      const withWal = applyWal(walMode(base), wal);
      expect(withWal.frames).toBeGreaterThan(0);
      expect(withWal.bytes[18]).toBe(1);
      expect(withWal.bytes[19]).toBe(1);
      const got = rows(withWal.bytes);
      expect(got).toHaveLength(220);
      expect(got.at(-1)).toMatch(/^new 199 /);
    }
  });

  it('stops at the first frame whose checksum fails, and ignores what was never committed', () => {
    const d = new SQL.Database();
    d.run('create table t (id integer primary key, v text)');
    d.run("insert into t (v) values ('a')");
    const one = d.export();
    d.run("insert into t (v) values ('b')");
    const two = d.export();
    d.run("insert into t (v) values ('c')");
    const three = d.export();
    d.close();
    const base = walMode(one);
    // the second transaction's checksum is spoilt: the first still counts
    expect(
      rows(
        applyWal(
          base,
          buildWal([
            { from: one, to: two },
            { from: two, to: three, corrupt: 0 },
          ]),
        ).bytes,
      ),
    ).toEqual(['a', 'b']);
    // the second was never committed
    expect(
      rows(
        applyWal(
          base,
          buildWal([
            { from: one, to: two },
            { from: two, to: three, uncommitted: true },
          ]),
        ).bytes,
      ),
    ).toEqual(['a', 'b']);
    // both
    expect(
      rows(
        applyWal(
          base,
          buildWal([
            { from: one, to: two },
            { from: two, to: three },
          ]),
        ).bytes,
      ),
    ).toEqual(['a', 'b', 'c']);
    // a spoilt first frame: nothing from the log
    expect(rows(applyWal(base, buildWal([{ from: one, to: three, corrupt: 0 }])).bytes)).toEqual(['a']);
    // a log left from before (other salts on the frames than the header says) is not this database's
    const stale = buildWal([{ from: one, to: three }]);
    new DataView(stale.buffer).setUint32(16, 1);
    expect(rows(applyWal(base, stale).bytes)).toEqual(['a']);
    // not a log at all
    expect(rows(applyWal(base, new Uint8Array(64)).bytes)).toEqual(['a']);
  });

  it('the newest texts are read only when chat.db-wal is given', async () => {
    const d = new SQL.Database();
    d.run(`
      create table handle (ROWID integer primary key, id text);
      create table chat (ROWID integer primary key, chat_identifier text);
      create table chat_handle_join (chat_id integer, handle_id integer);
      create table chat_message_join (chat_id integer, message_id integer);
      create table message (ROWID integer primary key, date integer, is_from_me integer, text text,
        attributedBody blob, associated_message_type integer default 0, item_type integer default 0,
        handle_id integer);
      insert into handle values (1, '+15551234567');
      insert into chat values (1, 'ana');
      insert into chat_handle_join values (1, 1);
    `);
    const msg = (id: number, iso: string, fromMe: 0 | 1, text: string) => {
      d.run('insert into message (ROWID, date, is_from_me, text, handle_id) values (?, ?, ?, ?, 1)', [
        id,
        appleNs(iso),
        fromMe,
        text,
      ]);
      d.run('insert into chat_message_join values (1, ?)', [id]);
    };
    msg(1, '2026-11-01T15:00:00Z', 1, 'Coffee this week?');
    msg(2, '2026-11-01T16:00:00Z', 0, 'Yes, Thursday');
    const checkpointed = d.export();
    msg(3, '2026-11-11T18:00:00Z', 0, 'Running ten minutes late');
    msg(4, '2026-11-11T18:05:00Z', 1, 'No worries');
    const newest = d.export();
    d.close();
    const wal = buildWal([{ from: checkpointed, to: newest }]);
    const old = await readMessagesDb({ db: walMode(checkpointed) }, { timeZone: 'America/New_York' });
    expect(old.walFrames).toBe(0);
    expect(old.conversations[0]!.lastAt).toBe('2026-11-01T16:00:00.000Z');
    expect(old.conversations[0]!.days.map((x) => x.day)).toEqual(['2026-11-01']);
    const now = await readMessagesDb({ db: walMode(checkpointed), wal }, { timeZone: 'America/New_York' });
    expect(now.walFrames).toBeGreaterThan(0);
    expect(now.conversations[0]!.lastAt).toBe('2026-11-11T18:05:00.000Z');
    expect(now.conversations[0]!.days.map((x) => x.day)).toEqual(['2026-11-01', '2026-11-11']);
    expect(now.conversations[0]!.recent.map((m) => m.text)).toContain('Running ten minutes late');
  });
});

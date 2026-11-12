/**
 * SQLite's write-ahead log, replayed in the browser. Messages keeps its newest messages in chat.db-wal beside chat.db
 * until SQLite folds them in (a checkpoint), so a copy of chat.db alone can miss the last few days. sql.js opens a
 * database from bytes and has no WAL of its own, so the committed pages of the log are written over the database's
 * bytes here first (https://www.sqlite.org/fileformat2.html#walformat).
 *
 * The log is a 32-byte header, then frames: a 24-byte header and one page each. Only frames up to the last commit
 * frame count, only while their salts match the header's and their running checksum holds; the first frame that
 * fails ends the log, as SQLite's own recovery does.
 */

const WAL_HEADER = 32;
const FRAME_HEADER = 24;
const MAGIC_LE = 0x377f0682;
const MAGIC_BE = 0x377f0683;

export interface WalReplay {
  /** the database with the log's committed pages written in, ready for sql.js */
  bytes: Uint8Array;
  /** frames applied (0 when the log was empty, unreadable or held nothing committed) */
  frames: number;
}

/** SQLite's WAL checksum over `data` (a multiple of 8 bytes), continuing from (s0, s1). */
export function walChecksum(data: Uint8Array, bigEndian: boolean, s0 = 0, s1 = 0): [number, number] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let a = s0 >>> 0;
  let b = s1 >>> 0;
  for (let i = 0; i + 8 <= data.byteLength; i += 8) {
    const x0 = view.getUint32(i, !bigEndian);
    const x1 = view.getUint32(i + 4, !bigEndian);
    a = (a + x0 + b) >>> 0;
    b = (b + x1 + a) >>> 0;
  }
  return [a, b];
}

/**
 * The database bytes with the log's committed frames applied, and its header marked as a rollback-journal database
 * (read and write versions 1) so sql.js opens it without looking for a log. A missing, empty or broken log leaves the
 * pages as they were.
 */
export function applyWal(db: Uint8Array, wal: Uint8Array | undefined): WalReplay {
  let out = new Uint8Array(db);
  let frames = 0;
  const pages = wal ? committedPages(wal) : undefined;
  if (pages) {
    const { pageSize, dbPages, writes } = pages;
    const size = dbPages * pageSize;
    if (size > out.length) {
      const grown = new Uint8Array(size);
      grown.set(out);
      out = grown;
    }
    for (const [pgno, page] of writes) {
      const at = (pgno - 1) * pageSize;
      if (at + pageSize > out.length) {
        const grown = new Uint8Array(at + pageSize);
        grown.set(out);
        out = grown;
      }
      out.set(page, at);
      frames++;
    }
    // a commit that shrank the database (a vacuum) leaves the pages past its end unused
    if (dbPages > 0 && size < out.length) out = out.slice(0, size);
  }
  // offsets 18 and 19: the file format's write and read versions, 2 in WAL mode
  if (out.length >= 100) {
    out[18] = 1;
    out[19] = 1;
  }
  return { bytes: out, frames };
}

/** The pages the log's committed transactions wrote, last write of each page winning, or undefined. */
function committedPages(
  wal: Uint8Array,
): { pageSize: number; dbPages: number; writes: Map<number, Uint8Array> } | undefined {
  if (wal.byteLength < WAL_HEADER) return undefined;
  const view = new DataView(wal.buffer, wal.byteOffset, wal.byteLength);
  const magic = view.getUint32(0);
  if (magic !== MAGIC_LE && magic !== MAGIC_BE) return undefined;
  const bigEndian = magic === MAGIC_BE;
  const pageSize = view.getUint32(8);
  // a power of two from 512 to 65536
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) return undefined;
  const salt1 = view.getUint32(16);
  const salt2 = view.getUint32(20);
  let [s0, s1] = walChecksum(wal.subarray(0, 24), bigEndian);
  if (s0 !== view.getUint32(24) || s1 !== view.getUint32(28)) return undefined;
  const pending = new Map<number, Uint8Array>();
  const writes = new Map<number, Uint8Array>();
  let dbPages = 0;
  let committed = false;
  for (let at = WAL_HEADER; at + FRAME_HEADER + pageSize <= wal.byteLength; at += FRAME_HEADER + pageSize) {
    const pgno = view.getUint32(at);
    const commitSize = view.getUint32(at + 4);
    if (pgno === 0) break;
    if (view.getUint32(at + 8) !== salt1 || view.getUint32(at + 12) !== salt2) break;
    const page = wal.subarray(at + FRAME_HEADER, at + FRAME_HEADER + pageSize);
    [s0, s1] = walChecksum(wal.subarray(at, at + 8), bigEndian, s0, s1);
    [s0, s1] = walChecksum(page, bigEndian, s0, s1);
    if (s0 !== view.getUint32(at + 16) || s1 !== view.getUint32(at + 20)) break;
    pending.set(pgno, page);
    if (commitSize > 0) {
      for (const [n, p] of pending) writes.set(n, p);
      pending.clear();
      dbPages = commitSize;
      committed = true;
    }
  }
  return committed ? { pageSize, dbPages, writes } : undefined;
}

/**
 * The one way Orbit's functions reach Postgres (§11.3): postgres.js over SUPABASE_DB_URL with `prepare: false`
 * (the pooler does not keep prepared statements), behind a small `Db` interface so all business logic also runs
 * against PGlite in unit tests.
 *
 * Values always travel as parameters. Arrays become Postgres array literals and plain objects JSON text, so every
 * array or json parameter needs an explicit cast in the SQL (`${tags}::text[]`, `${data}::jsonb`); both adapters
 * then behave the same.
 */
import postgres from 'postgres';

export type Row = Record<string, unknown>;

export interface Db {
  /** A parameterised query: every interpolated value is a parameter, never SQL text. */
  sql<T extends Row = Row>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  /** Dynamic SQL, for table names taken from a fixed allowlist in code. Values still go as parameters. */
  query<T extends Row = Row>(text: string, params?: unknown[]): Promise<T[]>;
  /** Runs fn in a transaction (a savepoint when already inside one). */
  begin<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

/** Template strings → `$1 … $n` text. */
export function toText(strings: TemplateStringsArray): string {
  let text = strings[0] ?? '';
  for (let i = 1; i < strings.length; i++) text += `$${i}${strings[i]}`;
  return text;
}

function arrayLiteral(values: unknown[]): string {
  const items = values.map((v) => {
    if (v === null || v === undefined) return 'NULL';
    if (Array.isArray(v)) return arrayLiteral(v);
    const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });
  return `{${items.join(',')}}`;
}

/** The wire form of one parameter, identical for both adapters. */
export function toParam(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return arrayLiteral(v);
  if (typeof v === 'bigint') return v.toString();
  if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v;
}

// ---- postgres.js ---------------------------------------------------------------------------------------------------

type PgSql = postgres.Sql | postgres.TransactionSql;

function wrapPostgres(sql: PgSql, inTx: boolean): Db {
  const run = async <T extends Row>(text: string, params: unknown[]): Promise<T[]> => {
    const rows = await sql.unsafe(text, params.map(toParam) as postgres.ParameterOrJSON<never>[]);
    return Array.from(rows) as unknown as T[];
  };
  return {
    sql: (strings, ...values) => run(toText(strings), values),
    query: (text, params = []) => run(text, params),
    begin: async (fn) => {
      if (inTx)
        return (await (sql as postgres.TransactionSql).savepoint((tx) =>
          fn(wrapPostgres(tx, true)),
        )) as never;
      return (await (sql as postgres.Sql).begin((tx) => fn(wrapPostgres(tx, true)))) as never;
    },
  };
}

/**
 * `toParam` already sends JSON as text. postgres.js learns from the server that a `${x}::jsonb` parameter is jsonb and
 * runs its own JSON.stringify on it, which stored every object as a JSON string (queue messages without a kind,
 * attendee lists that are not arrays, sync state that grew into an array). Text passes through as it is.
 */
export const pgTypes = {
  json: {
    to: 114,
    from: [114, 3802],
    serialize: (x: unknown) => (typeof x === 'string' ? x : JSON.stringify(x)),
    parse: (x: string) => JSON.parse(x),
  },
};

/** The production database: one small pool per function instance. */
export function connectDb(url: string, max = 4): Db {
  const sql = postgres(url, {
    prepare: false,
    types: pgTypes,
    max,
    // kept open across the app's polls (every 3 to 60 s): a new connection costs TCP, TLS and the password
    // handshake across regions, about 0.6 s, which was most of /sync/status's time with a 20 s idle timeout
    idle_timeout: 240,
    connect_timeout: 10,
    onnotice: () => {},
  });
  return wrapPostgres(sql, false);
}

// ---- PGlite (tests) -------------------------------------------------------------------------------------------------

/** The part of PGlite's API the adapter uses; structural, so this module never imports PGlite. */
export interface PgliteLike {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface PgliteRoot extends PgliteLike {
  transaction<T>(fn: (tx: PgliteLike) => Promise<T>): Promise<T>;
}

let savepoints = 0;

function wrapPglite(pg: PgliteLike, root: PgliteRoot | null): Db {
  const run = async <T extends Row>(text: string, params: unknown[]): Promise<T[]> =>
    (await pg.query<T>(text, params.map(toParam))).rows;
  const db: Db = {
    sql: (strings, ...values) => run(toText(strings), values),
    query: (text, params = []) => run(text, params),
    begin: async (fn) => {
      if (root) return root.transaction((tx) => fn(wrapPglite(tx, null)));
      const name = `sp_${++savepoints}`;
      await pg.query(`savepoint ${name}`);
      try {
        const out = await fn(db);
        await pg.query(`release savepoint ${name}`);
        return out;
      } catch (e) {
        await pg.query(`rollback to savepoint ${name}`);
        throw e;
      }
    },
  };
  return db;
}

/** A `Db` over an in-process PGlite instance, for tests. */
export function pgliteDb(pg: PgliteRoot): Db {
  return wrapPglite(pg, pg);
}

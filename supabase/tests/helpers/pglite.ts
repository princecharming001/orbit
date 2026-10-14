/**
 * A fresh in-process Postgres (PGlite + pgvector) with Orbit's migrations applied over the stub schemas in
 * ../stubs.sql. PGlite has no pgmq, pg_cron or pg_net extension, so those `create extension` lines are removed before
 * a migration runs; everything else in the migrations runs as written.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { type Db, pgliteDb } from '../../functions/_shared/db.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, '../../migrations');
const STUBS = readFileSync(join(here, '../stubs.sql'), 'utf8');

export function migrationSql(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8').replace(
    /create extension if not exists (pgmq|pg_cron|pg_net)\b[^;]*;/gi,
    '',
  );
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

export interface TestDb {
  pg: PGlite;
  db: Db;
}

/** Stubs + every migration in order (or only those named). */
export async function freshDb(files: string[] = migrationFiles()): Promise<TestDb> {
  const pg = await PGlite.create({ extensions: { vector } });
  await pg.exec(STUBS);
  for (const f of files) await pg.exec(migrationSql(f));
  return { pg, db: pgliteDb(pg) };
}

let n = 0;
/** A user row with a unique sub and email. */
export async function makeUser(db: Db, over: { email?: string; settings?: object } = {}): Promise<string> {
  n++;
  const rows = await db.sql<{ id: string }>`
    insert into orbit.users (google_sub, email, full_name, settings)
    values (${`sub-${n}-${Math.random()}`}, ${over.email ?? `user${n}.${Date.now()}@example.com`}, ${`User ${n}`},
            ${over.settings ?? {}}::jsonb)
    returning id`;
  return rows[0]!.id;
}

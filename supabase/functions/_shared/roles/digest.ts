/**
 * The Roles block of the owner's daily cost digest (plan 44 §9.5): for the digest's day, boards read and failed,
 * roles added and closed, discovery requests and refusals, whether each SimplifyJobs list was read, and the boards
 * that have failed three reads in a row (one a day) by name. Read from the day's `src:` counts in roles_usage.
 */
import type { Db } from '../db.ts';
import { FAILURES_TO_STOP } from './boards.ts';

export interface RolesDigest {
  boardsRead: number;
  boardsFailed: number;
  boardsTooLarge: number;
  boardsHarvested: number;
  rolesAdded: number;
  rolesClosed: number;
  rolesDeleted: number;
  textsRead: number;
  discovery: { companies: number; requests: number; refused: number; found: number };
  simplify: { intern: boolean; newgrad: boolean; listings: number };
  /** now: boards by status, and open roles shown */
  boards: { active: number; empty: number; gone: number; refused: number };
  openRoles: number;
  /** boards whose last three reads (three days) failed */
  failing: { name: string; service: string; token: string; failures: number; error: string | null }[];
  /** Ashby boards too large to read in the worker */
  tooLarge: { name: string; token: string; bytes: number | null }[];
}

export async function rolesDigest(db: Db, day: string): Promise<RolesDigest | null> {
  const [t] = await db.sql<{ ok: boolean }>`select to_regclass('orbit_private.job_boards') is not null as ok`;
  if (!t?.ok) return null;
  const rows = await db.sql<{ kind: string; n: number }>`
    select kind, n from orbit_private.roles_usage where day = ${day}::date and kind like 'src:%'`;
  const n = (k: string) => Number(rows.find((r) => r.kind === `src:${k}`)?.n ?? 0);
  const status = await db.sql<{ status: string; n: number }>`
    select status, count(*)::int as n from orbit_private.job_boards group by status`;
  const s = (k: string) => Number(status.find((r) => r.status === k)?.n ?? 0);
  const [open] = await db.sql<{ n: number }>`
    select count(*)::int as n from orbit_private.jobs where closed_at is null and dupe_of is null`;
  const failing = await db.sql<{
    name: string | null;
    service: string;
    token: string;
    failures: number;
    last_error: string | null;
  }>`
    select company_name as name, service, token, failures, last_error from orbit_private.job_boards
     where failures >= ${FAILURES_TO_STOP}::int
     order by failures desc, company_name limit 25`;
  const large = await db.sql<{ name: string | null; token: string; bytes: number | null }>`
    select company_name as name, token, last_size_bytes as bytes from orbit_private.job_boards
     where last_error like 'too_large%' order by last_size_bytes desc nulls last limit 25`;
  return {
    boardsRead: n('boards_read'),
    boardsFailed: n('boards_failed'),
    boardsTooLarge: n('boards_too_large'),
    boardsHarvested: n('boards_harvested'),
    rolesAdded: n('roles_added'),
    rolesClosed: n('roles_closed'),
    rolesDeleted: n('roles_deleted'),
    textsRead: n('texts_read'),
    discovery: {
      companies: n('discovery_companies'),
      requests: n('discovery_requests'),
      refused: n('discovery_refused'),
      found: n('discovery_found'),
    },
    simplify: {
      intern: n('simplify_intern_done') > 0,
      newgrad: n('simplify_newgrad_done') > 0,
      listings: n('simplify_listings'),
    },
    boards: { active: s('active'), empty: s('empty'), gone: s('gone'), refused: s('refused') },
    openRoles: Number(open?.n ?? 0),
    failing: failing.map((f) => ({
      name: f.name ?? f.token,
      service: f.service,
      token: f.token,
      failures: Number(f.failures),
      error: f.last_error,
    })),
    tooLarge: large.map((b) => ({
      name: b.name ?? b.token,
      token: b.token,
      bytes: b.bytes == null ? null : Number(b.bytes),
    })),
  };
}

/** The digest's lines for Roles: plain text, numbers first. */
export function rolesDigestLines(r: RolesDigest): string[] {
  const lines = [
    '',
    'Roles:',
    `- Boards read: ${r.boardsRead}, failed: ${r.boardsFailed}, too large for the worker: ${r.boardsTooLarge}. New boards from SimplifyJobs links: ${r.boardsHarvested}.`,
    `- Roles added: ${r.rolesAdded}, closed: ${r.rolesClosed}, deleted after 60 days: ${r.rolesDeleted}. Texts read: ${r.textsRead}. Open roles now: ${r.openRoles}.`,
    `- Discovery: ${r.discovery.companies} companies, ${r.discovery.requests} requests, ${r.discovery.refused} refused, ${r.discovery.found} boards found.`,
    `- SimplifyJobs: internships ${r.simplify.intern ? 'read' : 'not read'}, new grad ${r.simplify.newgrad ? 'read' : 'not read'} (${r.simplify.listings} listings).`,
    `- Boards now: ${r.boards.active} active, ${r.boards.empty} empty, ${r.boards.gone} gone, ${r.boards.refused} refused.`,
  ];
  if (r.failing.length)
    lines.push(
      `- Failing three days running: ${r.failing.map((f) => `${f.name} (${f.service}, ${f.error ?? 'no error kept'})`).join('; ')}.`,
    );
  if (r.tooLarge.length)
    lines.push(
      `- Skipped as too large: ${r.tooLarge.map((b) => `${b.name} (${b.bytes ? `${(b.bytes / 1e6).toFixed(1)} MB` : 'size unknown'})`).join('; ')}.`,
    );
  return lines;
}

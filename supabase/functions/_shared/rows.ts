/**
 * Small helpers for rows as the database adapters return them: timestamps arrive as Date objects (postgres.js and
 * PGlite both parse timestamptz) and numerics as strings or numbers. The core mappers want ISO strings.
 */

/** An ISO string for a timestamp column value, or null. */
export function iso(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The row with every Date value turned into an ISO string (for the core `*FromRow` mappers). */
export function isoRow<T extends Record<string, unknown>>(r: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) out[k] = v instanceof Date ? v.toISOString() : v;
  return out as T;
}

export const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** A vector parameter for pgvector (`${vec(e)}::vector`). */
export const vec = (e: number[]): string => `[${e.map((x) => (Number.isFinite(x) ? x : 0)).join(',')}]`;

/** First name for prompts and templates: the stored one, else the first word of the display name. */
export function firstNameOf(p: { first_name?: unknown; display_name?: unknown }): string {
  const f = typeof p.first_name === 'string' && p.first_name.trim() ? p.first_name.trim() : '';
  if (f) return f;
  const d = typeof p.display_name === 'string' ? p.display_name.trim() : '';
  return d.split(/\s+/)[0] || 'there';
}

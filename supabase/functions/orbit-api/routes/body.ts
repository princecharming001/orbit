/** Request-body checks shared by the agent routes: a JSON object, then typed fields or a 400. */
import type { ChatTurn } from '@orbit/core/server/api';
import { badRequest, readJson } from '../../_shared/http.ts';
import type { Ctx } from '../api.ts';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function body(ctx: Ctx, optional = false): Promise<Record<string, unknown>> {
  return readJson(ctx.req, { optional });
}

export function uuid(b: Record<string, unknown>, key: string): string {
  const v = b[key];
  if (typeof v !== 'string' || !UUID.test(v)) throw badRequest(`${key} is required`);
  return v;
}

export function optUuid(b: Record<string, unknown>, key: string): string | undefined {
  const v = b[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !UUID.test(v)) throw badRequest(`${key} must be an id`);
  return v;
}

export function text(b: Record<string, unknown>, key: string, max = 2000): string {
  const v = b[key];
  if (typeof v !== 'string' || !v.trim()) throw badRequest(`${key} is required`);
  if (v.length > max) throw badRequest(`${key} is too long`);
  return v.trim();
}

export const MAX_TURNS = 6;
export const MAX_TURN_CHARS = 8000;

/** The chat turns the post-turn passes read: at most 6, 8,000 characters in all, each a user or assistant text. */
export function turns(b: Record<string, unknown>): ChatTurn[] {
  const v = b.turns;
  if (!Array.isArray(v) || !v.length) throw badRequest('turns is required');
  if (v.length > MAX_TURNS) throw badRequest(`at most ${MAX_TURNS} turns`);
  let chars = 0;
  const out = v.map((t): ChatTurn => {
    const r = t as { role?: unknown; text?: unknown } | null;
    if (!r || (r.role !== 'user' && r.role !== 'assistant') || typeof r.text !== 'string')
      throw badRequest('each turn is {role: user|assistant, text}');
    chars += r.text.length;
    return { role: r.role, text: r.text };
  });
  if (chars > MAX_TURN_CHARS) throw badRequest(`turns are at most ${MAX_TURN_CHARS} characters in all`);
  return out;
}

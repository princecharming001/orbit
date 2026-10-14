/** Request-body checks shared by the agent routes: a JSON object, then typed fields or a 400. */
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

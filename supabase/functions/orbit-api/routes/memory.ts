/**
 * Memory (§10):
 *   POST /memory/search {query, personId?, limit?}  → memories ranked 0.7·cosine + 0.2·importance + 0.1·recency
 *   POST /memory/add {text, kind, personId?}        → {memory, deduped}
 *   POST /memory/list {personId?}                   → {memories}
 *   POST /memory/forget {id}                        → {ok}
 */
import type { MemoryKind } from '@orbit/core/server/api';
import { HttpError, json } from '../../_shared/http.ts';
import { addMemory, forgetMemory, listMemories, searchMemories } from '../../_shared/memory/memory.ts';
import type { Ctx, Route } from '../api.ts';
import { body, optUuid, text, uuid } from './body.ts';

async function search(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  const s = ctx.services();
  const memories = await searchMemories(
    ctx.db,
    s.embed,
    ctx.userId!,
    {
      query: text(b, 'query', 1000),
      personId: optUuid(b, 'personId'),
      limit: typeof b.limit === 'number' ? b.limit : undefined,
    },
    ctx.now(),
  );
  return json(200, { memories });
}

async function add(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  const s = ctx.services();
  const r = await addMemory(
    ctx.db,
    s.embed,
    ctx.userId!,
    {
      text: text(b, 'text', 1000),
      kind: b.kind as MemoryKind,
      personId: optUuid(b, 'personId'),
      source: 'remember',
    },
    ctx.now(),
  );
  return json(200, r);
}

async function list(ctx: Ctx): Promise<Response> {
  const b = await body(ctx, true);
  return json(200, { memories: await listMemories(ctx.db, ctx.userId!, optUuid(b, 'personId')) });
}

async function forget(ctx: Ctx): Promise<Response> {
  const id = uuid(await body(ctx), 'id');
  if (!(await forgetMemory(ctx.db, ctx.userId!, id, ctx.now())))
    throw new HttpError(404, 'not_found', 'no such memory');
  return json(200, { ok: true });
}

export const memoryRoutes: Record<string, Route> = {
  '/memory/search': { method: 'POST', auth: true, run: search },
  '/memory/add': { method: 'POST', auth: true, run: add },
  '/memory/list': { method: 'POST', auth: true, run: list },
  '/memory/forget': { method: 'POST', auth: true, run: forget },
};

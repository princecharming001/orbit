/**
 * Memory (§10):
 *   POST /memory/search {query, personId?, limit?}  → memories ranked 0.7·cosine + 0.2·importance + 0.1·recency
 *   POST /memory/add {text, kind, personId?}        → {memory, deduped}
 *   POST /memory/list {personId?}                   → {memories}
 *   POST /memory/forget {id}                        → {ok}
 *   POST /memory/extract {turns}                    → {memories, added}: the §10.6 pass over the last chat turns,
 *        each memory found added with source 'chat' (deduped); {memories: [], added: 0, unconfigured} without Claude
 */
import type { MemoryExtractResponse, MemoryItem, MemoryKind } from '@orbit/core/server/api';
import type { Db } from '../../_shared/db.ts';
import { HttpError, json } from '../../_shared/http.ts';
import {
  addMemory,
  extractMemories,
  forgetMemory,
  listMemories,
  searchMemories,
} from '../../_shared/memory/memory.ts';
import type { Ctx, Route } from '../api.ts';
import { body, optUuid, text, turns, uuid } from './body.ts';

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

/** How many kept memories the extraction is told about, so it does not find them again. */
export const KNOWN_MEMORIES = 20;

/** The one person a memory names, by exact name; null when no one or several people have it. */
async function personNamed(db: Db, userId: string, name: string | null): Promise<string | null> {
  const n = name?.trim().toLowerCase();
  if (!n) return null;
  const rows = await db.sql<{ id: string }>`
    select id from orbit.people
     where user_id = ${userId}::uuid and deleted_at is null and merged_into is null and not is_self
       and lower(display_name) = ${n}
     limit 2`;
  return rows.length === 1 ? rows[0]!.id : null;
}

async function extract(ctx: Ctx): Promise<Response> {
  const t = turns(await body(ctx));
  const s = ctx.services();
  const userId = ctx.userId!;
  if (!s.claude.configured) {
    const out: MemoryExtractResponse = { memories: [], added: 0, unconfigured: true };
    return json(200, out);
  }
  const known = await ctx.db.sql<{ text: string }>`
    select text from orbit.memories where user_id = ${userId}::uuid and deleted_at is null
     order by importance desc, last_seen_at desc limit ${KNOWN_MEMORIES}::int`;
  const found = await extractMemories(
    s.claude,
    userId,
    t,
    known.map((k) => k.text),
  );
  const memories: MemoryItem[] = [];
  let added = 0;
  for (const m of found) {
    const r = await addMemory(
      ctx.db,
      s.embed,
      userId,
      {
        text: m.text,
        kind: m.kind,
        personId: await personNamed(ctx.db, userId, m.personName),
        importance: m.importance,
        source: 'chat',
        quote: m.quote,
      },
      ctx.now(),
    );
    memories.push(r.memory);
    if (!r.deduped) added++;
  }
  const out: MemoryExtractResponse = { memories, added };
  return json(200, out);
}

export const memoryRoutes: Record<string, Route> = {
  '/memory/search': { method: 'POST', auth: true, run: search },
  '/memory/add': { method: 'POST', auth: true, run: add },
  '/memory/list': { method: 'POST', auth: true, run: list },
  '/memory/forget': { method: 'POST', auth: true, run: forget },
  '/memory/extract': { method: 'POST', auth: true, run: extract },
};

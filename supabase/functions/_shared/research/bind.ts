/**
 * The research, sourcing and path dependency interfaces (deps.ts) bound to the real modules: Claude through
 * claude.ts (which checks the Claude caps and records its own usage), the per-user caps of budget.ts over
 * orbit.usage_ledger, orbit.research_cache, orbit.dossiers and the internal history in orbit.messages, notes, facts
 * and calendar events.
 */
import { stripQuotedReply } from '@orbit/core/text/email';
import { checkBudget, recordUsage, type Spend } from '../budget.ts';
import type { Claude } from '../claude.ts';
import type { Db } from '../db.ts';
import { VILLAGE_USD_PER_CREDIT } from '../providers/village';
import { iso, num } from '../rows.ts';
import type {
  BudgetDep,
  BudgetProvider,
  CacheDep,
  ClaudeDep,
  DossierRow,
  InternalHistory,
  ResearchDb,
} from './deps';

/** Orbit's own limit on LinkedIn searches (§6.5): at most this many per user per day. */
export const UNIPILE_SEARCHES_PER_DAY = 10;

/** How each deps.ts provider is named in usage_ledger and budget.ts. */
function ledgerName(p: BudgetProvider, operation?: string): { provider: string; operation: string } {
  switch (p) {
    case 'claude':
      return { provider: 'anthropic', operation: operation ?? 'call' };
    case 'apollo_match':
      return { provider: 'apollo', operation: 'match' };
    case 'unipile_profile':
      return { provider: 'unipile', operation: 'profile_view' };
    case 'unipile_search':
      return { provider: 'unipile', operation: 'search' };
    default:
      return { provider: p, operation: operation ?? 'call' };
  }
}

function spendOf(p: BudgetProvider, estimate: number): Spend {
  const { provider, operation } = ledgerName(p);
  switch (p) {
    case 'claude':
    case 'exa':
      return { provider, operation, costUsd: estimate };
    case 'village':
      return { provider, operation, units: estimate, costUsd: estimate * VILLAGE_USD_PER_CREDIT };
    default:
      return { provider, operation, units: estimate };
  }
}

export function sqlBudget(db: Db, now: () => Date): BudgetDep {
  return {
    async check(userId, p, estimate) {
      const v = await checkBudget(db, userId, spendOf(p, estimate), now());
      if (!v.ok) return { ok: false, reason: 'budget_exceeded', resetsAt: v.resetsAt };
      if (p === 'unipile_search') {
        const day = new Date(Date.UTC(now().getUTCFullYear(), now().getUTCMonth(), now().getUTCDate()));
        const [r] = await db.sql<{ n: number }>`
          select count(*)::int as n from orbit.usage_ledger
           where user_id = ${userId}::uuid and provider = 'unipile' and operation = 'search'
             and created_at >= ${day}::timestamptz`;
        if ((r?.n ?? 0) >= UNIPILE_SEARCHES_PER_DAY)
          return {
            ok: false,
            reason: 'budget_exceeded',
            resetsAt: new Date(day.getTime() + 86_400_000).toISOString(),
          };
      }
      return { ok: true };
    },
    async record(userId, e) {
      const { provider, operation } = ledgerName(e.provider, e.operation);
      await recordUsage(db, { userId, provider, operation, units: e.units, costUsd: e.costUsd });
    },
  };
}

export function sqlCache(db: Db, now: () => Date): CacheDep {
  return {
    async get(userId, key) {
      const [r] = await db.sql<{ response: unknown }>`
        select response from orbit.research_cache
         where user_id = ${userId}::uuid and key = ${key} and expires_at > ${now()}::timestamptz`;
      return r?.response;
    },
    async put(userId, e) {
      await db.sql`
        insert into orbit.research_cache (user_id, key, provider, response, created_at, expires_at)
        values (${userId}::uuid, ${e.key}, ${e.provider}, ${JSON.stringify(e.response)}::jsonb, ${now()}::timestamptz,
                ${e.expiresAt}::timestamptz)
        on conflict (user_id, key) do update set
          provider = excluded.provider, response = excluded.response,
          created_at = excluded.created_at, expires_at = excluded.expires_at`;
    },
  };
}

export function sqlResearchDb(db: Db, now: () => Date): ResearchDb {
  const cache = sqlCache(db, now);
  return {
    ...cache,
    internalHistory: (userId, personId) => internalHistory(db, userId, personId),
    async getDossier(userId, personId) {
      const [r] = await db.sql<Record<string, unknown>>`
        select * from orbit.dossiers where user_id = ${userId}::uuid and person_id = ${personId}::uuid`;
      if (!r) return null;
      return {
        user_id: r.user_id as string,
        person_id: r.person_id as string,
        goal_id: (r.goal_id as string | null) ?? null,
        status: r.status as DossierRow['status'],
        content: r.content ?? null,
        sources: (r.sources as unknown[]) ?? [],
        candidates: (r.candidates as unknown[] | null) ?? null,
        cost_usd: num(r.cost_usd),
        model: (r.model as string | null) ?? null,
        prompt_version: (r.prompt_version as string | null) ?? null,
        error: (r.error as string | null) ?? null,
        created_at: iso(r.created_at)!,
        updated_at: iso(r.updated_at)!,
        expires_at: iso(r.expires_at)!,
      };
    },
    async putDossier(row) {
      await db.sql`
        insert into orbit.dossiers (user_id, person_id, goal_id, status, content, sources, candidates, cost_usd,
                                    model, prompt_version, error, created_at, expires_at)
        values (${row.user_id}::uuid, ${row.person_id}::uuid, ${row.goal_id}::uuid, ${row.status},
                ${row.content === null ? null : JSON.stringify(row.content)}::jsonb, ${JSON.stringify(row.sources)}::jsonb,
                ${row.candidates === null ? null : JSON.stringify(row.candidates)}::jsonb, ${row.cost_usd}::numeric,
                ${row.model}, ${row.prompt_version}, ${row.error}, ${row.created_at}::timestamptz,
                ${row.expires_at}::timestamptz)
        on conflict (user_id, person_id) do update set
          goal_id = excluded.goal_id, status = excluded.status, content = excluded.content,
          sources = excluded.sources, candidates = excluded.candidates, cost_usd = excluded.cost_usd,
          model = excluded.model, prompt_version = excluded.prompt_version, error = excluded.error,
          created_at = excluded.created_at, expires_at = excluded.expires_at`;
    },
  };
}

/** The last 20 messages with the person (quotes stripped), notes, facts and meetings: research step 1. */
export async function internalHistory(db: Db, userId: string, personId: string): Promise<InternalHistory> {
  const msgs = await db.sql<{
    sent_at: Date;
    direction: 'in' | 'out';
    subject: string | null;
    body_text: string | null;
    snippet: string | null;
  }>`
    select sent_at, direction, subject, body_text, snippet from orbit.messages
     where user_id = ${userId}::uuid
       and (from_person_id = ${personId}::uuid or ${personId}::uuid = any(to_person_ids))
     order by sent_at desc limit 20`;
  const [span] = await db.sql<{ first: Date | null; last: Date | null }>`
    select min(sent_at) as first, max(sent_at) as last from orbit.messages
     where user_id = ${userId}::uuid
       and (from_person_id = ${personId}::uuid or ${personId}::uuid = any(to_person_ids))`;
  const notes = await db.sql<{ occurred_at: Date; raw_text: string }>`
    select occurred_at, raw_text from orbit.notes
     where user_id = ${userId}::uuid and ${personId}::uuid = any(person_ids)
     order by occurred_at desc limit 10`;
  const facts = await db.sql<{ type: string; text: string }>`
    select type, text from orbit.facts
     where user_id = ${userId}::uuid and person_id = ${personId}::uuid and deleted_at is null
     order by created_at desc limit 20`;
  const events = await db.sql<{ start_at: Date; title: string | null }>`
    select start_at, title from orbit.calendar_events
     where user_id = ${userId}::uuid and ${personId}::uuid = any(attendee_person_ids)
     order by start_at desc limit 10`;
  return {
    messages: msgs.reverse().map((m) => ({
      at: iso(m.sent_at)!,
      direction: m.direction === 'in' ? 'inbound' : 'outbound',
      subject: m.subject ?? undefined,
      body: stripQuotedReply(m.body_text ?? m.snippet ?? '').slice(0, 2000),
    })),
    notes: notes.map((n) => ({ at: iso(n.occurred_at)!, text: n.raw_text.slice(0, 2000) })),
    facts: facts.map((f) => ({ type: f.type, text: f.text })),
    events: events.map((e) => ({ at: iso(e.start_at)!, title: e.title ?? 'Meeting' })),
    firstContact: iso(span?.first),
    lastContact: iso(span?.last),
  };
}

/** deps.ts's ClaudeDep over claude.ts: `dossier` → Opus 5.5, `sourcing_fit` → Haiku 5.5 (task `fit`). */
export function claudeDep(claude: Claude, userId: string): ClaudeDep {
  return {
    async parse(task, schema, prompt) {
      const r = await claude.structured({
        task: task === 'dossier' ? 'dossier' : 'fit',
        system: prompt.system,
        user: prompt.user,
        schema,
        userId,
      });
      if (r.ok) return { ok: true, value: r.data, costUsd: r.costUsd, model: r.model };
      if ('unconfigured' in r) return { ok: false, reason: 'error', message: 'unconfigured' };
      if ('budgetExceeded' in r) return { ok: false, reason: 'budget_exceeded', message: r.cap };
      if ('refused' in r) return { ok: false, reason: 'refusal' };
      return { ok: false, reason: r.error === 'max_tokens' ? 'max_tokens' : 'error', message: r.error };
    },
  };
}

/**
 * company_facts_sync (plan 32 §6.1): YC's company directory, as yc-oss publishes it (yc-oss/api, a nightly mirror of
 * the public directory, MIT), into orbit_private.company_facts. One job for everyone, nightly; a fetch that fails or
 * comes back implausibly small changes nothing, so a bad night never empties the table.
 *
 * What is kept per company: its normalised key and name, former names, website, LinkedIn handle when the directory
 * gives one, the canonical batch (W26, S25, F24, X25), status, stage, team size, industries and tags, the one-liner,
 * and whether the bare name is an everyday word (a match on it is weak, see core companies.ts matchFacts).
 */
import { YC_OSS_URL, type YcOssCompany, ycOssFact } from '@orbit/core/search/ycoss';
import type { CompanyFactWire } from '@orbit/core/server/api';
import type { Db } from '../db.ts';

export { YC_OSS_URL };
/** The directory has had 5,000+ companies for years: fewer means a broken fetch, not a smaller YC. */
export const MIN_COMPANIES = 3_000;
const BATCH_ROWS = 500;

export interface FactRow {
  sourceId: string;
  key: string;
  name: string;
  formerNames: string[];
  website: string | null;
  ycBatch: string | null;
  ycStatus: string | null;
  ycStage: string | null;
  teamSize: number | null;
  industries: string[];
  oneLiner: string | null;
  ambiguousName: boolean;
}

/** One directory entry as a row, or undefined when it has no usable name or id. */
export function factRow(c: YcOssCompany): FactRow | undefined {
  const f = c.id == null ? undefined : ycOssFact(c);
  if (!f) return undefined;
  return {
    sourceId: String(c.id),
    key: f.key,
    name: f.name,
    formerNames: f.formerNames ?? [],
    website: f.website ?? null,
    ycBatch: f.ycBatch ?? null,
    ycStatus: f.ycStatus ?? null,
    ycStage: f.ycStage ?? null,
    teamSize: f.teamSize ?? null,
    industries: f.industries ?? [],
    oneLiner: f.oneLiner ?? null,
    ambiguousName: !!f.ambiguousName,
  };
}

export interface SyncResult {
  fetched: number;
  written: number;
  skipped?: 'fetch_failed' | 'too_small';
}

export async function syncCompanyFacts(db: Db, doFetch: typeof fetch, now: Date): Promise<SyncResult> {
  let list: YcOssCompany[];
  try {
    const res = await doFetch(YC_OSS_URL, {
      headers: { accept: 'application/json', 'user-agent': 'Orbit/1.0' },
    });
    if (!res.ok) return { fetched: 0, written: 0, skipped: 'fetch_failed' };
    const body = (await res.json()) as unknown;
    list = Array.isArray(body) ? (body as YcOssCompany[]) : [];
  } catch {
    return { fetched: 0, written: 0, skipped: 'fetch_failed' };
  }
  if (list.length < MIN_COMPANIES) return { fetched: list.length, written: 0, skipped: 'too_small' };
  const rows = list.map(factRow).filter((r): r is FactRow => !!r);
  const asOf = now.toISOString().slice(0, 10);
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH_ROWS) {
    const part = rows.slice(i, i + BATCH_ROWS);
    // arrays of arrays do not travel as parameters, so list-valued columns go as JSON text and are unpacked in SQL
    await db.sql`
      insert into orbit_private.company_facts (source, source_id, key, name, former_names, website, yc_batch, yc_status,
        yc_stage, team_size, industries, one_liner, ambiguous_name, as_of, updated_at)
      select 'yc', r.source_id, r.key, r.name,
             array(select jsonb_array_elements_text(r.former_names)), r.website, r.yc_batch, r.yc_status, r.yc_stage,
             r.team_size, array(select jsonb_array_elements_text(r.industries)), r.one_liner, r.ambiguous_name,
             ${asOf}::date, now()
        from jsonb_to_recordset(${JSON.stringify(
          part.map((r) => ({
            source_id: r.sourceId,
            key: r.key,
            name: r.name,
            former_names: r.formerNames,
            website: r.website,
            yc_batch: r.ycBatch,
            yc_status: r.ycStatus,
            yc_stage: r.ycStage,
            team_size: r.teamSize,
            industries: r.industries,
            one_liner: r.oneLiner,
            ambiguous_name: r.ambiguousName,
          })),
        )}::jsonb) as r(source_id text, key text, name text, former_names jsonb, website text, yc_batch text,
             yc_status text, yc_stage text, team_size int, industries jsonb, one_liner text, ambiguous_name boolean)
      on conflict (source, source_id) do update set
        key = excluded.key, name = excluded.name, former_names = excluded.former_names, website = excluded.website,
        yc_batch = excluded.yc_batch, yc_status = excluded.yc_status, yc_stage = excluded.yc_stage,
        team_size = excluded.team_size, industries = excluded.industries, one_liner = excluded.one_liner,
        ambiguous_name = excluded.ambiguous_name, as_of = excluded.as_of, updated_at = now()
      -- unchanged companies keep their updated_at, so the browser's incremental pull stays small
      where (company_facts.key, company_facts.name, company_facts.former_names, company_facts.website,
             company_facts.yc_batch, company_facts.yc_status, company_facts.yc_stage, company_facts.team_size,
             company_facts.industries, company_facts.one_liner, company_facts.ambiguous_name)
        is distinct from (excluded.key, excluded.name, excluded.former_names, excluded.website, excluded.yc_batch,
             excluded.yc_status, excluded.yc_stage, excluded.team_size, excluded.industries, excluded.one_liner,
             excluded.ambiguous_name)`;
    written += part.length;
  }
  return { fetched: list.length, written };
}

export async function loadCompanyFacts(
  db: Db,
  since?: string,
): Promise<{ facts: CompanyFactWire[]; at: string }> {
  const rows = await db.sql<{
    key: string;
    name: string;
    former_names: string[];
    website: string | null;
    yc_batch: string | null;
    team_size: number | null;
    industries: string[];
    one_liner: string | null;
    ambiguous_name: boolean;
    source: CompanyFactWire['source'];
    yc_status: CompanyFactWire['ycStatus'] | null;
    yc_stage: CompanyFactWire['ycStage'] | null;
    as_of: string | null;
    updated_at: string;
    linkedin_id: string | null;
    linkedin_handle: string | null;
    founded_year: number | null;
    growth_12m: number | null;
    stage: CompanyFactWire['stage'] | null;
    stage_evidence: string | null;
    kind: CompanyFactWire['kind'] | null;
    about: string | null;
  }>`
    select key, name, former_names, website, yc_batch, yc_status, yc_stage, team_size, industries, one_liner,
           ambiguous_name, source, as_of::text as as_of, updated_at::text as updated_at, linkedin_id,
           linkedin_handle, founded_year, growth_12m, stage, stage_evidence, kind, about
      from orbit_private.company_facts
     where ${since ?? null}::timestamptz is null or updated_at > ${since ?? null}::timestamptz
     order by updated_at`;
  let at = since ?? new Date(0).toISOString();
  const facts = rows.map((r) => {
    if (r.updated_at > at) at = r.updated_at;
    const f: CompanyFactWire = { key: r.key, name: r.name, source: r.source };
    if (r.former_names?.length) f.formerNames = r.former_names;
    if (r.website) f.website = r.website;
    if (r.yc_batch) f.ycBatch = r.yc_batch;
    if (r.yc_status) f.ycStatus = r.yc_status;
    if (r.yc_stage) f.ycStage = r.yc_stage;
    if (r.team_size != null) f.teamSize = r.team_size;
    if (r.industries?.length) f.industries = r.industries;
    if (r.one_liner) f.oneLiner = r.one_liner;
    if (r.ambiguous_name) f.ambiguousName = true;
    if (r.as_of) f.asOf = r.as_of;
    if (r.linkedin_id) f.linkedinId = r.linkedin_id;
    if (r.linkedin_handle) f.linkedinHandle = r.linkedin_handle;
    if (r.founded_year) f.foundedYear = r.founded_year;
    if (r.growth_12m != null) f.growth12m = r.growth_12m;
    if (r.stage) {
      f.stage = r.stage;
      if (r.stage_evidence) f.stageEvidence = r.stage_evidence;
    }
    if (r.kind) f.kind = r.kind;
    if (r.about) f.about = r.about;
    return f;
  });
  return { facts, at };
}

-- YC founder lists (plan 33 follow-up): who YC's own company page names as each company's founders, so "YC founders"
-- does not rest on titles alone (a CTO at a three-person W26 company is listed there as Founder/CTO). Additive only.
alter table orbit_private.company_facts
  add column if not exists yc_slug text,
  add column if not exists founders jsonb,
  add column if not exists founders_at timestamptz;

create index if not exists company_facts_founders_due
  on orbit_private.company_facts (founders_at nulls first)
  where source = 'yc' and yc_slug is not null;

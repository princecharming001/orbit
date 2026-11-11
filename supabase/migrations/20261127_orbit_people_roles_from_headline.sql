-- Titles and companies from headlines already held (the LinkedIn sync read only "Title at Company" before the first bar,
-- so most connections had no title, no company and no logo).
--   people.roles_from_headline_at  when the current headline reader last read this row: the sync fills a batch of
--                                  people with neither a title nor a company from their stored headline, and a row is
--                                  read once by each version of the reader, not every pass.
--   touch_updated_at               leaves this bookkeeping column out too, so marking rows as read sends nothing to
--                                  the browser; a title or company filled in does.
-- Additive only: one nullable column and a replaced function every existing trigger keeps calling by name.

alter table orbit.people add column if not exists roles_from_headline_at timestamptz;

create or replace function orbit.touch_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (to_jsonb(new) - 'updated_at' - 'scored_at' - 'roles_from_headline_at')
     = (to_jsonb(old) - 'updated_at' - 'scored_at' - 'roles_from_headline_at') then
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;
  return new;
end
$$;

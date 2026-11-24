-- Marketers set aside. People who only ever pitched the student, and whom the student never answered, are hidden
-- like anyone the student hides by hand (orbit.people.hidden_at), with the reason kept so the app can say why and
-- so someone the student brings back is never set aside again.
--
--   hidden_reason  'marketer': Orbit hid them (functions/_shared/ingest/marketers.ts)
--                  'kept':     the student brought them back; the sweep leaves them alone for good
--                  null:       not hidden, or hidden by the student's own hand
-- Additive: one nullable column.

alter table orbit.people add column if not exists hidden_reason text
  check (hidden_reason is null or hidden_reason in ('marketer', 'kept'));
comment on column orbit.people.hidden_reason is
  'why Orbit hid this person (marketer), or that the student brought them back (kept); null when hidden by hand';

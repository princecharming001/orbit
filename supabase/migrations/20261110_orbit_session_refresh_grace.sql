-- Refresh tokens survive a lost or repeated refresh (sign-out fix, 2026-11-08). Each new refresh token is derived from
-- the one it replaces, and the replaced one stays redeemable for a few days, giving back the same new token. Before
-- this, a refresh answer that never reached the browser (a closed tab, a sleeping laptop, two tabs at once) ended the
-- session. Additive only.
alter table orbit.sessions
  add column if not exists prev_refresh_hash text,
  add column if not exists rotated_at timestamptz;

create index if not exists sessions_prev_refresh_hash on orbit.sessions (prev_refresh_hash)
  where prev_refresh_hash is not null;

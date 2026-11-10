-- orbit-connectors and orbit-research now ask this table whether a browser sign-in made an account
-- (accountTokenOk: the proof a first-version account token needs), on every account call. Look-ups are by account.
create index if not exists orbit_unipile_links_account_idx on public.orbit_unipile_links (account_id);

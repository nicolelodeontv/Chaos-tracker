-- Preserve the exact raw payload hash in payload_sha256 while using this
-- normalized-content hash to decide whether the raw HTML needs to be retained.
-- Null on existing rows is intentional: the first run after deployment stores
-- raw HTML because no comparable normalized hash is available yet.
alter table public.sync_audits
  add column if not exists dedupe_sha256 text;

create index if not exists sync_audits_dedupe_sha256_idx
  on public.sync_audits (dedupe_sha256);

create table if not exists public.sync_audits (
  id bigint generated always as identity primary key,
  captured_at timestamptz not null default now(),
  source_url text not null,
  payload_sha256 text,
  raw_payload text,
  raw_payload_stored boolean not null default false,
  parsed_clans jsonb not null default '[]'::jsonb,
  parsed_wars jsonb not null default '[]'::jsonb,
  anomalies jsonb not null default '[]'::jsonb,
  season int,
  total_rep bigint,
  clan_count int not null default 0,
  war_count int not null default 0,
  status text not null default 'started'
    check (status in ('started', 'success', 'warning', 'failed')),
  error text
);

-- Make a rerun safe if the table was created by an earlier draft of this migration.
alter table public.sync_audits
  add column if not exists raw_payload_stored boolean not null default false;

create index if not exists sync_audits_captured_at_idx
  on public.sync_audits (captured_at desc);
create index if not exists sync_audits_status_captured_at_idx
  on public.sync_audits (status, captured_at desc);
create index if not exists sync_audits_payload_sha256_idx
  on public.sync_audits (payload_sha256);

-- Raw HTML may contain page content, so keep audit records private.
alter table public.sync_audits enable row level security;
revoke all on table public.sync_audits from public, anon, authenticated;
grant all on table public.sync_audits to service_role;
grant usage, select on sequence public.sync_audits_id_seq to service_role;

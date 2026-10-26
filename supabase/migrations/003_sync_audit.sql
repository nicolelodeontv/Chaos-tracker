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

-- Repair columns if a previous attempt created this table only partially.
alter table public.sync_audits
  add column if not exists raw_payload_stored boolean not null default false;
alter table public.sync_audits
  add column if not exists payload_sha256 text;
alter table public.sync_audits
  add column if not exists raw_payload text;
alter table public.sync_audits
  add column if not exists parsed_clans jsonb not null default '[]'::jsonb;
alter table public.sync_audits
  add column if not exists parsed_wars jsonb not null default '[]'::jsonb;
alter table public.sync_audits
  add column if not exists anomalies jsonb not null default '[]'::jsonb;
alter table public.sync_audits
  add column if not exists season int;
alter table public.sync_audits
  add column if not exists total_rep bigint;
alter table public.sync_audits
  add column if not exists clan_count int not null default 0;
alter table public.sync_audits
  add column if not exists war_count int not null default 0;
alter table public.sync_audits
  add column if not exists status text not null default 'started';
alter table public.sync_audits
  add column if not exists error text;
alter table public.sync_audits
  add column if not exists source_url text;

create index if not exists sync_audits_captured_at_idx
  on public.sync_audits (captured_at desc);
create index if not exists sync_audits_status_captured_at_idx
  on public.sync_audits (status, captured_at desc);
create index if not exists sync_audits_payload_sha256_idx
  on public.sync_audits (payload_sha256);

-- Reruns must leave the table private even if a permissive policy was created
-- during an earlier experiment. No client-facing policy is intended here.
do $$
declare
  p record;
begin
  for p in
    select policyname
    from pg_policies
    where schemaname = 'public' and tablename = 'sync_audits'
  loop
    execute format('drop policy if exists %I on public.sync_audits', p.policyname);
  end loop;
end
$$;

alter table public.sync_audits enable row level security;
revoke all privileges on table public.sync_audits from public, anon, authenticated;
grant all privileges on table public.sync_audits to service_role;
grant usage, select on sequence public.sync_audits_id_seq to service_role;

-- Persist the last sync's audit health separately so repeated audit outages are
-- detectable even when sync_audits itself is unavailable.
alter table public.sync_runs
  add column if not exists audit_status text not null default 'unknown';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'sync_runs_audit_status_check'
      and conrelid = 'public.sync_runs'::regclass
  ) then
    alter table public.sync_runs
      add constraint sync_runs_audit_status_check
      check (audit_status in ('unknown', 'ok', 'partial', 'unavailable'));
  end if;
end
$$;

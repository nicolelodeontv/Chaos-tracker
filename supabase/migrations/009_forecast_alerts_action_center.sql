-- Durable, deduplicated forecast alerts and their optional Discord delivery state.
-- Public clients may read alert history; only the server service role may write it.

create table if not exists public.clan_forecast_alerts (
  id bigint generated always as identity primary key,
  source_forecast_id bigint references public.clan_forecasts(id) on delete set null,
  clan_id bigint references public.clans(id) on delete set null,
  clan_name text not null,
  season integer not null,
  alert_type text not null check (
    alert_type in (
      'forecast_miss',
      'direction_reversal',
      'projected_top_ten_entry',
      'projected_top_ten_exit'
    )
  ),
  severity text not null check (severity in ('warning', 'critical')),
  title text not null,
  detail text not null,
  predicted_reputation bigint,
  actual_reputation bigint,
  absolute_error bigint,
  current_rank integer,
  projected_rank integer,
  cooldown_key text not null,
  dedupe_key text not null unique,
  delivery_status text not null default 'queued'
    check (delivery_status in ('queued', 'sent', 'not_configured', 'failed')),
  delivery_attempts smallint not null default 0
    check (delivery_attempts >= 0 and delivery_attempts <= 3),
  last_attempt_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  constraint clan_forecast_alerts_rank_values check (
    (current_rank is null and projected_rank is null)
    or (current_rank is not null and projected_rank is not null
      and current_rank > 0 and projected_rank > 0)
  ),
  constraint clan_forecast_alerts_delivery_state check (
    (delivery_status = 'sent' and sent_at is not null)
    or (delivery_status <> 'sent' and sent_at is null)
  )
);

create index if not exists clan_forecast_alerts_season_created_idx
  on public.clan_forecast_alerts (season, created_at desc);

create index if not exists clan_forecast_alerts_clan_id_idx
  on public.clan_forecast_alerts (clan_id)
  where clan_id is not null;
create index if not exists clan_forecast_alerts_source_forecast_id_idx
  on public.clan_forecast_alerts (source_forecast_id)
  where source_forecast_id is not null;
create index if not exists clan_forecast_alerts_delivery_idx
  on public.clan_forecast_alerts (delivery_status, created_at asc)
  where delivery_status in ('queued', 'failed', 'not_configured');
create index if not exists clan_forecast_alerts_cooldown_idx
  on public.clan_forecast_alerts (cooldown_key, created_at desc);

alter table public.clan_forecast_alerts enable row level security;
drop policy if exists "public read" on public.clan_forecast_alerts;
create policy "public read" on public.clan_forecast_alerts
  for select to anon, authenticated
  using (true);

-- Explicit grants are required for new public-schema tables after Supabase's
-- October 30, 2026 Data API exposure change. The browser gets read-only access.
revoke all privileges on table public.clan_forecast_alerts
  from public, anon, authenticated;
grant select on table public.clan_forecast_alerts to anon, authenticated;
grant select, insert, update on table public.clan_forecast_alerts to service_role;

revoke all privileges on sequence public.clan_forecast_alerts_id_seq
  from public, anon, authenticated;
grant usage, select on sequence public.clan_forecast_alerts_id_seq to service_role;

-- Persist fixed-horizon clan forecasts and score them against later same-season snapshots.
create table if not exists public.clan_forecasts (
  id bigint generated always as identity primary key,
  clan_id bigint not null references public.clans(id) on delete cascade,
  season int not null,
  forecast_at timestamptz not null,
  target_at timestamptz not null,
  horizon_hours smallint not null default 24 check (horizon_hours = 24),
  base_reputation bigint not null check (base_reputation >= 0),
  forecast_reputation bigint not null check (forecast_reputation >= 0),
  rate_per_hour numeric(20, 6) not null,
  history_hours numeric(8, 3) not null check (history_hours >= 6),
  actual_reputation bigint,
  actual_at timestamptz,
  absolute_error bigint,
  direction_hit boolean,
  resolution_status text not null default 'pending'
    check (resolution_status in ('pending', 'resolved', 'season_changed')),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint clan_forecasts_target_after_forecast check (target_at > forecast_at),
  constraint clan_forecasts_resolution_fields check (
    (resolution_status = 'pending'
      and resolved_at is null
      and actual_reputation is null
      and actual_at is null
      and absolute_error is null
      and direction_hit is null)
    or
    (resolution_status = 'resolved'
      and resolved_at is not null
      and actual_reputation is not null
      and actual_at is not null
      and absolute_error is not null
      and direction_hit is not null)
    or
    (resolution_status = 'season_changed'
      and resolved_at is not null
      and actual_reputation is null
      and actual_at is null
      and absolute_error is null
      and direction_hit is null)
  ),
  constraint clan_forecasts_unique_run unique (clan_id, season, forecast_at)
);

create index if not exists clan_forecasts_season_time_idx
  on public.clan_forecasts (season, forecast_at desc);
create index if not exists clan_forecasts_pending_target_idx
  on public.clan_forecasts (target_at)
  where resolution_status = 'pending';

alter table public.clan_forecasts enable row level security;
drop policy if exists "public read" on public.clan_forecasts;
create policy "public read" on public.clan_forecasts
  for select using (true);

revoke all privileges on table public.clan_forecasts from public, anon, authenticated;
grant select on table public.clan_forecasts to anon, authenticated;
grant select, insert, update on table public.clan_forecasts to service_role;
revoke all privileges on sequence public.clan_forecasts_id_seq from public, anon, authenticated;
grant usage, select on sequence public.clan_forecasts_id_seq to service_role;

-- Resolve against the first same-season snapshot at or after the target timestamp.
-- Forecasts crossing a season reset are canceled, never scored against the new season.
create or replace function public.resolve_due_clan_forecasts(p_now timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_resolved integer := 0;
  v_canceled integer := 0;
begin
  with matches as (
    select f.id, s.reputation, s.captured_at
    from public.clan_forecasts f
    join lateral (
      select cs.reputation, cs.captured_at
      from public.clan_snapshots cs
      where cs.clan_id = f.clan_id
        and cs.season = f.season
        and cs.captured_at >= f.target_at
        and cs.captured_at <= p_now
      order by cs.captured_at asc, cs.id asc
      limit 1
    ) s on true
    where f.resolution_status = 'pending'
      and f.target_at <= p_now
  )
  update public.clan_forecasts f
  set actual_reputation = matches.reputation,
      actual_at = matches.captured_at,
      absolute_error = abs(matches.reputation - f.forecast_reputation),
      direction_hit = (
        sign(matches.reputation - f.base_reputation)
        = sign(f.forecast_reputation - f.base_reputation)
      ),
      resolution_status = 'resolved',
      resolved_at = p_now
  from matches
  where f.id = matches.id;

  get diagnostics v_resolved = row_count;

  update public.clan_forecasts f
  set resolution_status = 'season_changed',
      resolved_at = p_now
  where f.resolution_status = 'pending'
    and f.target_at <= p_now
    and exists (
      select 1
      from public.clan_snapshots newer
      where newer.clan_id = f.clan_id
        and newer.season <> f.season
        and newer.captured_at >= f.target_at
        and newer.captured_at <= p_now
    )
    and not exists (
      select 1
      from public.clan_snapshots same_season
      where same_season.clan_id = f.clan_id
        and same_season.season = f.season
        and same_season.captured_at >= f.target_at
        and same_season.captured_at <= p_now
    );

  get diagnostics v_canceled = row_count;
  return v_resolved + v_canceled;
end;
$function$;

revoke all on function public.resolve_due_clan_forecasts(timestamptz)
  from public, anon, authenticated;
grant execute on function public.resolve_due_clan_forecasts(timestamptz)
  to service_role;

create or replace view public.clan_forecast_accuracy
with (security_invoker = true) as
select
  season,
  count(*) filter (where resolution_status = 'resolved')::integer as resolved_count,
  count(*) filter (where resolution_status = 'pending')::integer as pending_count,
  round(
    avg(absolute_error::numeric) filter (where resolution_status = 'resolved'),
    1
  ) as mean_absolute_error,
  round(
    100 * avg((case when direction_hit then 1 else 0 end)::numeric)
      filter (where resolution_status = 'resolved'),
    1
  ) as direction_accuracy_pct,
  max(resolved_at) filter (where resolution_status = 'resolved') as last_resolved_at
from public.clan_forecasts
group by season;

create or replace view public.clan_latest_forecasts
with (security_invoker = true) as
select
  id, clan_id, season, clan_name, forecast_at, target_at, horizon_hours,
  base_reputation, forecast_reputation, rate_per_hour, history_hours,
  resolution_status, actual_reputation, actual_at, absolute_error,
  direction_hit, resolved_at
from (
  select
    f.id, f.clan_id, f.season, c.name as clan_name, f.forecast_at, f.target_at,
    f.horizon_hours, f.base_reputation, f.forecast_reputation, f.rate_per_hour,
    f.history_hours, f.resolution_status, f.actual_reputation, f.actual_at,
    f.absolute_error, f.direction_hit, f.resolved_at,
    row_number() over (
      partition by f.clan_id, f.season
      order by f.forecast_at desc, f.id desc
    ) as row_number
  from public.clan_forecasts f
  join public.clans c on c.id = f.clan_id
) latest
where row_number = 1;

grant select on public.clan_forecast_accuracy to anon, authenticated, service_role;
grant select on public.clan_latest_forecasts to anon, authenticated, service_role;

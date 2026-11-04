-- Historical trend and per-clan reliability summaries for forecast accuracy.
-- Both views run with caller privileges; source table RLS remains in force.

create or replace view public.clan_forecast_accuracy_trend
with (security_invoker = true) as
select
  season,
  date_trunc('day', resolved_at)::date as scored_day,
  count(*) filter (where resolution_status = 'resolved')::integer as resolved_count,
  round(
    avg(absolute_error::numeric) filter (where resolution_status = 'resolved'),
    1
  ) as mean_absolute_error,
  round(
    100 * avg((case when direction_hit then 1 else 0 end)::numeric)
      filter (where resolution_status = 'resolved'),
    1
  ) as direction_accuracy_pct
from public.clan_forecasts
where resolution_status = 'resolved'
group by season, date_trunc('day', resolved_at)::date;

create or replace view public.clan_forecast_clan_reliability
with (security_invoker = true) as
select
  f.season,
  f.clan_id,
  c.name as clan_name,
  count(*) filter (where f.resolution_status = 'resolved')::integer as resolved_count,
  count(*) filter (where f.resolution_status = 'pending')::integer as pending_count,
  round(
    avg(f.absolute_error::numeric) filter (where f.resolution_status = 'resolved'),
    1
  ) as mean_absolute_error,
  round(
    100 * avg((case when f.direction_hit then 1 else 0 end)::numeric)
      filter (where f.resolution_status = 'resolved'),
    1
  ) as direction_accuracy_pct,
  max(f.resolved_at) filter (where f.resolution_status = 'resolved') as last_resolved_at
from public.clan_forecasts f
join public.clans c on c.id = f.clan_id
group by f.season, f.clan_id, c.name;

revoke all privileges on table
  public.clan_forecast_accuracy_trend,
  public.clan_forecast_clan_reliability
  from public, anon, authenticated;
grant select on table
  public.clan_forecast_accuracy_trend,
  public.clan_forecast_clan_reliability
  to anon, authenticated, service_role;

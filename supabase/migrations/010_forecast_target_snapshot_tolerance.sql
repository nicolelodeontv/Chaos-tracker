-- Score a 24-hour forecast against the closest same-season snapshot when the
-- scheduled scrape lands just before its target. This avoids an unnecessary
-- full sync-interval delay for sub-minute capture jitter.
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
        and cs.captured_at >= f.target_at - interval '1 minute'
        and cs.captured_at <= p_now
      order by abs(extract(epoch from (cs.captured_at - f.target_at))) asc,
               cs.captured_at asc,
               cs.id asc
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
      -- A global season reset can affect a clan missing from the new ranking.
      select 1
      from public.sync_runs newer_run
      where newer_run.season <> f.season
        and newer_run.captured_at > f.forecast_at
        and newer_run.captured_at <= p_now
    )
    and not exists (
      select 1
      from public.clan_snapshots same_season
      where same_season.clan_id = f.clan_id
        and same_season.season = f.season
        and same_season.captured_at >= f.target_at - interval '1 minute'
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

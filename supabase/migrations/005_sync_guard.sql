create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to postgres, service_role;

create table if not exists private.sync_guard (
  id smallint primary key check (id = 1),
  claim_token uuid,
  lease_expires_at timestamptz,
  last_success_at timestamptz
);

insert into private.sync_guard (id)
values (1)
on conflict (id) do nothing;

revoke all on table private.sync_guard from public, anon, authenticated, service_role;

create or replace function public.claim_tracker_sync(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_guard private.sync_guard%rowtype;
  v_now timestamptz := clock_timestamp();
  v_last_sync_at timestamptz;
  v_last_audit_status text;
begin
  if p_token is null then
    raise exception 'A sync claim token is required';
  end if;

  select *
    into v_guard
    from private.sync_guard
    where id = 1
    for update;

  if v_guard.id is null then
    insert into private.sync_guard (id) values (1)
    on conflict (id) do nothing;
    select *
      into v_guard
      from private.sync_guard
      where id = 1
      for update;
  end if;

  if v_guard.claim_token is not null
     and v_guard.lease_expires_at > v_now then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'in-progress',
      'last_success_at', v_guard.last_success_at,
      'last_audit_status', null
    );
  end if;

  select captured_at, audit_status
    into v_last_sync_at, v_last_audit_status
    from public.sync_runs
    order by captured_at desc
    limit 1;

  if v_last_sync_at is not null
     and v_last_sync_at > v_now - interval '20 minutes' then
    update private.sync_guard
      set claim_token = null,
          lease_expires_at = null,
          last_success_at = v_last_sync_at
      where id = 1;

    return jsonb_build_object(
      'claimed', false,
      'reason', 'recent-success',
      'last_success_at', v_last_sync_at,
      'last_audit_status', v_last_audit_status
    );
  end if;

  update private.sync_guard
    set claim_token = p_token,
        lease_expires_at = v_now + interval '3 minutes'
    where id = 1;

  return jsonb_build_object(
    'claimed', true,
    'reason', 'claimed',
    'last_success_at', v_guard.last_success_at,
    'last_audit_status', v_last_audit_status
  );
end;
$function$;

create or replace function public.release_tracker_sync(
  p_token uuid,
  p_success boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  update private.sync_guard
    set claim_token = null,
        lease_expires_at = null,
        last_success_at = case
          when p_success then clock_timestamp()
          else last_success_at
        end
    where id = 1
      and claim_token = p_token;

  return found;
end;
$function$;

revoke all on function public.claim_tracker_sync(uuid) from public, anon, authenticated;
revoke all on function public.release_tracker_sync(uuid, boolean) from public, anon, authenticated;
grant execute on function public.claim_tracker_sync(uuid) to service_role;
grant execute on function public.release_tracker_sync(uuid, boolean) to service_role;

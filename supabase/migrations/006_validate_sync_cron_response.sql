-- Keep the Supabase scheduler honest when the guarded endpoint skips work.
-- A skipped run is successful only if it points to a recent successful sync_runs row.
select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'chaos-tracker-external-sync'),
  schedule := '17 */3 * * *',
  command := $command$
do $job$
declare
  response extensions.http_response;
  payload jsonb;
  was_skipped boolean;
  skip_reason text;
  last_success_at timestamptz;
  audit_status text;
  audit_alert boolean;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '55000');

  select *
    into response
    from extensions.http(
      row(
        'POST'::extensions.http_method,
        'https://trackerforchaos.vercel.app/api/external-sync',
        array[
          extensions.http_header(
            'Authorization',
            'Bearer ' || (
              select decrypted_secret
              from vault.decrypted_secrets
              where name = 'tracker_external_sync_secret'
            )
          ),
          extensions.http_header('Accept', 'application/json')
        ]::extensions.http_header[],
        'application/json',
        '{}'::varchar
      )::extensions.http_request
    );

  if response.status is null
     or response.status < 200
     or response.status >= 300 then
    raise exception 'Tracker sync relay returned HTTP %', response.status;
  end if;

  payload := response.content::jsonb;
  was_skipped := coalesce((payload ->> 'skipped')::boolean, false);

  if was_skipped then
    skip_reason := payload ->> 'reason';
    if skip_reason is distinct from 'recent-success' then
      raise exception 'Tracker sync skipped without a verified recent success (reason=%)',
        coalesce(skip_reason, 'unknown');
    end if;

    last_success_at := nullif(payload ->> 'last_success_at', '')::timestamptz;
    if last_success_at is null
       or last_success_at < clock_timestamp() - interval '20 minutes'
       or last_success_at > clock_timestamp() + interval '1 minute' then
      raise exception 'Recent-success skip had an invalid or stale timestamp: %', last_success_at;
    end if;

    if not exists (
      select 1
      from public.sync_runs
      where audit_status = 'ok'
        and captured_at between last_success_at - interval '2 seconds'
                            and last_success_at + interval '2 seconds'
    ) then
      raise exception 'Recent-success skip did not match an audit_status=ok sync_runs row at %',
        last_success_at;
    end if;
  end if;

  audit_status := coalesce(payload ->> 'audit_status', 'unknown');
  audit_alert := coalesce((payload ->> 'audit_alert')::boolean, false);

  if audit_status <> 'ok' then
    raise exception 'Tracker sync audit_status=%', audit_status;
  end if;

  if audit_alert then
    raise exception 'Tracker sync reported audit_alert=true';
  end if;
end
$job$;
$command$
);

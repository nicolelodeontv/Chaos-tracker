import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { matchesBearerToken } from '../../../lib/bearer-auth.mjs';
import { adminClient } from '../../../lib/supabase';
import { fetchHtml, getSourceUrl, parse } from '../../../lib/source';
import {
  findWithinSeasonReputationDecreases,
  getLargeDecreaseAlerts,
  hashPayload,
  hashPayloadForDedupe,
  LARGE_DECREASE_ALERT_THRESHOLD,
  shouldAlertOnConsecutiveAuditDegradation,
  shouldStoreRawPayload,
} from '../../../lib/sync-audit.mjs';
import {
  applyClanForecastCalibration,
  buildClanForecast,
  MAX_FORECAST_CALIBRATION_ADJUSTMENT_PCT,
  MAX_FORECAST_CALIBRATION_SAMPLES,
  MIN_FORECAST_CALIBRATION_SAMPLES,
} from '../../../forecast.js';
import { processForecastAlerts } from '../../../lib/forecast-alerts-server.mjs';

export const dynamic = 'force-dynamic';

const RAW_PAYLOAD_RETENTION_DAYS = 30;

async function trackForecastAccuracy(db, season, insertedSnapshots, currentClans) {
  try {
    const latestInsertedTime = Math.max(
      ...insertedSnapshots.map((snapshot) => new Date(snapshot.captured_at).getTime()).filter(Number.isFinite),
    );
    const effectiveNow = new Date(Math.max(
      Date.now(),
      Number.isFinite(latestInsertedTime) ? latestInsertedTime : 0,
    )).toISOString();

    const { data: resolvedCount, error: resolveError } = await db.rpc('resolve_due_clan_forecasts', {
      p_now: effectiveNow,
    });
    if (resolveError) throw resolveError;

    const cutoff = new Date(new Date(effectiveNow).getTime() - 24 * 60 * 60 * 1000).toISOString();
    const historyByClan = new Map();
    const pageSize = 1000;
    let offset = 0;

    while (true) {
      const { data, error } = await db.from('clan_snapshots')
        .select('id,clan_id,captured_at,reputation,season')
        .eq('season', season)
        .gte('captured_at', cutoff)
        .lte('captured_at', effectiveNow)
        .order('captured_at', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) throw error;

      const rows = data ?? [];
      for (const snapshot of rows) {
        if (!historyByClan.has(snapshot.clan_id)) historyByClan.set(snapshot.clan_id, []);
        historyByClan.get(snapshot.clan_id).push(snapshot);
      }
      if (rows.length < pageSize) break;
      offset += pageSize;
    }

    // Learn a correction from the latest resolved outcomes for the same clan and season.
    // Stop reading once every clan in this sync has enough history for the rolling sample.
    const calibrationHistoryByClan = new Map();
    const forecastCutoffByClan = new Map();
    for (const snapshot of insertedSnapshots) {
      const forecastTime = new Date(snapshot.captured_at).getTime();
      const currentCutoff = forecastCutoffByClan.get(snapshot.clan_id);
      if (Number.isFinite(forecastTime) && (!Number.isFinite(currentCutoff) || forecastTime < currentCutoff)) {
        forecastCutoffByClan.set(snapshot.clan_id, forecastTime);
      }
    }
    const calibrationClanIds = [...new Set(insertedSnapshots.map((snapshot) => snapshot.clan_id))];
    const calibrationHistoryCount = new Map(calibrationClanIds.map((clanId) => [clanId, 0]));
    let calibrationHistoryAvailable = true;
    if (calibrationClanIds.length) {
      const pageSize = 1000;
      let offset = 0;
      try {
        while ([...calibrationHistoryCount.values()].some((count) => count < MAX_FORECAST_CALIBRATION_SAMPLES)) {
          const { data, error } = await db.from('clan_forecasts')
            .select('id,clan_id,season,forecast_at,forecast_reputation,actual_reputation,resolution_status,resolved_at')
            .eq('season', season)
            .eq('resolution_status', 'resolved')
            .in('clan_id', calibrationClanIds)
            .order('forecast_at', { ascending: false })
            .order('id', { ascending: false })
            .range(offset, offset + pageSize - 1);
          if (error) throw error;

          const rows = data ?? [];
          for (const row of rows) {
            const cutoff = forecastCutoffByClan.get(row.clan_id);
            const priorForecastAt = new Date(row.forecast_at).getTime();
            const priorResolvedAt = new Date(row.resolved_at).getTime();
            if (
              !Number.isFinite(cutoff)
              || !Number.isFinite(priorForecastAt)
              || priorForecastAt >= cutoff
              || !Number.isFinite(priorResolvedAt)
              || priorResolvedAt > cutoff
            ) continue;

            const currentCount = calibrationHistoryCount.get(row.clan_id) ?? 0;
            if (currentCount >= MAX_FORECAST_CALIBRATION_SAMPLES) continue;
            if (!calibrationHistoryByClan.has(row.clan_id)) calibrationHistoryByClan.set(row.clan_id, []);
            calibrationHistoryByClan.get(row.clan_id).push(row);
            calibrationHistoryCount.set(row.clan_id, currentCount + 1);
          }
          if (rows.length < pageSize) break;
          offset += pageSize;
        }
      } catch (error) {
        calibrationHistoryAvailable = false;
        calibrationHistoryByClan.clear();
        console.warn(
          'Forecast calibration history unavailable; preserving baseline projections:',
          String(error?.message || error),
        );
      }
    }

    const forecastResults = insertedSnapshots.map((snapshot) => {
      const baseline = buildClanForecast(historyByClan.get(snapshot.clan_id) || []);
      if (!baseline) return null;
      const forecast = calibrationHistoryAvailable
        ? applyClanForecastCalibration(baseline, calibrationHistoryByClan.get(snapshot.clan_id) || [])
        : {
          ...baseline,
          calibration: {
            status: 'history_unavailable',
            sampleCount: 0,
            requiredSamples: MIN_FORECAST_CALIBRATION_SAMPLES,
          },
        };
      return {
        forecast,
        row: {
          clan_id: snapshot.clan_id,
          season,
          forecast_at: forecast.forecastAt,
          target_at: forecast.targetAt,
          horizon_hours: forecast.horizonHours,
          base_reputation: forecast.baseReputation,
          forecast_reputation: forecast.forecastReputation,
          rate_per_hour: forecast.ratePerHour,
          history_hours: forecast.historyHours,
          calibration_status: forecast.calibration?.status ?? 'not_calibrated',
          calibration_sample_count: forecast.calibration?.sampleCount ?? 0,
          calibration_median_relative_error_pct: forecast.calibration?.medianRelativeErrorPct ?? null,
          calibration_adjustment_pct: forecast.calibration?.appliedAdjustmentPct ?? null,
        },
      };
    }).filter(Boolean);
    const forecasts = forecastResults.map((result) => result.row);
    const calibratedForecasts = forecastResults.filter(
      (result) => result.forecast.calibration?.status === 'calibrated',
    ).length;
    const calibrationSamplesBuilding = forecastResults.filter(
      (result) => result.forecast.calibration?.status === 'insufficient_data',
    ).length;

    if (forecasts.length) {
      const { error: insertError } = await db.from('clan_forecasts').upsert(forecasts, {
        onConflict: 'clan_id,season,forecast_at',
        ignoreDuplicates: true,
      });
      if (insertError) throw insertError;
    }

    const alertTracking = await processForecastAlerts(db, season, effectiveNow, currentClans);

    return {
      status: 'ok',
      created: forecasts.length,
      settled: Number(resolvedCount) || 0,
      without_enough_history: Math.max(0, insertedSnapshots.length - forecasts.length),
      calibration: {
        history_available: calibrationHistoryAvailable,
        eligible_forecasts: calibratedForecasts,
        waiting_for_samples: calibrationSamplesBuilding,
        required_samples: MIN_FORECAST_CALIBRATION_SAMPLES,
        max_adjustment_pct: MAX_FORECAST_CALIBRATION_ADJUSTMENT_PCT,
      },
      alerts: alertTracking,
    };
  } catch (error) {
    console.warn('Forecast accuracy tracking unavailable; normal clan sync will continue:', String(error?.message || error));
    return { status: 'unavailable', created: 0, settled: 0 };
  }
}

async function run(req) {
  // Preview shares public database variables with Production today. Block it
  // before checking credentials or constructing a privileged database client.
  if (process.env.VERCEL_ENV === 'preview' && process.env.ALLOW_PREVIEW_SYNC !== 'true') {
    return NextResponse.json({ error: 'sync disabled outside production' }, { status: 403 });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!matchesBearerToken(req.headers.get('authorization'), cronSecret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = adminClient();
  const sourceUrl = getSourceUrl();
  const claimToken = randomUUID();
  const { data: claim, error: claimError } = await db.rpc('claim_tracker_sync', {
    p_token: claimToken,
  });

  if (claimError || !claim || typeof claim.claimed !== 'boolean') {
    console.error('Could not claim sync lock:', claimError?.message || 'invalid claim response');
    return NextResponse.json({ error: 'sync lock unavailable' }, { status: 503 });
  }

  if (!claim.claimed) {
    const recentAuditStatus = claim.reason === 'recent-success'
      ? claim.last_audit_status
      : 'ok';
    return NextResponse.json({
      skipped: true,
      reason: claim.reason || 'sync-already-running',
      last_success_at: claim.last_success_at || null,
      audit_status: recentAuditStatus || 'ok',
      audit_alert: false,
    });
  }

  let claimHeld = true;
  const releaseSyncClaim = async (success) => {
    if (!claimHeld) return true;
    try {
      const { data, error } = await db.rpc('release_tracker_sync', {
        p_token: claimToken,
        p_success: success,
      });
      if (error || data !== true) {
        console.error('Could not release sync lock:', error?.message || 'claim token not found');
        return false;
      }
      claimHeld = false;
      return true;
    } catch (error) {
      console.error('Could not release sync lock:', error?.message || String(error));
      return false;
    }
  };
  let auditId = null;
  let auditStatus = 'unavailable';
  let auditUpdateFailed = false;
  let previousDedupeHash = null;
  let previousDedupeHashRead = false;
  let html = null;
  let payloadSha256 = null;
  let parsed = { clans: [], wars: [], closed: false };

  const errorText = (error) => String(error?.message || error).slice(0, 4000);

  // Audit writes are best-effort by design; they must never abort snapshot capture.
  const updateAudit = async (values) => {
    if (!auditId) return false;
    try {
      const { error } = await db.from('sync_audits').update(values).eq('id', auditId);
      if (error) {
        auditUpdateFailed = true;
        console.warn('Sync audit update failed; continuing without audit update:', error.message);
        return false;
      }
      return true;
    } catch (error) {
      auditUpdateFailed = true;
      console.warn('Sync audit update failed; continuing without audit update:', errorText(error));
      return false;
    }
  };

  const prepareAudit = async () => {
    // Read the last non-null normalized-content hash before this run's row.
    try {
      const { data, error } = await db
        .from('sync_audits')
        .select('dedupe_sha256')
        .not('dedupe_sha256', 'is', null)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      previousDedupeHash = data?.dedupe_sha256 ?? null;
      previousDedupeHashRead = true;
    } catch (error) {
      // On read failure retain HTML rather than risk skipping evidence.
      console.warn('Previous normalized audit hash unavailable; current raw payload will be retained:', errorText(error));
    }

    try {
      const { data, error } = await db
        .from('sync_audits')
        .insert({
          source_url: sourceUrl,
          status: 'started',
          raw_payload_stored: false,
          parsed_clans: [],
          parsed_wars: [],
          anomalies: [],
        })
        .select('id')
        .single();
      if (error) throw error;
      auditId = data.id;
      auditStatus = 'ok';
    } catch (error) {
      auditStatus = 'unavailable';
      console.warn('Sync audit insert failed; snapshot sync will continue:', errorText(error));
    }
  };

  const cleanupExpiredRawPayloads = async () => {
    // This endpoint is invoked by both Supabase Cron and the GitHub backup.
    // The sweep is best-effort and runs whenever an actual sync is performed.
    try {
      const cutoff = new Date(Date.now() - RAW_PAYLOAD_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const { error } = await db
        .from('sync_audits')
        .update({ raw_payload: null })
        .lt('captured_at', cutoff)
        .not('raw_payload', 'is', null);
      if (error) throw error;
    } catch (error) {
      auditUpdateFailed = true;
      const warning = { type: 'raw-payload-retention-cleanup-failed', error: errorText(error) };
      console.warn('Raw-payload retention cleanup failed; continuing sync:', warning.error);
      await updateAudit({ status: 'warning', anomalies: [warning] });
    }
  };

  const recordFailure = async (error) => {
    const message = errorText(error);
    await updateAudit({ status: 'failed', error: message });
    // If auditing is unavailable, retain the original sync error and outcome.
    console.error('Clan sync failed:', message);
  };

  await prepareAudit();
  await cleanupExpiredRawPayloads();

  try {
    html = await fetchHtml();
    payloadSha256 = hashPayload(html);
    const dedupeSha256 = hashPayloadForDedupe(html);
    parsed = parse(html);
    const { clans, wars, closed } = parsed;
    const total = clans.reduce((sum, clan) => sum + clan.reputation, 0);
    const rawPayloadStored = shouldStoreRawPayload(
      previousDedupeHash,
      dedupeSha256,
      previousDedupeHashRead,
    );

    // Keep the exact raw HTML hash on every row. For the storage decision only,
    // ignore the two rotating tokens and compare the remaining page HTML.
    await updateAudit({
      payload_sha256: payloadSha256,
      dedupe_sha256: dedupeSha256,
      raw_payload: rawPayloadStored ? html : null,
      raw_payload_stored: rawPayloadStored,
      parsed_clans: clans,
      parsed_wars: wars,
      total_rep: total,
      clan_count: clans.length,
      war_count: wars.length,
    });

    if (!clans.length) {
      const message = 'No clan table found. The page may load data via JS; point SOURCE_URL at the data endpoint.';
      await updateAudit({ status: 'failed', error: message });
      await releaseSyncClaim(false);
      return NextResponse.json({ error: message, audit_status: auditStatus }, { status: 502 });
    }

    // Season detection is unchanged: the aggregate reputation reset starts the next season.
    const { data: last, error: lastError } = await db
      .from('sync_runs')
      .select('season,total_rep,audit_status')
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastError) throw lastError;

    const maxWar = wars.length ? Math.max(...wars.map((war) => war.season)) : 0;
    let season = last ? last.season : closed ? maxWar : maxWar + 1;
    if (last && total < Number(last.total_rep) * 0.5) season = last.season + 1;

    let decreases = [];
    let guardStatus = 'available';
    let guardError = null;
    try {
      const { data: previousRows, error: previousError } = await db
        .from('clan_latest')
        .select('name,reputation,season');
      if (previousError) throw previousError;
      decreases = findWithinSeasonReputationDecreases(clans, previousRows || [], season);
    } catch (error) {
      guardStatus = 'unavailable';
      guardError = errorText(error);
      console.warn('Within-season decrease guard unavailable; continuing sync:', guardError);
    }

    const alerts = getLargeDecreaseAlerts(decreases);
    const auditAnomalies = [
      ...decreases,
      ...(guardError ? [{ type: 'reputation-decrease-guard-unavailable', error: guardError }] : []),
    ];

    await updateAudit({
      season,
      total_rep: total,
      anomalies: auditAnomalies,
    });

    if (decreases.length) {
      console.info('Detected ' + decreases.length + ' within-season reputation decrease(s); only decreases >= ' + LARGE_DECREASE_ALERT_THRESHOLD + ' are elevated to alerts.');
    }
    if (alerts.length) {
      console.warn('Large within-season reputation decreases:', JSON.stringify(alerts));
    }

    const { data: rows, error: e1 } = await db
      .from('clans')
      .upsert(clans.map((clan) => ({ name: clan.name, master: clan.master })), { onConflict: 'name' })
      .select('id,name');
    if (e1) throw e1;
    const ids = new Map(rows.map((row) => [row.name, row.id]));
    const snaps = clans.filter((clan) => ids.has(clan.name)).map((clan) => ({
      clan_id: ids.get(clan.name),
      season,
      rank: clan.rank,
      members: clan.members,
      max_members: clan.max_members,
      reputation: clan.reputation,
    }));
    const currentClans = clans.filter((clan) => ids.has(clan.name)).map((clan) => ({
      clan_id: ids.get(clan.name),
      name: clan.name,
      rank: clan.rank,
      reputation: clan.reputation,
    }));

    const { data: insertedSnapshots, error: e2 } = await db.from('clan_snapshots')
      .insert(snaps)
      .select('clan_id,captured_at,reputation,season');
    if (e2) throw e2;
    const forecastTracking = await trackForecastAccuracy(db, season, insertedSnapshots || [], currentClans);

    if (wars.length) {
      const { error: e3 } = await db.from('war_results').upsert(wars, { onConflict: 'season,rank' });
      if (e3) throw e3;
    }

    const hasAlerts = alerts.length > 0 || guardStatus === 'unavailable';
    await updateAudit({
      status: hasAlerts ? 'warning' : 'success',
      season,
      total_rep: total,
      clan_count: snaps.length,
      war_count: wars.length,
      anomalies: auditAnomalies,
      error: null,
    });

    const currentAuditStatus = auditId ? (auditUpdateFailed ? 'partial' : auditStatus) : 'unavailable';
    const auditAlert = shouldAlertOnConsecutiveAuditDegradation(currentAuditStatus, last?.audit_status);
    const { error: e4 } = await db.from('sync_runs').insert({
      season,
      total_rep: total,
      audit_status: currentAuditStatus,
    });
    if (e4) throw e4;

    if (auditAlert) {
      console.error('Audit storage has degraded for at least two consecutive syncs:', {
        previous: last?.audit_status,
        current: currentAuditStatus,
      });
    } else if (currentAuditStatus !== 'ok') {
      console.warn('Sync succeeded with degraded audit status:', currentAuditStatus);
    }

    await releaseSyncClaim(true);
    return NextResponse.json({
      season,
      clans: snaps.length,
      war_rows: wars.length,
      audit_status: currentAuditStatus,
      audit_alert: auditAlert,
      guard_status: guardStatus,
      decreases_detected: decreases.length,
      large_decrease_alerts: alerts,
      forecast_tracking: forecastTracking,
    });
  } catch (error) {
    await recordFailure(error);
    await releaseSyncClaim(false);
    return NextResponse.json({ error: String(error.message || error), audit_status: auditId ? 'partial' : 'unavailable' }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;

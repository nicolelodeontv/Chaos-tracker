import { NextResponse } from 'next/server';
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

export const dynamic = 'force-dynamic';

const RAW_PAYLOAD_RETENTION_DAYS = 30;

async function run(req) {
  // Preview shares public database variables with Production today. Block it
  // before checking credentials or constructing a privileged database client.
  if (process.env.VERCEL_ENV === 'preview' && process.env.ALLOW_PREVIEW_SYNC !== 'true') {
    return NextResponse.json({ error: 'sync disabled outside production' }, { status: 403 });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get('authorization') !== 'Bearer ' + cronSecret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = adminClient();
  const sourceUrl = getSourceUrl();
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
    // The GitHub sync workflow runs every 3 hours, so this retention sweep runs
    // on that cadence. It's best-effort; no independent cron service is needed.
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

    const { error: e2 } = await db.from('clan_snapshots').insert(snaps);
    if (e2) throw e2;

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

    return NextResponse.json({
      season,
      clans: snaps.length,
      war_rows: wars.length,
      audit_status: currentAuditStatus,
      audit_alert: auditAlert,
      guard_status: guardStatus,
      decreases_detected: decreases.length,
      large_decrease_alerts: alerts,
    });
  } catch (error) {
    await recordFailure(error);
    return NextResponse.json({ error: String(error.message || error), audit_status: auditId ? 'partial' : 'unavailable' }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;

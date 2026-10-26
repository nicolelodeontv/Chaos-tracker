import { NextResponse } from 'next/server';
import { adminClient } from '../../../lib/supabase';
import { fetchHtml, getSourceUrl, parse } from '../../../lib/source';
import {
  findWithinSeasonReputationDecreases,
  getLargeDecreaseAlerts,
  hashPayload,
  LARGE_DECREASE_ALERT_THRESHOLD,
} from '../../../lib/sync-audit.mjs';

export const dynamic = 'force-dynamic';

const RAW_PAYLOAD_RETENTION_DAYS = 30;

async function run(req) {
  if (req.headers.get('authorization') !== \`Bearer \${process.env.CRON_SECRET}\`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Preview shares database variables with Production today. Never permit a
  // preview deployment to write snapshots unless explicitly enabled for testing.
  if (process.env.VERCEL_ENV === 'preview' && process.env.ALLOW_PREVIEW_SYNC !== 'true') {
    return NextResponse.json({ error: 'sync disabled outside production' }, { status: 403 });
  }

  const db = adminClient();
  const sourceUrl = getSourceUrl();
  let auditId = null;
  let auditStatus = 'unavailable';
  let auditUpdateFailed = false;
  let previousHash = null;
  let previousHashRead = false;
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
    // Read the last non-null hash before creating this run's in-progress row.
    try {
      const { data, error } = await db
        .from('sync_audits')
        .select('payload_sha256')
        .not('payload_sha256', 'is', null)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      previousHash = data?.payload_sha256 ?? null;
      previousHashRead = true;
    } catch (error) {
      // On read failure retain the HTML for evidence rather than risk skipping it.
      console.warn('Previous audit hash unavailable; current raw payload will be retained:', errorText(error));
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
      auditStatus = 'available';
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
      console.warn('Raw-payload retention cleanup failed; continuing sync:', errorText(error));
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
    parsed = parse(html);
    const { clans, wars, closed } = parsed;
    const total = clans.reduce((sum, clan) => sum + clan.reputation, 0);
    const rawPayloadStored = !previousHashRead || previousHash !== payloadSha256;

    // Always retain the exact hash and parsed rows. Store HTML only when it differs
    // from the preceding source payload (or when the comparison could not be made).
    await updateAudit({
      payload_sha256: payloadSha256,
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
      .select('season,total_rep')
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
      console.info(\`Detected \${decreases.length} within-season reputation decrease(s); only decreases >= \${LARGE_DECREASE_ALERT_THRESHOLD} are elevated to alerts.\`);
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

    const { error: e4 } = await db.from('sync_runs').insert({ season, total_rep: total });
    if (e4) throw e4;

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

    return NextResponse.json({
      season,
      clans: snaps.length,
      war_rows: wars.length,
      audit_status: auditId ? (auditUpdateFailed ? 'partial' : auditStatus) : 'unavailable',
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

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

  // Vercel Preview currently shares some environment variables with Production.
  // Never allow a preview deployment to write tracker snapshots by default.
  if (process.env.VERCEL_ENV === 'preview' && process.env.ALLOW_PREVIEW_SYNC !== 'true') {
    return NextResponse.json({ error: 'sync disabled outside production' }, { status: 403 });
  }

  const db = adminClient();
  const sourceUrl = getSourceUrl();
  let html = null;
  let payloadSha256 = null;
  let parsed = { clans: [], wars: [], closed: false };
  let auditId = null;
  let auditStatus = 'unavailable';

  const errorText = (error) => String(error?.message || error).slice(0, 4000);

  // Audit persistence is deliberately best-effort. It must never stop the real sync.
  const updateAudit = async (values) => {
    if (!auditId) return false;
    try {
      const { error } = await db.from('sync_audits').update(values).eq('id', auditId);
      if (error) {
        console.warn('Sync audit update failed; continuing without audit update:', error.message);
        return false;
      }
      return true;
    } catch (error) {
      console.warn('Sync audit update failed; continuing without audit update:', errorText(error));
      return false;
    }
  };

  const recordFailure = async (error) => {
    const message = errorText(error);
    if (auditId) {
      await updateAudit({ status: 'failed', error: message });
    }
    // If the audit table is unavailable, log the problem but do not replace the
    // original sync result with a secondary audit error.
    console.error('Clan sync failed:', message);
  };

  try {
    html = await fetchHtml();
    payloadSha256 = hashPayload(html);
    parsed = parse(html);
    const { clans, wars, closed } = parsed;
    const total = clans.reduce((sum, clan) => sum + clan.reputation, 0);

    // Store raw HTML only when the exact payload hash changes. Every run still
    // stores the hash and parsed rows so the history remains comparable.
    let previousHash = null;
    try {
      const { data: previousAudit, error: previousAuditError } = await db
        .from('sync_audits')
        .select('payload_sha256')
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (previousAuditError) throw previousAuditError;
      previousHash = previousAudit?.payload_sha256 ?? null;
    } catch (error) {
      // If audit reads are unavailable, retain the payload instead of risking
      // losing the only copy of a new source response.
      console.warn('Previous sync-audit hash unavailable; retaining current raw payload:', errorText(error));
    }

    const rawPayloadStored = previousHash !== payloadSha256;
    try {
      const { data: audit, error: auditInsertError } = await db
        .from('sync_audits')
        .insert({
          source_url: sourceUrl,
          payload_sha256: payloadSha256,
          raw_payload: rawPayloadStored ? html : null,
          raw_payload_stored: rawPayloadStored,
          parsed_clans: clans,
          parsed_wars: wars,
          anomalies: [],
          total_rep: total,
          clan_count: clans.length,
          war_count: wars.length,
          status: 'started',
        })
        .select('id')
        .single();

      if (auditInsertError) throw auditInsertError;
      auditId = audit.id;
      auditStatus = 'available';
    } catch (error) {
      auditStatus = 'unavailable';
      console.warn('Sync audit insert failed; snapshot sync will continue:', errorText(error));
    }

    // The repository's scheduled sync workflow calls this route every three
    // hours, so retention runs on that cadence without a separate cron job.
    // Retention is also best-effort and never affects the snapshot sync.
    try {
      const rawPayloadCutoff = new Date(Date.now() - RAW_PAYLOAD_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const { error: retentionError } = await db
        .from('sync_audits')
        .update({ raw_payload: null })
        .lt('captured_at', rawPayloadCutoff)
        .not('raw_payload', 'is', null);
      if (retentionError) throw retentionError;
    } catch (error) {
      console.warn('Raw-payload retention cleanup failed; continuing sync:', errorText(error));
    }

    if (!clans.length) {
      const message = 'No clan table found. The page may load data via JS; point SOURCE_URL at the data endpoint.';
      await updateAudit({ status: 'failed', error: message });
      return NextResponse.json({ error: message }, { status: 502 });
    }

    // Season: first run is seeded from the war results; later runs bump it when total rep resets.
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

    // A guard-query failure is an audit gap, not a reason to skip a healthy sync.
    let decreases = [];
    let guardStatus = 'available';
    try {
      const { data: previousRows, error: previousError } = await db
        .from('clan_latest')
        .select('name,reputation,season');
      if (previousError) throw previousError;
      decreases = findWithinSeasonReputationDecreases(clans, previousRows || [], season);
    } catch (error) {
      guardStatus = 'unavailable';
      console.warn('Within-season decrease guard unavailable; continuing sync:', errorText(error));
    }

    const alerts = getLargeDecreaseAlerts(decreases);
    await updateAudit({
      season,
      total_rep: total,
      anomalies: decreases,
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
      anomalies: decreases,
      error: null,
    });

    return NextResponse.json({
      season,
      clans: snaps.length,
      war_rows: wars.length,
      audit_status: auditStatus,
      guard_status: guardStatus,
      decreases_detected: decreases.length,
      large_decrease_alerts: alerts,
    });
  } catch (error) {
    await recordFailure(error);
    return NextResponse.json({ error: String(error.message || error) }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;

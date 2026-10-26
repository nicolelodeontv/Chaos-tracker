import { NextResponse } from 'next/server';
import { adminClient } from '../../../lib/supabase';
import { fetchHtml, getSourceUrl, parse } from '../../../lib/source';
import { findWithinSeasonReputationDecreases, hashPayload } from '../../../lib/sync-audit.mjs';

export const dynamic = 'force-dynamic';

const RAW_PAYLOAD_RETENTION_DAYS = 30;

async function run(req) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let db = null;
  let auditId = null;
  let html = null;
  let payloadSha256 = null;
  let parsed = { clans: [], wars: [], closed: false };
  const sourceUrl = getSourceUrl();

  const auditErrorMessage = (error) => String(error?.message || error).slice(0, 4000);
  const updateAudit = async (values) => {
    if (!auditId) return;
    const { error } = await db.from('sync_audits').update(values).eq('id', auditId);
    if (error) throw error;
  };

  const recordFailure = async (error) => {
    if (!db) return;
    const total = (parsed.clans || []).reduce((sum, clan) => sum + Number(clan.reputation || 0), 0);
    const fields = {
      source_url: sourceUrl,
      payload_sha256: payloadSha256,
      raw_payload: html,
      parsed_clans: parsed.clans || [],
      parsed_wars: parsed.wars || [],
      anomalies: [],
      total_rep: total,
      clan_count: (parsed.clans || []).length,
      war_count: (parsed.wars || []).length,
      status: 'failed',
      error: auditErrorMessage(error),
    };

    try {
      if (auditId) {
        const { error: updateError } = await db
          .from('sync_audits')
          .update({ status: 'failed', error: fields.error })
          .eq('id', auditId);
        if (updateError) throw updateError;
      } else {
        const { error: insertError } = await db.from('sync_audits').insert(fields);
        if (insertError) throw insertError;
      }
    } catch (auditError) {
      console.error('Unable to persist sync failure audit:', auditError);
    }
  };

  try {
    db = adminClient();
    html = await fetchHtml();
    payloadSha256 = hashPayload(html);
    parsed = parse(html);
    const { clans, wars, closed } = parsed;
    const total = clans.reduce((sum, clan) => sum + clan.reputation, 0);

    // Store the exact source HTML and parsed rows before mutating tracker data.
    // Raw HTML is private and is cleared after 30 days; hashes and parsed rows remain.
    const { data: audit, error: auditInsertError } = await db
      .from('sync_audits')
      .insert({
        source_url: sourceUrl,
        payload_sha256: payloadSha256,
        raw_payload: html,
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
    if (auditInsertError) throw new Error(`Unable to create sync audit record: ${auditInsertError.message}`);
    auditId = audit.id;

    const rawPayloadCutoff = new Date(Date.now() - RAW_PAYLOAD_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { error: retentionError } = await db
      .from('sync_audits')
      .update({ raw_payload: null })
      .lt('captured_at', rawPayloadCutoff)
      .not('raw_payload', 'is', null);
    if (retentionError) console.warn('Unable to prune expired raw sync payloads:', retentionError.message);

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

    const { data: previousRows, error: previousError } = await db
      .from('clan_latest')
      .select('name,reputation,season');
    if (previousError) throw previousError;

    const warnings = findWithinSeasonReputationDecreases(clans, previousRows || [], season);
    await updateAudit({ season, total_rep: total, anomalies: warnings });

    if (warnings.length) {
      console.warn('Within-season reputation decreases detected:', JSON.stringify(warnings));
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

    await updateAudit({
      status: warnings.length ? 'warning' : 'success',
      season,
      total_rep: total,
      clan_count: snaps.length,
      war_count: wars.length,
      anomalies: warnings,
      error: null,
    });

    const response = { season, clans: snaps.length, war_rows: wars.length };
    if (warnings.length) response.warnings = warnings;
    return NextResponse.json(response);
  } catch (error) {
    await recordFailure(error);
    console.error('Clan sync failed:', error);
    return NextResponse.json({ error: String(error.message || error) }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;

import { NextResponse } from 'next/server';
import { adminClient } from '../../../lib/supabase';
import { fetchHtml, parse } from '../../../lib/source';

export const dynamic = 'force-dynamic';

async function run(req) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const { clans, wars, closed } = parse(await fetchHtml());
    if (!clans.length) {
      return NextResponse.json({ error: 'No clan table found. The page may load data via JS; point SOURCE_URL at the data endpoint.' }, { status: 502 });
    }
    const db = adminClient();

    // Season: first run is seeded from the war results; later runs bump it when total rep resets.
    const total = clans.reduce((a, c) => a + c.reputation, 0);
    const { data: last } = await db.from('sync_runs').select('season,total_rep').order('captured_at', { ascending: false }).limit(1).maybeSingle();
    const maxWar = wars.length ? Math.max(...wars.map((w) => w.season)) : 0;
    let season = last ? last.season : closed ? maxWar : maxWar + 1;
    if (last && total < Number(last.total_rep) * 0.5) season = last.season + 1;

    const { data: rows, error: e1 } = await db
      .from('clans')
      .upsert(clans.map((c) => ({ name: c.name, master: c.master })), { onConflict: 'name' })
      .select('id,name');
    if (e1) throw e1;
    const ids = new Map(rows.map((r) => [r.name, r.id]));
    const snaps = clans.filter((c) => ids.has(c.name)).map((c) => ({
      clan_id: ids.get(c.name), season, rank: c.rank, members: c.members, max_members: c.max_members, reputation: c.reputation,
    }));
    const { error: e2 } = await db.from('clan_snapshots').insert(snaps);
    if (e2) throw e2;
    const { error: e4 } = await db.from('sync_runs').insert({ season, total_rep: total });
    if (e4) throw e4;
    if (wars.length) {
      const { error: e3 } = await db.from('war_results').upsert(wars, { onConflict: 'season,rank' });
      if (e3) throw e3;
    }
    return NextResponse.json({ season, clans: snaps.length, war_rows: wars.length });
  } catch (e) {
    return NextResponse.json({ error: String(e.message || e) }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;

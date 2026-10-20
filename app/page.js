import { publicClient } from '../lib/supabase';
import Chart from './chart';

export const revalidate = 300;
const fmt = (n) => (n ?? 0).toLocaleString('en-US');
const th = { textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid #333', color: '#9aa' };
const td = { padding: '6px 10px', borderBottom: '1px solid #222' };
const orDash = (v) => (v && v.replace(/[\s\u3164\u200b-]/g, '') ? v : '–');

export default async function Page() {
  const db = publicClient();
  const mine = process.env.TRACK_CLAN || 'Chaos';
  const [r1, r2] = await Promise.all([
    db.from('clan_latest').select('*').order('rank'),
    db.from('war_results').select('*').order('season', { ascending: false }).order('rank'),
  ]);
  const clans = r1.data ?? [], wars = r2.data ?? [];
  const i = clans.findIndex((c) => c.name === mine);
  const me = clans[i], above = clans[i - 1], below = clans[i + 1];
  const season = clans[0]?.season;
  const seasons = [...new Set(wars.map((w) => w.season))];

  const top = [...new Set([mine, ...clans.slice(0, 3).map((c) => c.name)])].slice(0, 4);
  let hist = [];
  if (season != null) {
    const r = await db.from('clan_snapshots').select('captured_at,reputation,clans!inner(name)')
      .eq('season', season).in('clans.name', top).order('captured_at');
    hist = r.data ?? [];
  }
  const series = top.map((name) => ({
    name,
    points: hist.filter((h) => h.clans.name === name).map((h) => ({ t: new Date(h.captured_at).getTime(), v: Number(h.reputation) })),
  }));

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: 20 }}>
      <h1>Clan Tracker</h1>
      {me && (
        <p>
          <b>{me.name}</b> is #{me.rank} with {fmt(me.reputation)} rep (Season {me.season})
          {above && <> · {fmt(above.reputation - me.reputation)} behind {above.name}</>}
          {below && <> · {fmt(me.reputation - below.reputation)} ahead of {below.name}</>}
        </p>
      )}
      <h2>Rep over time</h2>
      <Chart series={series} />
      <h2>Clan Ranking</h2>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead><tr>{['#', 'Clan', 'Master', 'Members', 'Reputation', 'Δ Rep', 'Δ Rank'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
          <tbody>
            {clans.map((c) => (
              <tr key={c.name} style={c.name === mine ? { background: '#1d2a44' } : undefined}>
                <td style={td}>{c.rank}</td><td style={td}>{c.name}</td><td style={td}>{orDash(c.master)}</td>
                <td style={td}>{c.members}/{c.max_members}</td><td style={td}>{fmt(c.reputation)}</td>
                <td style={td}>{c.rep_delta == null ? '–' : (c.rep_delta > 0 ? '+' : '') + fmt(c.rep_delta)}</td>
                <td style={td}>{c.rank_move ? (c.rank_move > 0 ? '▲' : '▼') + Math.abs(c.rank_move) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ color: '#789' }}>Last sync: {clans[0] ? new Date(clans[0].captured_at).toUTCString() : 'never'}</p>
      <h2>War Results</h2>
      {seasons.map((s) => {
        const rows = wars.filter((w) => w.season === s);
        return (
          <details key={s} open={s === seasons[0]} style={{ marginBottom: 8 }}>
            <summary>Season {s}{rows[0]?.ended_on ? ` · ended ${rows[0].ended_on}` : ''}</summary>
            <table style={{ borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed' }}>
              <colgroup><col style={{ width: '8%' }} /><col style={{ width: '52%' }} /><col style={{ width: '16%' }} /><col style={{ width: '24%' }} /></colgroup>
              <thead><tr>{['#', 'Clan', 'Members', 'Reputation'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {rows.map((w) => (
                  <tr key={w.rank} style={w.clan_name === mine ? { background: '#1d2a44' } : undefined}>
                    <td style={td}>{w.rank}</td><td style={td}>{w.clan_name}</td><td style={td}>{w.members}</td><td style={td}>{fmt(w.reputation)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        );
      })}
    </main>
  );
}

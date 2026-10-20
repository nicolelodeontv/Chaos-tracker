import { publicClient } from '../lib/supabase';

export const revalidate = 300;
const fmt = (n) => (n ?? 0).toLocaleString('en-US');
const th = { textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid #333', color: '#9aa' };
const td = { padding: '6px 10px', borderBottom: '1px solid #222' };

export default async function Page() {
  const db = publicClient();
  const mine = process.env.TRACK_CLAN || 'Chaos';
  const [{ data: clans = [] }, { data: wars = [] }] = await Promise.all([
    db.from('clan_latest').select('*').order('rank'),
    db.from('war_results').select('*').order('season', { ascending: false }).order('rank'),
  ]);
  const i = clans.findIndex((c) => c.name === mine);
  const me = clans[i], above = clans[i - 1], below = clans[i + 1];
  const seasons = [...new Set(wars.map((w) => w.season))];

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: 20 }}>
      <h1>Clan Tracker</h1>
      {me && (
        <p>
          <b>{me.name}</b> is #{me.rank} with {fmt(me.reputation)} rep
          {above && <> · {fmt(above.reputation - me.reputation)} behind {above.name}</>}
          {below && <> · {fmt(me.reputation - below.reputation)} ahead of {below.name}</>}
        </p>
      )}
      <h2>Clan Ranking</h2>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead><tr>{['#', 'Clan', 'Master', 'Members', 'Reputation', 'Δ Rep', 'Δ Rank'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
          <tbody>
            {clans.map((c) => (
              <tr key={c.name} style={c.name === mine ? { background: '#1d2a44' } : undefined}>
                <td style={td}>{c.rank}</td><td style={td}>{c.name}</td><td style={td}>{c.master}</td>
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
      {seasons.map((s) => (
        <details key={s} open={s === seasons[0]}>
          <summary>Season {s}{wars.find((w) => w.season === s)?.ended_on ? ` · ended ${wars.find((w) => w.season === s).ended_on}` : ''}</summary>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <tbody>
              {wars.filter((w) => w.season === s).map((w) => (
                <tr key={w.rank} style={w.clan_name === mine ? { background: '#1d2a44' } : undefined}>
                  <td style={td}>{w.rank}</td><td style={td}>{w.clan_name}</td><td style={td}>{w.members}</td><td style={td}>{fmt(w.reputation)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ))}
    </main>
  );
}

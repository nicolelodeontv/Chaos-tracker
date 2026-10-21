import { publicClient } from '../lib/supabase';
import Chart from './chart';

export const revalidate = 300;
const fmt = (n) => (n ?? 0).toLocaleString('en-US');
const orDash = (v) => (v && v.replace(/[\s\u3164\u200b-]/g, '') ? v : '–');

function Row({ rank, name, sub, mem, rep, pct, mine, delta, war }) {
  return (
    <li className={`row${mine ? ' mine' : ''}${war ? ' war' : ''}`}>
      <span className="bar" style={{ width: `${pct}%` }} />
      <span className="rank">{rank}</span>
      <span className="who"><span className="name">{name}</span><small>{sub}{mem ? `, ${mem}` : ''}</small></span>
      <span className="rep">{fmt(rep)}</span>
      {!war && <span className="delta">{delta}</span>}
    </li>
  );
}

function Delta({ c }) {
  const rep = c.rep_delta == null ? null : Number(c.rep_delta);
  return (
    <>
      {c.rank_move ? <span className={c.rank_move > 0 ? 'up' : 'down'}>{c.rank_move > 0 ? '▲' : '▼'}{Math.abs(c.rank_move)} </span> : null}
      {rep ? <span className={rep > 0 ? 'up' : 'down'}>{rep > 0 ? '+' : ''}{fmt(rep)}</span> : rep === 0 ? '0' : '–'}
    </>
  );
}

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
  const max = clans[0]?.reputation || 1;
  const active = clans.filter((c) => c.reputation > 0), idle = clans.filter((c) => c.reputation <= 0);
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
  const clanRow = (c) => (
    <Row key={c.name} rank={c.rank} name={c.name} sub={orDash(c.master)} mem={`${c.members}/${c.max_members}`}
      rep={c.reputation} pct={(c.reputation / max) * 100} mine={c.name === mine} delta={<Delta c={c} />} />
  );

  return (
    <>
      {me && (
        <header className="status">
          <div className="status-in">
            <span className="big">{me.name} is #{me.rank}</span>
            <span>{fmt(me.reputation)} rep</span>
            {above && <span>{fmt(above.reputation - me.reputation)} behind {above.name}</span>}
            {below && <span>{fmt(me.reputation - below.reputation)} ahead of {below.name}</span>}
          </div>
        </header>
      )}
      <main>
        <h1>Clan ranking board</h1>
        <p className="meta">Season {season ?? '–'}</p>
        <p className="meta">Last synced {clans[0] ? new Date(clans[0].captured_at).toUTCString() : 'never'}</p>

        <h2>Reputation over time</h2>
        <Chart series={series} />

        <h2>Ranking</h2>
        <ol className="list">{active.map(clanRow)}</ol>
        {idle.length > 0 && (
          <details>
            <summary>No reputation yet ({idle.length} clans)</summary>
            <ol className="list">{idle.map(clanRow)}</ol>
          </details>
        )}

        <h2>War results</h2>
        {seasons.map((s) => {
          const rows = wars.filter((w) => w.season === s);
          const m = rows[0]?.reputation || 1;
          return (
            <details key={s} open={s === seasons[0]}>
              <summary>Season {s}{rows[0]?.ended_on ? `, ended ${rows[0].ended_on}` : ''}</summary>
              <ol className="list">
                {rows.map((w) => (
                  <Row key={w.rank} war rank={w.rank} name={w.clan_name} sub={`${w.members} members`}
                    rep={w.reputation} pct={(w.reputation / m) * 100} mine={w.clan_name === mine} />
                ))}
              </ol>
            </details>
          );
        })}
      </main>
    </>
  );
}

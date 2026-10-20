const COLORS = ['#5b9cff', '#f0b429', '#e5534b', '#57ab5a'];
const fmt = (n) => Math.round(n).toLocaleString('en-US');

export default function Chart({ series }) {
  const all = series.flatMap((s) => s.points);
  if (new Set(all.map((p) => p.t)).size < 2) {
    return <p style={{ color: '#789' }}>The chart appears after two syncs in the same season.</p>;
  }
  const W = 900, H = 260, L = 70, B = 24;
  const ts = all.map((p) => p.t), vs = all.map((p) => p.v);
  const t0 = Math.min(...ts), t1 = Math.max(...ts), v0 = Math.min(...vs), v1 = Math.max(...vs);
  const x = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - 10);
  const y = (v) => H - B - ((v - v0) / (v1 - v0 || 1)) * (H - B - 10);
  const day = (t) => new Date(t).toISOString().slice(5, 16).replace('T', ' ');
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%' }}>
        <text x={4} y={y(v1) + 4} fill="#789" fontSize="11">{fmt(v1)}</text>
        <text x={4} y={y(v0) + 4} fill="#789" fontSize="11">{fmt(v0)}</text>
        <text x={L} y={H - 6} fill="#789" fontSize="11">{day(t0)}</text>
        <text x={W - 10} y={H - 6} fill="#789" fontSize="11" textAnchor="end">{day(t1)}</text>
        {series.map((s, i) => (
          <polyline key={s.name} fill="none" stroke={COLORS[i % 4]} strokeWidth="2"
            points={s.points.map((p) => `${x(p.t)},${y(p.v)}`).join(' ')} />
        ))}
      </svg>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {series.map((s, i) => <span key={s.name}><span style={{ color: COLORS[i % 4] }}>●</span> {s.name}</span>)}
      </div>
    </div>
  );
}

const COLORS = ['#c9a24b', '#8fa3c9', '#6fa37a', '#c4604f'];
const fmt = (n) => Math.round(n).toLocaleString('en-US');

export default function Chart({ series }) {
  const all = series.flatMap((s) => s.points);
  if (new Set(all.map((p) => p.t)).size < 2) {
    return <p className="empty">The chart appears after two syncs in the same season.</p>;
  }
  const W = 760, H = 300, L = 64, R = 175, B = 26, T = 12;
  const ts = all.map((p) => p.t), vs = all.map((p) => p.v);
  const t0 = Math.min(...ts), t1 = Math.max(...ts), v0 = Math.min(...vs), v1 = Math.max(...vs);
  const x = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R);
  const y = (v) => H - B - ((v - v0) / (v1 - v0 || 1)) * (H - B - T);
  const day = (t) => new Date(t).toISOString().slice(5, 16).replace('T', ' ');
  const labels = series
    .map((s, i) => ({ name: s.name, v: s.points.length ? s.points[s.points.length - 1].v : 0, color: COLORS[i % 4], y: s.points.length ? y(s.points[s.points.length - 1].v) : 0, x: s.points.length ? x(s.points[s.points.length - 1].t) : 0 }))
    .sort((a, b) => a.y - b.y);
  labels.forEach((l, i) => { if (i && l.y < labels[i - 1].y + 17) l.y = labels[i - 1].y + 17; });
  const f = { fontFamily: 'var(--font-sans), sans-serif', fontSize: 13, fill: '#6b7a99' };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%' }} role="img" aria-label="Reputation over time">
      <text x={4} y={y(v1) + 4} {...f}>{fmt(v1)}</text>
      <text x={4} y={y(v0) + 4} {...f}>{fmt(v0)}</text>
      <text x={L} y={H - 6} {...f}>{day(t0)}</text>
      <text x={W - R} y={H - 6} textAnchor="end" {...f}>{day(t1)}</text>
      {series.map((s, i) => (
        <polyline key={s.name} fill="none" stroke={COLORS[i % 4]} strokeWidth={i === 0 ? 3 : 2}
          points={s.points.map((p) => `${x(p.t)},${y(p.v)}`).join(' ')} />
      ))}
      {labels.map((l) => (
        <text key={l.name} x={l.x + 8} y={l.y + 4} {...f} fill={l.color} style={{ fontWeight: 600 }}>{l.name} {fmt(l.v)}</text>
      ))}
    </svg>
  );
}

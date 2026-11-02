function formatNumber(value, suffix = '') {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(1)}${suffix}` : '–';
}

function formatCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number).toLocaleString('en-US') : '0';
}

function formatDay(value) {
  if (!value) return '–';
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime())
    ? '–'
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function TrendChart({ rows }) {
  const values = rows.map((row) => Number(row.mean_absolute_error)).filter(Number.isFinite);
  if (rows.length < 2 || values.length < 2) {
    return <p className="forecast-note">A trend line will appear after forecasts are scored on at least two different days.</p>;
  }

  const width = 760;
  const height = 170;
  const left = 42;
  const right = 18;
  const top = 18;
  const bottom = 34;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = max === min ? Math.max(1, max * 0.08) : (max - min) * 0.12;
  const low = Math.max(0, min - pad);
  const high = max + pad;
  const dayTimes = rows.map((row) => new Date(`${row.scored_day}T00:00:00.000Z`).getTime());
  const firstDay = Math.min(...dayTimes);
  const lastDay = Math.max(...dayTimes);
  const points = rows.map((row, index) => {
    const x = left + ((dayTimes[index] - firstDay) / (lastDay - firstDay || 1)) * (width - left - right);
    const value = Number(row.mean_absolute_error);
    const y = height - bottom - ((value - low) / (high - low || 1)) * (height - top - bottom);
    return { x, y, value, day: row.scored_day };
  });

  return (
    <div className="forecast-trend-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Daily mean absolute forecast error; lower is better">
        <line x1={left} y1={top} x2={width - right} y2={top} className="forecast-chart-grid" />
        <line x1={left} y1={height - bottom} x2={width - right} y2={height - bottom} className="forecast-chart-grid" />
        <text x={left - 8} y={top + 4} textAnchor="end" className="forecast-chart-label">{formatNumber(high)}</text>
        <text x={left - 8} y={height - bottom + 4} textAnchor="end" className="forecast-chart-label">{formatNumber(low)}</text>
        <polyline
          fill="none"
          className="forecast-trend-line"
          points={points.map((point) => `${point.x},${point.y}`).join(' ')}
        />
        {points.map((point) => (
          <g key={point.day}>
            <circle cx={point.x} cy={point.y} r="4" className="forecast-trend-dot">
              <title>{formatDay(point.day)}: {formatNumber(point.value)} rep average error</title>
            </circle>
          </g>
        ))}
        <text x={left} y={height - 8} className="forecast-chart-label">{formatDay(points[0].day)}</text>
        <text x={width - right} y={height - 8} textAnchor="end" className="forecast-chart-label">{formatDay(points[points.length - 1].day)}</text>
      </svg>
    </div>
  );
}

export default function ForecastReliability({ trend, clans, available = true }) {
  if (!available) {
    return (
      <section className="forecast-reliability" aria-label="Forecast trend and clan reliability">
        <p className="forecast-note">Historical trend and clan reliability are waiting for database migration 008.</p>
      </section>
    );
  }

  const trendRows = (Array.isArray(trend) ? trend : []).slice(-30);
  const clanRows = Array.isArray(clans) ? clans : [];
  const ranked = clanRows
    .filter((row) => Number(row.resolved_count) >= 5 && Number.isFinite(Number(row.mean_absolute_error)))
    .sort((a, b) => (
      Number(a.mean_absolute_error) - Number(b.mean_absolute_error)
      || Number(b.direction_accuracy_pct) - Number(a.direction_accuracy_pct)
    ));
  const buildingSample = clanRows.filter((row) => Number(row.resolved_count) < 5);

  return (
    <section className="forecast-reliability" aria-label="Forecast trend and clan reliability">
      <h3 className="forecast-subtitle">Accuracy trend · last 30 scored days</h3>
      {trendRows.length > 0 ? (
        <>
          <TrendChart rows={trendRows} />
          <div className="forecast-table-wrap">
            <table className="forecast-table forecast-trend-table">
              <thead>
                <tr>
                  <th scope="col">Scored day</th>
                  <th scope="col">Forecasts</th>
                  <th scope="col">Mean error</th>
                  <th scope="col">Direction hit rate</th>
                </tr>
              </thead>
              <tbody>
                {trendRows.slice().reverse().map((row) => (
                  <tr key={row.scored_day}>
                    <th scope="row">{formatDay(row.scored_day)}</th>
                    <td>{formatCount(row.resolved_count)}</td>
                    <td>{formatNumber(row.mean_absolute_error)} rep</td>
                    <td>{formatNumber(row.direction_accuracy_pct, '%')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="forecast-note">Daily accuracy history will appear after forecasts have been scored on at least one day.</p>
      )}

      <h3 className="forecast-subtitle">Clan reliability leaderboard</h3>
      <p className="forecast-note">
        Ranked by lowest mean absolute error, with direction hit rate as the tie-breaker. A clan needs at least five scored forecasts to qualify; ten or more provide a larger sample, not a guarantee.
      </p>
      {ranked.length > 0 ? (
        <div className="forecast-table-wrap">
          <table className="forecast-table forecast-reliability-table">
            <thead>
              <tr>
                <th scope="col">Clan</th>
                <th scope="col">Scored</th>
                <th scope="col">Mean error</th>
                <th scope="col">Direction hit rate</th>
                <th scope="col">Sample</th>
              </tr>
            </thead>
            <tbody>
              {ranked.slice(0, 15).map((row, index) => (
                <tr key={row.clan_id}>
                  <th scope="row"><span className="forecast-rank">{index + 1}.</span> {row.clan_name}</th>
                  <td>{formatCount(row.resolved_count)}</td>
                  <td>{formatNumber(row.mean_absolute_error)} rep</td>
                  <td>{formatNumber(row.direction_accuracy_pct, '%')}</td>
                  <td>{Number(row.resolved_count) >= 10 ? 'Larger' : 'Early'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="forecast-note">No clan has five scored forecasts yet. The leaderboard will populate as the sample grows.</p>
      )}
      {buildingSample.length > 0 && (
        <p className="forecast-note">
          {formatCount(buildingSample.length)} clan(s) are still building the minimum five-forecast sample.
        </p>
      )}
    </section>
  );
}

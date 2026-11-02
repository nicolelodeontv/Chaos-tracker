function formatRep(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number).toLocaleString('en-US') : '–';
}

function formatMetric(value, suffix = '') {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(1)}${suffix}` : '–';
}

export default function ForecastAccuracy({ metrics, forecasts, available = true }) {
  if (!available) {
    return (
      <section className="forecast-panel" aria-label="Forecast accuracy tracker">
        <p className="forecast-note">
          Forecast tracking is waiting for database migration 007. The existing ranking and sync data remain available.
        </p>
      </section>
    );
  }

  const resolvedCount = Number(metrics?.resolved_count) || 0;
  const pendingCount = Number(metrics?.pending_count) || 0;
  const meanAbsoluteError = metrics?.mean_absolute_error;
  const directionAccuracy = metrics?.direction_accuracy_pct;
  const rows = Array.isArray(forecasts) ? forecasts : [];

  return (
    <section className="forecast-panel" aria-label="Forecast accuracy tracker">
      <div className="forecast-metrics">
        <div className="forecast-stat">
          <strong>{meanAbsoluteError == null ? '–' : `${formatMetric(meanAbsoluteError)} rep`}</strong>
          <span>Mean absolute error</span>
        </div>
        <div className="forecast-stat">
          <strong>{directionAccuracy == null ? '–' : formatMetric(directionAccuracy, '%')}</strong>
          <span>Direction hit rate</span>
        </div>
        <div className="forecast-stat">
          <strong>{formatRep(resolvedCount)}</strong>
          <span>Scored forecasts</span>
        </div>
      </div>

      <p className="forecast-note">
        {resolvedCount > 0
          ? `Season-to-date metrics include ${formatRep(pendingCount)} pending 24-hour forecast(s). Lower mean error is better.`
          : 'Accuracy results will appear after the first 24-hour forecasts reach their target time.'}
        {' '}Predictions use the trailing same-season reputation trend. Outcomes use the first available same-season snapshot at or after the target, so the observed value may be slightly later than 24 hours.
      </p>

      <h3 className="forecast-subtitle">Latest 24-hour projections</h3>
      {rows.length > 0 ? (
        <div className="forecast-table-wrap">
          <table className="forecast-table">
            <thead>
              <tr>
                <th scope="col">Clan</th>
                <th scope="col">Starting rep</th>
                <th scope="col">24h estimate</th>
                <th scope="col">Actual</th>
                <th scope="col">Error</th>
                <th scope="col">History</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((forecast) => {
                const change = Number(forecast.forecast_reputation) - Number(forecast.base_reputation);
                const changeClass = change > 0 ? 'positive' : change < 0 ? 'negative' : '';
                return (
                  <tr key={forecast.clan_id}>
                    <th scope="row">{forecast.clan_name}</th>
                    <td>{formatRep(forecast.base_reputation)}</td>
                    <td>{formatRep(forecast.forecast_reputation)}</td>
                    <td>{forecast.resolution_status === 'resolved'
                      ? formatRep(forecast.actual_reputation)
                      : 'Pending'}</td>
                    <td className={forecast.absolute_error == null ? '' : 'forecast-error'}>
                      {forecast.absolute_error == null ? '–' : formatRep(forecast.absolute_error)}
                    </td>
                    <td>{formatMetric(forecast.history_hours, 'h')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="forecast-note">
          No clan has enough same-season history for a forecast yet. At least six hours of snapshots are required.
        </p>
      )}
    </section>
  );
}

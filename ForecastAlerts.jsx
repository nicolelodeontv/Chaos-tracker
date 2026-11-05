import LocalDate from "./LocalDate";

function deliveryLabel(status) {
  if (status === "sent") return "Discord delivered";
  if (status === "failed") return "Discord delivery failed";
  if (status === "not_configured") return "Discord not configured";
  return "Delivery queued";
}

export default function ForecastAlerts({ alerts, available = true }) {
  if (!available) {
    return (
      <section className="forecast-alerts" aria-label="Forecast alerts action center">
        <p className="forecast-note">
          Forecast alerts are waiting for database migration 009. Existing forecast tracking remains available.
        </p>
      </section>
    );
  }

  const rows = Array.isArray(alerts) ? alerts : [];
  const criticalCount = rows.filter((alert) => alert.severity === "critical").length;
  const notDeliveredCount = rows.filter((alert) => alert.delivery_status !== "sent").length;

  return (
    <section className="forecast-alerts" aria-label="Forecast alerts action center">
      <div className="forecast-alert-summary">
        <div className="forecast-alert-stat">
          <strong>{rows.length}</strong>
          <span>Recent alerts</span>
        </div>
        <div className="forecast-alert-stat">
          <strong>{criticalCount}</strong>
          <span>Critical alerts</span>
        </div>
        <div className="forecast-alert-stat">
          <strong>{notDeliveredCount}</strong>
          <span>Not delivered</span>
        </div>
      </div>

      {rows.length > 0 ? (
        <ol className="forecast-alert-list">
          {rows.map((alert) => (
            <li className={"forecast-alert-item severity-" + alert.severity} key={alert.id}>
              <div className="forecast-alert-heading">
                <strong>{alert.title}</strong>
                <span className={"forecast-alert-severity severity-" + alert.severity}>
                  {alert.severity}
                </span>
              </div>
              <p>{alert.detail}</p>
              <div className="forecast-alert-meta">
                <span>{alert.clan_name} · Season {alert.season}</span>
                {alert.current_rank != null && alert.projected_rank != null && (
                  <span>#{alert.current_rank} → #{alert.projected_rank}</span>
                )}
                <LocalDate value={alert.created_at} />
                <span>{deliveryLabel(alert.delivery_status)}</span>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="forecast-note">
          No forecast alerts have been recorded for this season. Significant misses, direction reversals, and top-10 projections will appear here.
        </p>
      )}
      <p className="forecast-note">
        Rank alerts require a fresh forecast sample across at least half of the active clans. Repeated top-10 warnings use a 12-hour cooldown; forecast outcome alerts are recorded once per forecast.
      </p>
    </section>
  );
}

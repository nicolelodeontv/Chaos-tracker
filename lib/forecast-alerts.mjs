const DEFAULTS = Object.freeze({
  minMissRep: 1000,
  missPercent: 0.005,
  criticalMissRep: 5000,
  criticalMissPercent: 0.02,
  minDirectionChangeRep: 1000,
  topN: 10,
  minForecastCoverage: 0.5,
  minForecasts: 5,
  maxForecastAgeHours: 6,
  cohortToleranceMinutes: 60,
  rankCooldownHours: 12,
});

const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const wholeRep = (value) => Math.round(value).toLocaleString("en-US");

function optionsWithDefaults(options = {}) {
  return { ...DEFAULTS, ...options };
}

export function classifyResolvedForecast(forecast, options = {}) {
  const config = optionsWithDefaults(options);
  const base = finite(forecast?.base_reputation ?? forecast?.baseReputation);
  const predicted = finite(forecast?.forecast_reputation ?? forecast?.forecastReputation);
  const actual = finite(forecast?.actual_reputation ?? forecast?.actualReputation);
  const forecastId = forecast?.id;
  if (base == null || predicted == null || actual == null || forecastId == null) return [];

  const error = Math.abs(actual - predicted);
  const predictedChange = predicted - base;
  const actualChange = actual - base;
  const missThreshold = Math.max(config.minMissRep, Math.abs(base) * config.missPercent);
  const criticalThreshold = Math.max(config.criticalMissRep, Math.abs(base) * config.criticalMissPercent);
  const clanName = String(forecast?.clans?.name || forecast?.clan_name || "Unknown clan");
  const clanId = forecast?.clan_id ?? null;
  const events = [];

  if (error >= missThreshold) {
    events.push({
      alertType: "forecast_miss",
      severity: error >= criticalThreshold ? "critical" : "warning",
      title: error >= criticalThreshold ? "Major 24-hour forecast miss" : "24-hour forecast miss",
      detail: clanName + " finished at " + wholeRep(actual) + " rep against a projection of "
        + wholeRep(predicted) + " (" + wholeRep(error) + " rep error).",
      clanId,
      clanName,
      sourceForecastId: forecastId,
      predictedReputation: Math.round(predicted),
      actualReputation: Math.round(actual),
      absoluteError: Math.round(error),
      cooldownKey: "forecast-miss:" + forecastId,
      dedupeKey: "forecast-miss:" + forecastId,
    });
  }

  if (
    predictedChange !== 0
    && actualChange !== 0
    && Math.sign(predictedChange) !== Math.sign(actualChange)
    && Math.abs(actualChange) >= config.minDirectionChangeRep
  ) {
    events.push({
      alertType: "direction_reversal",
      severity: "critical",
      title: "Forecast direction reversed",
      detail: clanName + " was projected to " + (predictedChange > 0 ? "gain" : "lose")
        + " reputation, but actually " + (actualChange > 0 ? "gained " : "lost ")
        + wholeRep(Math.abs(actualChange)) + " rep.",
      clanId,
      clanName,
      sourceForecastId: forecastId,
      predictedReputation: Math.round(predicted),
      actualReputation: Math.round(actual),
      absoluteError: Math.round(error),
      cooldownKey: "direction-reversal:" + forecastId,
      dedupeKey: "direction-reversal:" + forecastId,
    });
  }

  return events;
}

export function buildProjectedRankAlerts(currentClans, forecasts, options = {}) {
  const config = optionsWithDefaults(options);
  const clans = (Array.isArray(currentClans) ? currentClans : [])
    .map((clan) => ({
      ...clan,
      clanId: clan.clan_id ?? clan.id,
      currentRank: finite(clan.rank),
      currentReputation: finite(clan.reputation),
    }))
    .filter((clan) => clan.clanId != null && clan.currentRank != null && clan.currentReputation != null);
  if (clans.length <= config.topN) return [];

  const now = new Date(options.now ?? Date.now()).getTime();
  if (!Number.isFinite(now)) return [];
  const maxAge = config.maxForecastAgeHours * 60 * 60 * 1000;
  const candidates = (Array.isArray(forecasts) ? forecasts : [])
    .filter((forecast) => {
      const forecastAt = new Date(forecast.forecast_at).getTime();
      const targetAt = new Date(forecast.target_at).getTime();
      const historyHours = finite(forecast.history_hours);
      return forecast.resolution_status === "pending"
        && forecast.clan_id != null
        && finite(forecast.forecast_reputation) != null
        && historyHours != null
        && historyHours >= 6
        && Number.isFinite(forecastAt)
        && Number.isFinite(targetAt)
        && forecastAt <= now
        && now - forecastAt <= maxAge;
    });
  if (!candidates.length) return [];

  const newestTarget = Math.max(...candidates.map((item) => new Date(item.target_at).getTime()));
  const tolerance = config.cohortToleranceMinutes * 60 * 1000;
  const cohort = candidates.filter((item) => (
    Math.abs(new Date(item.target_at).getTime() - newestTarget) <= tolerance
  ));
  const requiredCoverage = Math.max(config.minForecasts, Math.ceil(clans.length * config.minForecastCoverage));
  if (cohort.length < requiredCoverage) return [];

  const forecastByClan = new Map();
  for (const forecast of cohort) {
    const key = String(forecast.clan_id);
    const previous = forecastByClan.get(key);
    if (!previous || new Date(forecast.forecast_at) > new Date(previous.forecast_at)) {
      forecastByClan.set(key, forecast);
    }
  }

  const projected = clans.map((clan) => {
    const forecast = forecastByClan.get(String(clan.clanId));
    return {
      ...clan,
      forecast,
      projectedReputation: forecast
        ? finite(forecast.forecast_reputation)
        : clan.currentReputation,
    };
  }).sort((a, b) => (
    b.projectedReputation - a.projectedReputation
    || a.currentRank - b.currentRank
    || String(a.clanId).localeCompare(String(b.clanId))
  ));

  const projectedRankByClan = new Map(
    projected.map((clan, index) => [String(clan.clanId), index + 1]),
  );
  const cooldownBucket = Math.floor(newestTarget / (config.rankCooldownHours * 60 * 60 * 1000));
  const events = [];

  for (const clan of clans) {
    const forecast = forecastByClan.get(String(clan.clanId));
    if (!forecast) continue;
    const projectedRank = projectedRankByClan.get(String(clan.clanId));
    const entering = clan.currentRank > config.topN && projectedRank <= config.topN;
    const exiting = clan.currentRank <= config.topN && projectedRank > config.topN;
    if (!entering && !exiting) continue;

    const alertType = entering ? "projected_top_ten_entry" : "projected_top_ten_exit";
    const label = entering ? "Projected top-10 entry" : "Projected top-10 exit";
    events.push({
      alertType,
      severity: "warning",
      title: label,
      detail: clan.name + " is projected to move from #" + clan.currentRank + " to #"
        + projectedRank + " over the next 24 hours.",
      clanId: clan.clanId,
      clanName: clan.name,
      sourceForecastId: forecast.id,
      predictedReputation: Math.round(finite(forecast.forecast_reputation)),
      actualReputation: null,
      absoluteError: null,
      currentRank: clan.currentRank,
      projectedRank,
      cooldownKey: "rank-boundary:" + alertType + ":" + clan.clanId,
      dedupeKey: "rank-boundary:" + alertType + ":" + clan.clanId + ":" + cooldownBucket,
    });
  }

  return events;
}

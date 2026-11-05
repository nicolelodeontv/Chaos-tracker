// A deliberately simple, auditable 24-hour linear forecast based on recent same-season history.
export const FORECAST_HORIZON_HOURS = 24;
export const FORECAST_WINDOW_HOURS = 24;
export const MIN_FORECAST_HISTORY_HOURS = 6;
export const MIN_FORECAST_CALIBRATION_SAMPLES = 5;
export const MAX_FORECAST_CALIBRATION_SAMPLES = 10;
export const MAX_FORECAST_CALIBRATION_ADJUSTMENT_PCT = 5;

const toMs = (value) => {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};

export function buildClanForecast(snapshots, options = {}) {
  const horizonHours = Number.isFinite(options.horizonHours) && options.horizonHours > 0
    ? options.horizonHours
    : FORECAST_HORIZON_HOURS;
  const windowHours = Number.isFinite(options.windowHours) && options.windowHours > 0
    ? options.windowHours
    : FORECAST_WINDOW_HOURS;
  const minHistoryHours = Number.isFinite(options.minHistoryHours) && options.minHistoryHours >= 0
    ? options.minHistoryHours
    : MIN_FORECAST_HISTORY_HOURS;

  const sorted = (Array.isArray(snapshots) ? snapshots : [])
    .map((snapshot) => ({ ...snapshot, _time: toMs(snapshot.captured_at) }))
    .filter((snapshot) => (
      snapshot._time != null
      && snapshot.reputation != null
      && Number.isFinite(Number(snapshot.reputation))
    ))
    .sort((a, b) => a._time - b._time);

  if (sorted.length < 2) return null;

  const latest = sorted[sorted.length - 1];
  const latestSeason = String(latest.season);
  const cutoff = latest._time - windowHours * 60 * 60 * 1000;
  const history = sorted.filter((snapshot) => (
    String(snapshot.season) === latestSeason
    && snapshot._time >= cutoff
    && snapshot._time <= latest._time
  ));

  if (history.length < 2) return null;

  const first = history[0];
  const historyHours = (latest._time - first._time) / (60 * 60 * 1000);
  if (!Number.isFinite(historyHours) || historyHours < minHistoryHours) return null;

  const baseReputation = Number(latest.reputation);
  const startingReputation = Number(first.reputation);
  const ratePerHour = (baseReputation - startingReputation) / historyHours;
  if (!Number.isFinite(ratePerHour) || !Number.isFinite(baseReputation)) return null;

  return {
    season: latest.season,
    forecastAt: latest.captured_at,
    targetAt: new Date(latest._time + horizonHours * 60 * 60 * 1000).toISOString(),
    horizonHours,
    baseReputation: Math.round(baseReputation),
    forecastReputation: Math.max(0, Math.round(baseReputation + ratePerHour * horizonHours)),
    ratePerHour: Number(ratePerHour.toFixed(6)),
    historyHours: Number(historyHours.toFixed(3)),
  };
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Apply a small per-clan correction learned only from earlier, resolved forecasts.
 * The median relative error is robust to one unusual outcome. Corrections are capped
 * and shrunk so five observations can enable calibration without allowing a tiny
 * sample to dominate the baseline projection.
 */
export function applyClanForecastCalibration(forecast, historicalForecasts, options = {}) {
  if (!forecast || !Number.isFinite(Number(forecast.forecastReputation))) return forecast;

  const minSamples = Number.isInteger(options.minSamples) && options.minSamples > 0
    ? options.minSamples
    : MIN_FORECAST_CALIBRATION_SAMPLES;
  const maxSamples = Number.isInteger(options.maxSamples) && options.maxSamples >= minSamples
    ? options.maxSamples
    : MAX_FORECAST_CALIBRATION_SAMPLES;
  const maxAdjustmentPct = Number.isFinite(options.maxAdjustmentPct) && options.maxAdjustmentPct > 0
    ? options.maxAdjustmentPct
    : MAX_FORECAST_CALIBRATION_ADJUSTMENT_PCT;
  const forecastTime = toMs(forecast.forecastAt);
  const season = forecast.season == null ? null : String(forecast.season);

  const prior = (Array.isArray(historicalForecasts) ? historicalForecasts : [])
    .map((row) => ({ ...row, _time: toMs(row.forecast_at) }))
    .filter((row) => {
      const predicted = Number(row.forecast_reputation);
      const actual = Number(row.actual_reputation);
      return row.resolution_status === 'resolved'
        && row._time != null
        && forecastTime != null
        && row._time < forecastTime
        && (season == null || String(row.season) === season)
        && Number.isFinite(predicted)
        && predicted > 0
        && Number.isFinite(actual)
        && actual >= 0;
    })
    .sort((a, b) => b._time - a._time)
    .slice(0, maxSamples);

  const sampleCount = prior.length;
  const emptyCalibration = {
    status: 'insufficient_data',
    sampleCount,
    requiredSamples: minSamples,
    samplesUsed: sampleCount,
    medianRelativeErrorPct: 0,
    appliedAdjustmentPct: 0,
  };
  if (sampleCount < minSamples) {
    return { ...forecast, calibration: emptyCalibration };
  }

  const relativeErrors = prior.map((row) => (
    (Number(row.actual_reputation) - Number(row.forecast_reputation))
      / Number(row.forecast_reputation) * 100
  ));
  const medianRelativeErrorPct = median(relativeErrors);
  const boundedErrorPct = Math.max(-maxAdjustmentPct, Math.min(maxAdjustmentPct, medianRelativeErrorPct));
  const sampleWeight = sampleCount / (sampleCount + minSamples);
  const appliedAdjustmentPct = boundedErrorPct * sampleWeight;
  const baselineForecastReputation = Number(forecast.forecastReputation);
  const calibratedForecastReputation = Math.max(
    0,
    Math.round(baselineForecastReputation * (1 + appliedAdjustmentPct / 100)),
  );
  const horizonHours = Number(forecast.horizonHours);
  const baseReputation = Number(forecast.baseReputation);
  const calibratedRatePerHour = Number.isFinite(horizonHours) && horizonHours > 0
    && Number.isFinite(baseReputation)
    ? Number(((calibratedForecastReputation - baseReputation) / horizonHours).toFixed(6))
    : forecast.ratePerHour;

  return {
    ...forecast,
    forecastReputation: calibratedForecastReputation,
    ratePerHour: calibratedRatePerHour,
    calibration: {
      status: 'calibrated',
      sampleCount,
      requiredSamples: minSamples,
      samplesUsed: sampleCount,
      medianRelativeErrorPct: Number(medianRelativeErrorPct.toFixed(3)),
      appliedAdjustmentPct: Number(appliedAdjustmentPct.toFixed(3)),
    },
  };
}

export function scoreClanForecast(forecast, actualReputation) {
  if (!forecast) return null;
  const actual = Number(actualReputation);
  const base = Number(forecast.baseReputation);
  const predicted = Number(forecast.forecastReputation);
  if (![actual, base, predicted].every(Number.isFinite)) return null;

  const predictedChange = predicted - base;
  const actualChange = actual - base;
  return {
    absoluteError: Math.abs(actual - predicted),
    predictedChange,
    actualChange,
    directionHit: Math.sign(predictedChange) === Math.sign(actualChange),
  };
}

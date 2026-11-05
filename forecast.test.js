import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyClanForecastCalibration,
  buildClanForecast,
  scoreClanForecast,
} from './forecast.js';

const snapshot = (captured_at, reputation, season = 4) => ({
  captured_at,
  reputation,
  season,
});

const resolvedForecast = (day, actual, predicted = 1000, season = 4, resolved_at = `2026-11-${day}T01:00:00.000Z`) => ({
  season,
  forecast_at: `2026-11-${day}T00:00:00.000Z`,
  forecast_reputation: predicted,
  actual_reputation: actual,
  resolution_status: 'resolved',
  resolved_at,
});

test('projects 24 hours from the measured same-season average', () => {
  const forecast = buildClanForecast([
    snapshot('2026-11-01T00:00:00.000Z', 100),
    snapshot('2026-11-01T06:00:00.000Z', 130),
    snapshot('2026-11-01T12:00:00.000Z', 160),
  ]);
  assert.equal(forecast.baseReputation, 160);
  assert.equal(forecast.forecastReputation, 280);
  assert.equal(forecast.ratePerHour, 5);
  assert.equal(forecast.historyHours, 12);
  assert.equal(forecast.targetAt, '2026-11-02T12:00:00.000Z');
});

test('does not forecast before six hours of history are available', () => {
  assert.equal(buildClanForecast([
    snapshot('2026-11-01T00:00:00.000Z', 100),
    snapshot('2026-11-01T05:59:59.000Z', 120),
  ]), null);
});

test('does not mix snapshots from different seasons', () => {
  assert.equal(buildClanForecast([
    snapshot('2026-11-01T00:00:00.000Z', 100, 3),
    snapshot('2026-11-01T18:00:00.000Z', 500, 4),
    snapshot('2026-11-01T21:00:00.000Z', 530, 4),
  ]), null);
});

test('clamps a falling reputation forecast at zero', () => {
  const forecast = buildClanForecast([
    snapshot('2026-11-01T00:00:00.000Z', 100),
    snapshot('2026-11-01T08:00:00.000Z', 20),
  ]);
  assert.equal(forecast.ratePerHour, -10);
  assert.equal(forecast.forecastReputation, 0);
});

test('ignores invalid samples and samples outside the trailing 24-hour window', () => {
  const forecast = buildClanForecast([
    snapshot('2026-10-30T00:00:00.000Z', 10),
    snapshot('invalid-date', 999),
    snapshot('2026-10-31T12:00:00.000Z', 100),
    snapshot('2026-11-01T00:00:00.000Z', 160),
  ]);
  assert.equal(forecast.baseReputation, 160);
  assert.equal(forecast.historyHours, 12);
  assert.equal(forecast.forecastReputation, 280);
});

test('leaves forecasts unadjusted until five earlier same-season outcomes exist', () => {
  const forecast = {
    season: 4,
    forecastAt: '2026-11-05T00:00:00.000Z',
    horizonHours: 24,
    baseReputation: 1000,
    forecastReputation: 1200,
    ratePerHour: 8.333333,
  };
  const calibrated = applyClanForecastCalibration(forecast, [
    resolvedForecast('01', 1100),
    resolvedForecast('02', 1100),
    resolvedForecast('03', 1100),
    resolvedForecast('04', 1100),
  ]);
  assert.equal(calibrated.forecastReputation, 1200);
  assert.equal(calibrated.calibration.status, 'insufficient_data');
  assert.equal(calibrated.calibration.sampleCount, 4);
});

test('excludes outcomes that resolved after the new forecast timestamp', () => {
  const forecast = {
    season: 4,
    forecastAt: '2026-11-06T00:00:00.000Z',
    horizonHours: 24,
    baseReputation: 1000,
    forecastReputation: 1200,
    ratePerHour: 8.333333,
  };
  const history = [
    resolvedForecast('01', 1100),
    resolvedForecast('02', 1100),
    resolvedForecast('03', 1100),
    resolvedForecast('04', 1100),
    resolvedForecast('05', 2000, 1000, 4, '2026-11-06T00:00:01.000Z'),
  ];
  const calibrated = applyClanForecastCalibration(forecast, history);
  assert.equal(calibrated.calibration.status, 'insufficient_data');
  assert.equal(calibrated.calibration.sampleCount, 4);
  assert.equal(calibrated.forecastReputation, 1200);
});

test('uses the median prior relative error and a conservative capped correction', () => {
  const forecast = {
    season: 4,
    forecastAt: '2026-11-06T00:00:00.000Z',
    horizonHours: 24,
    baseReputation: 1000,
    forecastReputation: 2000,
    ratePerHour: 41.666667,
  };
  const calibrated = applyClanForecastCalibration(forecast, [
    resolvedForecast('01', 1100),
    resolvedForecast('02', 1100),
    resolvedForecast('03', 1100),
    resolvedForecast('04', 1100),
    resolvedForecast('05', 2000),
  ]);
  assert.equal(calibrated.calibration.status, 'calibrated');
  assert.equal(calibrated.calibration.sampleCount, 5);
  assert.equal(calibrated.calibration.medianRelativeErrorPct, 10);
  assert.equal(calibrated.calibration.appliedAdjustmentPct, 2.5);
  assert.equal(calibrated.forecastReputation, 2050);
  assert.equal(calibrated.ratePerHour, 43.75);
});

test('only uses earlier resolved forecasts from the same season and latest ten samples', () => {
  const forecast = {
    season: 4,
    forecastAt: '2026-11-20T00:00:00.000Z',
    horizonHours: 24,
    baseReputation: 1000,
    forecastReputation: 1000,
    ratePerHour: 0,
  };
  const history = Array.from({ length: 12 }, (_, index) => (
    resolvedForecast(String(index + 1).padStart(2, '0'), 900)
  ));
  history.push(
    resolvedForecast('19', 1000, 1000, 3),
    resolvedForecast('21', 1200),
    {
      ...resolvedForecast('18', 1200),
      resolution_status: 'pending',
    },
  );
  const calibrated = applyClanForecastCalibration(forecast, history);
  assert.equal(calibrated.calibration.sampleCount, 10);
  assert.equal(calibrated.calibration.medianRelativeErrorPct, -10);
  assert.equal(calibrated.calibration.appliedAdjustmentPct, -3.333);
  assert.equal(calibrated.forecastReputation, 967);
});

test('scores absolute error and whether the direction was correct', () => {
  assert.deepEqual(scoreClanForecast({
    baseReputation: 160,
    forecastReputation: 280,
  }, 310), {
    absoluteError: 30,
    predictedChange: 120,
    actualChange: 150,
    directionHit: true,
  });
});

test('recognizes a flat forecast as directionally correct only when reality is flat', () => {
  const forecast = { baseReputation: 50, forecastReputation: 50 };
  assert.equal(scoreClanForecast(forecast, 50).directionHit, true);
  assert.equal(scoreClanForecast(forecast, 51).directionHit, false);
});

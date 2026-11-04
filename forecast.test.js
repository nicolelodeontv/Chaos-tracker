import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClanForecast, scoreClanForecast } from './forecast.js';

const snapshot = (captured_at, reputation, season = 4) => ({
  captured_at,
  reputation,
  season,
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

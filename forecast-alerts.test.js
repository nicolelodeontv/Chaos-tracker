import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProjectedRankAlerts,
  classifyResolvedForecast,
} from "./lib/forecast-alerts.mjs";

const forecast = (overrides = {}) => ({
  id: 17,
  clan_id: 4,
  base_reputation: 1000000,
  forecast_reputation: 1010000,
  actual_reputation: 1000000,
  clans: { name: "Alpha" },
  ...overrides,
});

test("flags a significant forecast miss but keeps moderate misses as warnings", () => {
  const [alert] = classifyResolvedForecast(forecast());
  assert.equal(alert.alertType, "forecast_miss");
  assert.equal(alert.severity, "warning");
  assert.equal(alert.absoluteError, 10000);
});

test("escalates exceptionally large forecast misses to critical", () => {
  const [alert] = classifyResolvedForecast(forecast({
    forecast_reputation: 1040000,
    actual_reputation: 1000000,
  }));
  assert.equal(alert.alertType, "forecast_miss");
  assert.equal(alert.severity, "critical");
});

test("detects a meaningful direction reversal independently of the miss threshold", () => {
  const alerts = classifyResolvedForecast(forecast({
    forecast_reputation: 1001000,
    actual_reputation: 998500,
  }));
  assert.deepEqual(alerts.map((alert) => alert.alertType), ["direction_reversal"]);
  assert.equal(alerts[0].severity, "critical");
});

test("does not alert on tiny reversals, invalid values, or flat projections", () => {
  assert.deepEqual(classifyResolvedForecast(forecast({
    forecast_reputation: 1001000,
    actual_reputation: 999900,
  })), []);
  assert.deepEqual(classifyResolvedForecast(forecast({
    forecast_reputation: 1000000,
    actual_reputation: 999000,
  })), []);
  assert.deepEqual(classifyResolvedForecast(forecast({
    actual_reputation: "not-a-number",
  })), []);
});

const currentClans = () => Array.from({ length: 11 }, (_, index) => ({
  clan_id: index + 1,
  name: "Clan " + (index + 1),
  rank: index + 1,
  reputation: 1100 - index * 10,
}));

const forecastRows = (ids, changes = {}) => ids.map((id) => ({
  id: 100 + id,
  clan_id: id,
  forecast_at: "2026-11-03T00:00:00.000Z",
  target_at: "2026-11-04T00:00:00.000Z",
  forecast_reputation: changes[id] ?? (1100 - (id - 1) * 10),
  history_hours: 12,
  resolution_status: "pending",
}));

test("detects a forecasted move into the top ten from a same-time cohort", () => {
  const clans = currentClans();
  const rows = forecastRows([1, 2, 3, 4, 5, 11], { 11: 2000 });
  const alerts = buildProjectedRankAlerts(clans, rows, { now: "2026-11-03T01:00:00.000Z" });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].alertType, "projected_top_ten_entry");
  assert.equal(alerts[0].clanId, 11);
  assert.equal(alerts[0].currentRank, 11);
  assert.equal(alerts[0].projectedRank, 1);
});

test("detects a forecasted fall out of the top ten", () => {
  const clans = currentClans();
  const rows = forecastRows([1, 2, 3, 4, 5, 6], { 1: 1 });
  const alerts = buildProjectedRankAlerts(clans, rows, { now: "2026-11-03T01:00:00.000Z" });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].alertType, "projected_top_ten_exit");
  assert.equal(alerts[0].clanId, 1);
  assert.equal(alerts[0].currentRank, 1);
  assert.equal(alerts[0].projectedRank, 11);
});

test("requires adequate forecast coverage and ignores stale forecasts", () => {
  const clans = currentClans();
  const fiveRows = forecastRows([1, 2, 3, 4, 11], { 11: 2000 });
  assert.deepEqual(
    buildProjectedRankAlerts(clans, fiveRows, { now: "2026-11-03T01:00:00.000Z" }),
    [],
  );

  const staleRows = forecastRows([1, 2, 3, 4, 5, 11], { 11: 2000 })
    .map((row) => ({ ...row, forecast_at: "2026-11-02T00:00:00.000Z" }));
  assert.deepEqual(
    buildProjectedRankAlerts(clans, staleRows, { now: "2026-11-03T01:00:00.000Z" }),
    [],
  );
});

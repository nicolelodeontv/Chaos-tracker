import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { processForecastAlerts } from "./forecast-alerts-server.mjs";

const originalWebhook = process.env.FORECAST_ALERT_WEBHOOK_URL;

afterEach(() => {
  if (originalWebhook === undefined) delete process.env.FORECAST_ALERT_WEBHOOK_URL;
  else process.env.FORECAST_ALERT_WEBHOOK_URL = originalWebhook;
});

function compare(left, right) {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return leftTime === rightTime ? 0 : leftTime < rightTime ? -1 : 1;
  }
  return String(left).localeCompare(String(right));
}

class Query {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.action = "select";
    this.filters = [];
    this.values = null;
    this.maxRows = null;
  }

  select() { return this; }

  eq(column, value) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  gte(column, value) {
    this.filters.push((row) => compare(row[column], value) >= 0);
    return this;
  }

  lte(column, value) {
    this.filters.push((row) => compare(row[column], value) <= 0);
    return this;
  }

  in(column, values) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  lt(column, value) {
    this.filters.push((row) => Number(row[column]) < Number(value));
    return this;
  }

  order() { return this; }
  limit(value) { this.maxRows = value; return this; }

  insert(values) {
    this.action = "insert";
    this.values = Array.isArray(values) ? values : [values];
    return this;
  }

  update(values) {
    this.action = "update";
    this.values = values;
    return this;
  }

  async execute() {
    const rows = this.db.tables[this.table] || [];
    if (this.action === "insert") {
      const inserted = this.values.map((value) => ({
        id: "alert-" + (++this.db.nextId),
        created_at: this.db.createdAt,
        ...structuredClone(value),
      }));
      rows.push(...inserted);
      return { data: structuredClone(inserted), error: null };
    }

    const selected = rows.filter((row) => this.filters.every((filter) => filter(row)));
    if (this.action === "update") {
      for (const row of selected) Object.assign(row, structuredClone(this.values));
      return { data: null, error: null };
    }
    return {
      data: structuredClone(this.maxRows == null ? selected : selected.slice(0, this.maxRows)),
      error: null,
    };
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }
}

function makeDb(forecast, createdAt) {
  return {
    createdAt,
    nextId: 0,
    tables: {
      clan_forecasts: [structuredClone(forecast)],
      clan_forecast_alerts: [],
    },
    from(table) {
      if (!this.tables[table]) this.tables[table] = [];
      return new Query(this, table);
    },
  };
}

test("processes resolved forecasts from an earlier sync and deduplicates repeat scans", async () => {
  delete process.env.FORECAST_ALERT_WEBHOOK_URL;
  const resolvedAt = "2026-11-05T06:25:24.218Z";
  const firstAlertScan = "2026-11-05T09:17:16.000Z";
  const db = makeDb({
    id: 42,
    clan_id: 3,
    season: 4,
    base_reputation: 122796,
    forecast_reputation: 157738,
    actual_reputation: 126576,
    absolute_error: 31162,
    resolution_status: "resolved",
    resolved_at: resolvedAt,
    clans: { name: "Chaos" },
  }, firstAlertScan);

  const first = await processForecastAlerts(db, 4, firstAlertScan);
  assert.equal(first.created, 1);
  assert.equal(first.not_configured, 1);
  assert.equal(db.tables.clan_forecast_alerts.length, 1);
  assert.equal(db.tables.clan_forecast_alerts[0].source_forecast_id, 42);
  assert.equal(db.tables.clan_forecast_alerts[0].alert_type, "forecast_miss");

  const laterScan = "2026-11-06T05:00:00.000Z";
  const second = await processForecastAlerts(db, 4, laterScan);
  assert.equal(second.created, 0);
  assert.equal(db.tables.clan_forecast_alerts.length, 1);
});

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { processForecastAlerts } from "./forecast-alerts-server.mjs";

const originalWebhook = process.env.FORECAST_ALERT_WEBHOOK_URL;
const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalWebhook === undefined) delete process.env.FORECAST_ALERT_WEBHOOK_URL;
  else process.env.FORECAST_ALERT_WEBHOOK_URL = originalWebhook;
  globalThis.fetch = originalFetch;
});

function compare(left, right) {
  if (typeof left === "number" && typeof right === "number") {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  const leftTime = typeof left === "string" ? Date.parse(left) : Number.NaN;
  const rightTime = typeof right === "string" ? Date.parse(right) : Number.NaN;
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return leftTime === rightTime ? 0 : leftTime < rightTime ? -1 : 1;
  }
  const a = String(left);
  const b = String(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.action = "select";
    this.filters = [];
    this.orders = [];
    this.maxRows = null;
    this.values = null;
    this.returning = false;
  }

  select() {
    this.returning = true;
    return this;
  }

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

  eq(column, value) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  in(column, values) {
    this.filters.push((row) => values.includes(row[column]));
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

  lt(column, value) {
    this.filters.push((row) => compare(row[column], value) < 0);
    return this;
  }

  order(column, options = {}) {
    this.orders.push({ column, ascending: options.ascending !== false });
    return this;
  }

  limit(value) {
    this.maxRows = value;
    return this;
  }

  async execute() {
    const injectedError = this.db.takeError(this.table, this.action);
    if (injectedError) return { data: null, error: injectedError };

    const rows = this.db.tables[this.table] || [];
    const matches = () => rows.filter((row) => this.filters.every((filter) => filter(row)));

    if (this.action === "insert") {
      const inserted = this.values.map((value) => ({
        id: "alert-" + (++this.db.nextId),
        created_at: new Date().toISOString(),
        ...structuredClone(value),
      }));
      rows.push(...inserted);
      return { data: this.returning ? structuredClone(inserted) : null, error: null };
    }

    const selected = matches();
    if (this.action === "update") {
      for (const row of selected) Object.assign(row, structuredClone(this.values));
      return { data: this.returning ? structuredClone(selected) : null, error: null };
    }

    let result = [...selected];
    for (const order of [...this.orders].reverse()) {
      result.sort((a, b) => compare(a[order.column], b[order.column]) * (order.ascending ? 1 : -1));
    }
    if (this.maxRows != null) result = result.slice(0, this.maxRows);
    return { data: structuredClone(result), error: null };
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }
}

function makeDb({ forecasts = [], alerts = [], errors = [] } = {}) {
  const db = {
    tables: {
      clan_forecasts: structuredClone(forecasts),
      clan_forecast_alerts: structuredClone(alerts),
    },
    nextId: alerts.length,
    errors: [...errors],
    from(table) {
      if (!this.tables[table]) this.tables[table] = [];
      return new FakeQuery(this, table);
    },
    takeError(table, action) {
      const index = this.errors.findIndex((item) => item.table === table && item.action === action);
      if (index < 0) return null;
      return this.errors.splice(index, 1)[0].error;
    },
  };
  return db;
}

function resolvedForecast(effectiveNow) {
  return {
    id: "forecast-1",
    clan_id: "clan-1",
    season: 4,
    base_reputation: 100_000,
    forecast_reputation: 130_000,
    actual_reputation: 110_000,
    absolute_error: 20_000,
    resolution_status: "resolved",
    resolved_at: effectiveNow,
    clans: { name: "Chaos" },
  };
}

function futureNow(minutes = 1) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

const VALID_WEBHOOK = "https://discord.com/api/webhooks/123456789/token";

test("creates a resolved-forecast alert once and marks it not_configured without a webhook", async () => {
  delete process.env.FORECAST_ALERT_WEBHOOK_URL;
  const effectiveNow = futureNow();
  const db = makeDb({ forecasts: [resolvedForecast(effectiveNow)] });

  const first = await processForecastAlerts(db, 4, effectiveNow);
  assert.equal(first.created, 1);
  assert.equal(first.not_configured, 1);
  assert.equal(first.sent, 0);
  assert.equal(db.tables.clan_forecast_alerts.length, 1);
  assert.equal(db.tables.clan_forecast_alerts[0].alert_type, "forecast_miss");
  assert.equal(db.tables.clan_forecast_alerts[0].severity, "critical");
  assert.equal(db.tables.clan_forecast_alerts[0].delivery_status, "not_configured");
  assert.equal(db.tables.clan_forecast_alerts[0].delivery_attempts, 0);

  const second = await processForecastAlerts(db, 4, effectiveNow);
  assert.equal(second.created, 0);
  assert.equal(db.tables.clan_forecast_alerts.length, 1);
});

test("sends alerts through a validated Discord webhook and suppresses mention parsing", async () => {
  process.env.FORECAST_ALERT_WEBHOOK_URL = VALID_WEBHOOK;
  const effectiveNow = futureNow();
  const db = makeDb({ forecasts: [resolvedForecast(effectiveNow)] });
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return { ok: true, status: 204 };
  };

  const result = await processForecastAlerts(db, 4, effectiveNow);
  assert.equal(result.created, 1);
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, VALID_WEBHOOK);
  assert.equal(requests[0].options.method, "POST");
  assert.deepEqual(requests[0].body.allowed_mentions, { parse: [] });
  assert.equal(db.tables.clan_forecast_alerts[0].delivery_status, "sent");
  assert.equal(db.tables.clan_forecast_alerts[0].delivery_attempts, 1);
  assert.ok(db.tables.clan_forecast_alerts[0].sent_at);
});

test("rejects non-Discord webhook URLs without making a network request", async () => {
  process.env.FORECAST_ALERT_WEBHOOK_URL = "https://example.com/api/webhooks/123/token";
  const effectiveNow = futureNow();
  const db = makeDb({ forecasts: [resolvedForecast(effectiveNow)] });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return { ok: true, status: 204 };
  };

  const result = await processForecastAlerts(db, 4, effectiveNow);
  assert.equal(result.failed, 1);
  assert.equal(fetchCalls, 0);
  assert.equal(db.tables.clan_forecast_alerts[0].delivery_status, "failed");
  assert.match(db.tables.clan_forecast_alerts[0].last_error, /HTTPS Discord webhook endpoint/);
});

test("retries failed delivery only after 30 minutes and stops after three attempts", async () => {
  process.env.FORECAST_ALERT_WEBHOOK_URL = VALID_WEBHOOK;
  const effectiveNow = futureNow();
  const db = makeDb({ forecasts: [resolvedForecast(effectiveNow)] });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return { ok: false, status: 503 };
  };

  const first = await processForecastAlerts(db, 4, effectiveNow);
  assert.equal(first.failed, 1);
  assert.equal(fetchCalls, 1);
  assert.equal(db.tables.clan_forecast_alerts[0].delivery_attempts, 1);

  const tooSoon = await processForecastAlerts(
    db, 4, new Date(Date.parse(effectiveNow) + 15 * 60_000).toISOString(),
  );
  assert.equal(tooSoon.failed, 0);
  assert.equal(fetchCalls, 1);
  assert.equal(db.tables.clan_forecast_alerts[0].delivery_attempts, 1);

  const second = await processForecastAlerts(
    db, 4, new Date(Date.parse(effectiveNow) + 31 * 60_000).toISOString(),
  );
  assert.equal(second.failed, 1);
  assert.equal(fetchCalls, 2);
  assert.equal(db.tables.clan_forecast_alerts[0].delivery_attempts, 2);

  const third = await processForecastAlerts(
    db, 4, new Date(Date.parse(effectiveNow) + 62 * 60_000).toISOString(),
  );
  assert.equal(third.failed, 1);
  assert.equal(fetchCalls, 3);
  assert.equal(db.tables.clan_forecast_alerts[0].delivery_attempts, 3);

  const exhausted = await processForecastAlerts(
    db, 4, new Date(Date.parse(effectiveNow) + 93 * 60_000).toISOString(),
  );
  assert.equal(exhausted.failed, 0);
  assert.equal(fetchCalls, 3);
  assert.equal(db.tables.clan_forecast_alerts[0].delivery_attempts, 3);
});

test("propagates database read errors to the caller's fail-open sync wrapper", async () => {
  const effectiveNow = futureNow();
  const db = makeDb({
    forecasts: [resolvedForecast(effectiveNow)],
    errors: [{
      table: "clan_forecasts",
      action: "select",
      error: new Error("simulated forecast read failure"),
    }],
  });

  await assert.rejects(
    processForecastAlerts(db, 4, effectiveNow),
    /simulated forecast read failure/,
  );
});

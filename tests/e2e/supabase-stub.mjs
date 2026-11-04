import { createServer } from 'node:http';

const mode = process.env.MOCK_DATA_MODE === 'populated' ? 'populated' : 'empty';
const port = Number(process.env.SUPABASE_STUB_PORT || 54321);
const now = Date.now();
const hoursAgo = (hours) => new Date(now - hours * 60 * 60 * 1000).toISOString();
const daysAgo = (days) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const snapshots = [
  { id: 1, clan_id: 'alpha', season: 4, captured_at: hoursAgo(10), reputation: 900000, clans: { name: 'Alpha' } },
  { id: 2, clan_id: 'alpha', season: 4, captured_at: hoursAgo(1), reputation: 1000000, clans: { name: 'Alpha' } },
  { id: 3, clan_id: 'beta', season: 4, captured_at: hoursAgo(10), reputation: 670000, clans: { name: 'Beta' } },
  { id: 4, clan_id: 'beta', season: 4, captured_at: hoursAgo(1), reputation: 720000, clans: { name: 'Beta' } },
];

const fixtures = {
  clan_latest: [
    {
      id: 'alpha',
      name: 'Alpha',
      rank: 1,
      reputation: 1000000,
      master: 'Rin',
      members: 24,
      max_members: 50,
      season: 4,
      captured_at: hoursAgo(1),
      rep_delta: 1250,
      rank_move: 1,
    },
    {
      id: 'beta',
      name: 'Beta',
      rank: 2,
      reputation: 720000,
      master: 'Kato',
      members: 18,
      max_members: 50,
      season: 4,
      captured_at: hoursAgo(1),
      rep_delta: 500,
      rank_move: 0,
    },
    {
      id: 'zero',
      name: 'Zero Wing',
      rank: 3,
      reputation: 0,
      master: '–',
      members: 12,
      max_members: 50,
      season: 4,
      captured_at: hoursAgo(1),
      rep_delta: 0,
      rank_move: 0,
    },
  ],
  war_results: [],
  clan_snapshots: snapshots,
  clan_forecast_accuracy: [
    {
      season: 4,
      resolved_count: 11,
      pending_count: 2,
      mean_absolute_error: 38.5,
      direction_accuracy_pct: 81.8,
    },
  ],
  clan_latest_forecasts: [
    {
      clan_id: 'alpha',
      clan_name: 'Alpha',
      season: 4,
      base_reputation: 1000000,
      forecast_reputation: 1001200,
      actual_reputation: 1001000,
      resolution_status: 'resolved',
      absolute_error: 200,
      history_hours: 24,
    },
    {
      clan_id: 'beta',
      clan_name: 'Beta',
      season: 4,
      base_reputation: 720000,
      forecast_reputation: 721000,
      actual_reputation: null,
      resolution_status: 'pending',
      absolute_error: null,
      history_hours: 18,
    },
  ],
  clan_forecast_accuracy_trend: [
    {
      scored_day: daysAgo(2),
      resolved_count: 6,
      mean_absolute_error: 44.0,
      direction_accuracy_pct: 66.7,
    },
    {
      scored_day: daysAgo(1),
      resolved_count: 8,
      mean_absolute_error: 32.5,
      direction_accuracy_pct: 87.5,
    },
  ],
  clan_forecast_clan_reliability: [
    {
      clan_id: 'alpha',
      clan_name: 'Alpha',
      resolved_count: 12,
      pending_count: 2,
      mean_absolute_error: 25.5,
      direction_accuracy_pct: 91.7,
      last_resolved_at: hoursAgo(2),
    },
    {
      clan_id: 'beta',
      clan_name: 'Beta',
      resolved_count: 5,
      pending_count: 0,
      mean_absolute_error: 41.2,
      direction_accuracy_pct: 80.0,
      last_resolved_at: hoursAgo(5),
    },
    {
      clan_id: 'zero',
      clan_name: 'Zero Wing',
      resolved_count: 3,
      pending_count: 1,
      mean_absolute_error: 15.0,
      direction_accuracy_pct: 66.7,
      last_resolved_at: hoursAgo(8),
    },
  ],
  clan_forecast_alerts: [
    {
      id: 1,
      season: 4,
      clan_name: "Alpha",
      alert_type: "forecast_miss",
      severity: "warning",
      title: "24-hour forecast miss",
      detail: "Alpha finished at 1,000,000 rep against a projection of 1,010,000 (10,000 rep error).",
      predicted_reputation: 1010000,
      actual_reputation: 1000000,
      absolute_error: 10000,
      current_rank: null,
      projected_rank: null,
      delivery_status: "not_configured",
      created_at: hoursAgo(2),
    },
    {
      id: 2,
      season: 4,
      clan_name: "Beta",
      alert_type: "projected_top_ten_entry",
      severity: "warning",
      title: "Projected top-10 entry",
      detail: "Beta is projected to move from #11 to #8 over the next 24 hours.",
      predicted_reputation: 721000,
      actual_reputation: null,
      absolute_error: null,
      current_rank: 11,
      projected_rank: 8,
      delivery_status: "sent",
      created_at: hoursAgo(1),
    },
  ],

};

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');

  if (url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, mode }));
    return;
  }

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'apikey, authorization, content-type, prefer',
    });
    response.end();
    return;
  }

  if (url.pathname.startsWith('/rest/v1/')) {
    const table = url.pathname.slice('/rest/v1/'.length);
    const rows = mode === 'populated' ? (fixtures[table] ?? []) : [];
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-range': rows.length ? `0-${rows.length - 1}/${rows.length}` : '*/0',
      'access-control-allow-origin': '*',
    });
    response.end(JSON.stringify(rows));
    return;
  }

  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: 'Not found in isolated E2E stub' }));
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Isolated Supabase fixture listening on 127.0.0.1:${port} (${mode})\n`);
});

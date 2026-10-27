import test from 'node:test';
import assert from 'node:assert/strict';
import { rateBetween, lastIntervalRate, windowRate, formatRate, formatElapsed } from './repRate.js';

const snap = (reputation, iso, season = 4) => ({ reputation, season, captured_at: iso });

test('computes per-second and per-hour from elapsed time, not nominal interval', () => {
  const r = rateBetween(snap(1000, '2026-10-26T00:00:00Z'), snap(1360, '2026-10-26T00:06:00Z'));
  assert.equal(r.status, 'ok');
  assert.equal(r.delta, 360);
  assert.equal(r.perSecond, 1);
  assert.equal(r.perHour, 3600);
});

test('never computes a rate across a season boundary', () => {
  const r = rateBetween(snap(6_780_000, '2026-10-25T12:00:00Z', 3), snap(9424, '2026-10-25T22:00:00Z', 4));
  assert.equal(r.status, 'season_change');
});

test('flags decreases instead of hiding them', () => {
  const r = rateBetween(snap(5000, '2026-10-26T00:00:00Z'), snap(4000, '2026-10-26T01:00:00Z'));
  assert.equal(r.status, 'decrease');
  assert.ok(r.perSecond < 0);
});

test('guards against zero or negative elapsed time', () => {
  const t = '2026-10-26T00:00:00Z';
  assert.equal(rateBetween(snap(1, t), snap(2, t)).status, 'no_elapsed');
});

test('lastIntervalRate uses the newest sample and skips intervals under five minutes', () => {
  const r = lastIntervalRate([
    snap(600, '2026-10-26T00:10:30Z'),
    snap(100, '2026-10-26T00:00:00Z'),
    snap(500, '2026-10-26T00:10:00Z'),
    snap(200, '2026-10-26T00:04:00Z'),
  ]);
  assert.equal(r.status, 'ok');
  assert.equal(r.delta, 400);
  assert.equal(r.seconds, 390);
});

test('lastIntervalRate reports not enough data when every interval is too short', () => {
  const r = lastIntervalRate([
    snap(100, '2026-10-26T00:00:00Z'),
    snap(110, '2026-10-26T00:00:38Z'),
  ]);
  assert.equal(r.status, 'no_data');
  assert.equal(r.reason, 'interval_too_short');
});

test('lastIntervalRate never uses a prior-season snapshot as its baseline', () => {
  const r = lastIntervalRate([
    snap(6_780_000, '2026-10-25T12:00:00Z', 3),
    snap(9424, '2026-10-25T22:00:00Z', 4),
  ]);
  assert.equal(r.status, 'no_data');
});

test('windowRate ignores snapshots from an earlier season and reports actual span', () => {
  const r = windowRate(
    [
      snap(9_000_000, '2026-10-26T00:00:00Z', 3),
      snap(100, '2026-10-26T01:00:00Z', 4),
      snap(460, '2026-10-26T02:00:00Z', 4),
    ],
    24
  );
  assert.equal(r.delta, 360);
  assert.equal(r.seconds, 3600);
});

test('needs at least two snapshots', () => {
  assert.equal(lastIntervalRate([snap(1, '2026-10-26T00:00:00Z')]).status, 'no_data');
  assert.equal(windowRate([], 24).status, 'no_data');
});

test('formatRate scales digits to magnitude', () => {
  assert.equal(formatRate(0.0123), '0.012');
  assert.equal(formatRate(0.00123), '0.0012');
  assert.equal(formatRate(12.34), '12.3');
  assert.equal(formatRate(NaN), '–');
});

test('formatElapsed labels the measured span', () => {
  assert.equal(formatElapsed(1677.8), '27m 58s');
  assert.equal(formatElapsed(83820), '23h 17m');
  assert.equal(formatElapsed(0), '–');
});

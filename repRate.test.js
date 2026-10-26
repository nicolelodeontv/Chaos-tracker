import test from 'node:test';
import assert from 'node:assert/strict';
import { rateBetween, lastIntervalRate, windowRate, formatRate } from './repRate.js';

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

test('lastIntervalRate uses the two newest snapshots regardless of input order', () => {
  const r = lastIntervalRate([
    snap(300, '2026-10-26T02:00:00Z'),
    snap(100, '2026-10-26T00:00:00Z'),
    snap(200, '2026-10-26T01:00:00Z'),
  ]);
  assert.equal(r.delta, 100);
  assert.equal(r.seconds, 3600);
});

test('windowRate ignores snapshots from an earlier season', () => {
  const r = windowRate(
    [
      snap(9_000_000, '2026-10-26T00:00:00Z', 3),
      snap(100, '2026-10-26T01:00:00Z', 4),
      snap(460, '2026-10-26T02:00:00Z', 4),
    ],
    24
  );
  assert.equal(r.delta, 360);
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

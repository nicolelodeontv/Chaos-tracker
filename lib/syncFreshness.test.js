import test from 'node:test';
import assert from 'node:assert/strict';
import { isSyncStale, SYNC_STALE_AFTER_MS } from './syncFreshness.js';

const now = Date.parse('2026-10-26T06:00:00.000Z');

test('does not flag data younger than six hours as stale', () => {
  assert.equal(isSyncStale(now - SYNC_STALE_AFTER_MS + 1, now), false);
});

test('flags data older than six hours as stale', () => {
  assert.equal(isSyncStale(now - SYNC_STALE_AFTER_MS - 1, now), true);
});

test('treats a missing sync timestamp as stale', () => {
  assert.equal(isSyncStale(null, now), true);
  assert.equal(isSyncStale('', now), true);
});

test('treats an invalid timestamp as stale', () => {
  assert.equal(isSyncStale('not-a-date', now), true);
});

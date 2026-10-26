import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findWithinSeasonReputationDecreases,
  getLargeDecreaseAlerts,
  hashPayload,
  hashPayloadForDedupe,
  normalizePayloadForDedupe,
  LARGE_DECREASE_ALERT_THRESHOLD,
  shouldAlertOnConsecutiveAuditDegradation,
  shouldStoreRawPayload,
} from '../lib/sync-audit.mjs';

test('hashPayload returns a stable SHA-256 hash', () => {
  assert.equal(
    hashPayload('hello'),
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  );
});

test('flags a reputation decrease only within the same season', () => {
  const warnings = findWithinSeasonReputationDecreases(
    [
      { name: 'Chaos', reputation: 900 },
      { name: 'The Order', reputation: 450 },
      { name: 'New Clan', reputation: 5 },
    ],
    [
      { name: 'Chaos', reputation: 1000, season: 4 },
      { name: 'The Order', reputation: 400, season: 4 },
      { name: 'New Clan', reputation: 1000000, season: 3 },
    ],
    4,
  );

  assert.deepEqual(warnings, [{
    type: 'within-season-reputation-decrease',
    clan: 'Chaos',
    season: 4,
    previous_reputation: 1000,
    current_reputation: 900,
    decrease: 100,
  }]);
});

test('does not warn on equal or increased reputation or when the clan is new', () => {
  const warnings = findWithinSeasonReputationDecreases(
    [
      { name: 'Equal', reputation: 50 },
      { name: 'Higher', reputation: 60 },
      { name: 'New', reputation: 1 },
    ],
    [
      { name: 'Equal', reputation: 50, season: 4 },
      { name: 'Higher', reputation: 40, season: 4 },
    ],
    4,
  );

  assert.deepEqual(warnings, []);
});

test('keeps all decreases for audit but alerts only at or above the threshold', () => {
  const warnings = [
    { clan: 'Small', decrease: 9999 },
    { clan: 'Threshold', decrease: 10000 },
    { clan: 'The Order', decrease: 40531 },
    { clan: 'Large', decrease: 115897 },
  ];

  assert.equal(LARGE_DECREASE_ALERT_THRESHOLD, 10000);
  assert.deepEqual(getLargeDecreaseAlerts(warnings), [
    { clan: 'Threshold', decrease: 10000 },
    { clan: 'The Order', decrease: 40531 },
    { clan: 'Large', decrease: 115897 },
  ]);
});

test('alerts only on two consecutive degraded audit statuses', () => {
  assert.equal(shouldAlertOnConsecutiveAuditDegradation('partial', 'unavailable'), true);
  assert.equal(shouldAlertOnConsecutiveAuditDegradation('unavailable', 'partial'), true);
  assert.equal(shouldAlertOnConsecutiveAuditDegradation('partial', 'ok'), false);
  assert.equal(shouldAlertOnConsecutiveAuditDegradation('unavailable', 'unknown'), false);
  assert.equal(shouldAlertOnConsecutiveAuditDegradation('ok', 'unavailable'), false);
});

test('stores raw payload only when the hash changes or prior hash is unreadable', () => {
  const hash = 'same-payload-hash';
  assert.equal(shouldStoreRawPayload(hash, hash, true), false);
  assert.equal(shouldStoreRawPayload('previous-hash', 'new-hash', true), true);
  assert.equal(shouldStoreRawPayload(null, 'new-hash', true), true);
  assert.equal(shouldStoreRawPayload(null, 'new-hash', false), true);
  assert.equal(shouldStoreRawPayload('unverified-hash', 'new-hash', false), true);
});

test('dedupe fingerprint ignores rotating CSRF and form tokens but preserves the raw hash', () => {
  const first = '<html><head><meta name="csrf-token" content="csrf-A"></head>'
    + '<body><form><input type="hidden" name="_token" value="form-A" autocomplete="off"></form>'
    + '<div class="rep">100</div></body></html>';
  const second = '<html><head><meta name="csrf-token" content="csrf-B"></head>'
    + '<body><form><input type="hidden" name="_token" value="form-B" autocomplete="off"></form>'
    + '<div class="rep">100</div></body></html>';

  assert.notEqual(hashPayload(first), hashPayload(second));
  assert.equal(hashPayloadForDedupe(first), hashPayloadForDedupe(second));
  assert.equal(
    shouldStoreRawPayload(hashPayloadForDedupe(first), hashPayloadForDedupe(second)),
    false,
  );
  assert.ok(normalizePayloadForDedupe(first).includes('content="[CSRF_TOKEN]"'));
  assert.ok(normalizePayloadForDedupe(first).includes('value="[FORM_TOKEN]"'));
});

test('dedupe fingerprint still changes for meaningful page content and unrelated fields', () => {
  const first = '<meta name="csrf-token" content="csrf-A">'
    + '<input type="hidden" name="_token" value="form-A" autocomplete="off">'
    + '<div class="rep">100</div><span>Updated 10:00</span>';
  const changedReputation = first.replace('>100<', '>101<');
  const changedTimestamp = first.replace('Updated 10:00', 'Updated 10:01');

  assert.notEqual(hashPayloadForDedupe(first), hashPayloadForDedupe(changedReputation));
  assert.notEqual(hashPayloadForDedupe(first), hashPayloadForDedupe(changedTimestamp));
});

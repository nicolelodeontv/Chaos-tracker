import assert from 'node:assert/strict';
import test from 'node:test';
import { findWithinSeasonReputationDecreases, hashPayload } from '../lib/sync-audit.mjs';

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

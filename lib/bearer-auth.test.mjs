import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesBearerToken } from './bearer-auth.mjs';

test('accepts the exact bearer token', () => {
  assert.equal(matchesBearerToken('Bearer test-secret', 'test-secret'), true);
});

test('rejects a wrong token and a wrong scheme', () => {
  assert.equal(matchesBearerToken('Bearer wrong-secret', 'test-secret'), false);
  assert.equal(matchesBearerToken('Basic test-secret', 'test-secret'), false);
});

test('rejects missing credentials and missing secrets', () => {
  assert.equal(matchesBearerToken(null, 'test-secret'), false);
  assert.equal(matchesBearerToken('Bearer test-secret', ''), false);
  assert.equal(matchesBearerToken('Bearer test-secret', null), false);
});

test('rejects credentials with a different byte length safely', () => {
  assert.equal(matchesBearerToken('Bearer x', 'a much longer secret'), false);
});

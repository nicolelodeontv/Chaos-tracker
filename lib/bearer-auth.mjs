import { timingSafeEqual } from 'node:crypto';

export function matchesBearerToken(authorization, secret) {
  if (typeof secret !== 'string' || secret.length === 0 || typeof authorization !== 'string') {
    return false;
  }

  const expected = Buffer.from('Bearer ' + secret, 'utf8');
  const provided = Buffer.from(authorization, 'utf8');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

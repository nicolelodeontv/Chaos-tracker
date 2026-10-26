import { createHash } from 'node:crypto';

export const LARGE_DECREASE_ALERT_THRESHOLD = 10_000;
const DEGRADED_AUDIT_STATUSES = new Set(['partial', 'unavailable']);

export function hashPayload(payload) {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

// CSRF and form tokens rotate between requests even when the page's meaningful
// content is unchanged. Normalize only those exact token values for the storage
// decision; payload_sha256 continues to identify the exact raw HTML.
export function normalizePayloadForDedupe(payload) {
  return payload
    .replace(/<meta\\b[^>]*>/gi, (tag) => {
      if (!/\\bname\\s*=\\s*(["'])csrf-token\\1/i.test(tag)) return tag;
      return tag.replace(
        /(\\bcontent\\s*=\\s*)(["'])[^"']*\\2/i,
        '$1$2[CSRF_TOKEN]$2',
      );
    })
    .replace(/<input\\b[^>]*>/gi, (tag) => {
      if (!/\\btype\\s*=\\s*(["'])hidden\\1/i.test(tag)) return tag;
      if (!/\\bname\\s*=\\s*(["'])_token\\1/i.test(tag)) return tag;
      return tag.replace(
        /(\\bvalue\\s*=\\s*)(["'])[^"']*\\2/i,
        '$1$2[FORM_TOKEN]$2',
      );
    });
}

export function hashPayloadForDedupe(payload) {
  return hashPayload(normalizePayloadForDedupe(payload));
}

// Keep raw source HTML when the normalized page changes or the previous hash
// could not be read. An unreadable hash must never skip current evidence.
export function shouldStoreRawPayload(previousHash, currentHash, previousHashRead = true) {
  return !previousHashRead || previousHash !== currentHash;
}

export function findWithinSeasonReputationDecreases(clans = [], previousRows = [], season) {
  const previousByName = new Map(
    previousRows
      .filter((row) => Number(row.season) === Number(season))
      .map((row) => [row.name, Number(row.reputation)]),
  );

  return clans.flatMap((clan) => {
    if (!previousByName.has(clan.name)) return [];

    const previousReputation = previousByName.get(clan.name);
    const currentReputation = Number(clan.reputation);
    if (!Number.isFinite(previousReputation) || !Number.isFinite(currentReputation)) return [];
    if (currentReputation >= previousReputation) return [];

    return [{
      type: 'within-season-reputation-decrease',
      clan: clan.name,
      season: Number(season),
      previous_reputation: previousReputation,
      current_reputation: currentReputation,
      decrease: previousReputation - currentReputation,
    }];
  });
}

export function getLargeDecreaseAlerts(warnings = [], threshold = LARGE_DECREASE_ALERT_THRESHOLD) {
  return warnings.filter((warning) => Number(warning.decrease) >= threshold);
}

export function shouldAlertOnConsecutiveAuditDegradation(currentStatus, previousStatus) {
  return DEGRADED_AUDIT_STATUSES.has(currentStatus)
    && DEGRADED_AUDIT_STATUSES.has(previousStatus);
}

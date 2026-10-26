import { createHash } from 'node:crypto';

export const LARGE_DECREASE_ALERT_THRESHOLD = 10_000;
const DEGRADED_AUDIT_STATUSES = new Set(['partial', 'unavailable']);

export function hashPayload(payload) {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

// Keep raw source HTML when the payload changed or the previous hash could not
// be read. An unreadable hash must never cause the current evidence to be skipped.
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

import { createHash } from 'node:crypto';

export function hashPayload(payload) {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
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

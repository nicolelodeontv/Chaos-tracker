// Reputation gain-rate helpers. Pure functions, no I/O, so they are easy to test.
// A snapshot is { reputation: number, season: string|number, captured_at: ISO string }.

const toSeconds = (iso) => new Date(iso).getTime() / 1000;

// Rate between two snapshots of ONE clan. `from` must be the earlier one.
export function rateBetween(from, to) {
  if (!from || !to) return { status: 'no_data' };
  if (String(from.season) !== String(to.season)) return { status: 'season_change' };

  const seconds = toSeconds(to.captured_at) - toSeconds(from.captured_at);
  if (!(seconds > 0)) return { status: 'no_elapsed' };

  const delta = Number(to.reputation) - Number(from.reputation);
  if (!Number.isFinite(delta)) return { status: 'no_data' };

  const perSecond = delta / seconds;
  return {
    status: delta < 0 ? 'decrease' : 'ok', // decreases are real in this data; flag, don't hide
    delta,
    seconds,
    perSecond,
    perHour: perSecond * 3600,
  };
}

// Use the newest sample and the nearest preceding sample at least minIntervalSeconds older.
// This avoids overreacting to duplicate/manual/push-triggered syncs seconds apart.
export function lastIntervalRate(snapshots, minIntervalSeconds = 300) {
  const s = sortAsc(snapshots);
  if (s.length < 2) return { status: 'no_data' };

  const latest = s[s.length - 1];
  const latestSeconds = toSeconds(latest.captured_at);
  const minimum = Number.isFinite(minIntervalSeconds) && minIntervalSeconds >= 0 ? minIntervalSeconds : 300;
  const start = s.slice(0, -1).reverse().find((snapshot) => (
    String(snapshot.season) === String(latest.season)
    && latestSeconds - toSeconds(snapshot.captured_at) >= minimum
  ));

  if (!start) return { status: 'no_data', reason: 'interval_too_short' };
  return rateBetween(start, latest);
}

// Average rate over the last `hours` of the newest snapshot's season.
// The returned seconds field is the actual span used, which can be shorter than the window.
export function windowRate(snapshots, hours) {
  const s = sortAsc(snapshots);
  if (s.length < 2) return { status: 'no_data' };
  const latest = s[s.length - 1];
  const latestSeconds = toSeconds(latest.captured_at);
  const cutoff = latestSeconds - hours * 3600;
  const start = s.find(
    (snapshot) => (
      toSeconds(snapshot.captured_at) >= cutoff
      && String(snapshot.season) === String(latest.season)
    )
  );
  if (!start || start === latest) return { status: 'no_data' };
  return rateBetween(start, latest);
}

export function formatRate(value) {
  if (!Number.isFinite(value)) return '–';
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 1 ? 1 : abs >= 0.01 ? 3 : 4;
  return value.toFixed(digits);
}

export function formatElapsed(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '–';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
  return `${remainder}s`;
}

function sortAsc(snapshots) {
  return [...(snapshots || [])].sort((a, b) => toSeconds(a.captured_at) - toSeconds(b.captured_at));
}

// Reputation gain-rate helpers. Pure functions, no I/O, so they are easy to test.
// A snapshot is { reputation: number, season: string|number, captured_at: ISO string }.

const toSeconds = (iso) => new Date(iso).getTime() / 1000;

// Rate between two snapshots of ONE clan. `from` must be the earlier one.
export function rateBetween(from, to) {
  if (!from || !to) return { status: 'no_data' };
  if (String(from.season) !== String(to.season)) return { status: 'season_change' };

  const seconds = toSeconds(to.captured_at) - toSeconds(from.captured_at);
  if (!(seconds > 0)) return { status: 'no_elapsed' };

  const delta = to.reputation - from.reputation;
  const perSecond = delta / seconds;
  return {
    status: delta < 0 ? 'decrease' : 'ok', // decreases are real in this data; flag, don't hide
    delta,
    seconds,
    perSecond,
    perHour: perSecond * 3600,
  };
}

// Rate across the most recent sync interval.
export function lastIntervalRate(snapshots) {
  const s = sortAsc(snapshots);
  if (s.length < 2) return { status: 'no_data' };
  return rateBetween(s[s.length - 2], s[s.length - 1]);
}

// Average rate over the last `hours`, using the oldest same-season snapshot inside the window.
export function windowRate(snapshots, hours) {
  const s = sortAsc(snapshots);
  if (s.length < 2) return { status: 'no_data' };
  const latest = s[s.length - 1];
  const cutoff = toSeconds(latest.captured_at) - hours * 3600;
  const start = s.find(
    (x) => toSeconds(x.captured_at) >= cutoff && String(x.season) === String(latest.season)
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

function sortAsc(snapshots) {
  return [...(snapshots || [])].sort((a, b) => toSeconds(a.captured_at) - toSeconds(b.captured_at));
}

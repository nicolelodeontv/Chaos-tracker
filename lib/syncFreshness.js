export const SYNC_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export function isSyncStale(capturedAt, now = Date.now()) {
  if (capturedAt == null || capturedAt === '') return true;
  const timestamp = typeof capturedAt === 'number' ? capturedAt : new Date(capturedAt).getTime();
  return !Number.isFinite(timestamp) || now - timestamp > SYNC_STALE_AFTER_MS;
}

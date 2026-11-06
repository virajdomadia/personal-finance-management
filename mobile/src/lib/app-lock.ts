export const LOCK_AFTER_MS = 5 * 60 * 1000;

// backgroundedAt is null when the app has just started, which always locks.
export function shouldLock(backgroundedAt: number | null, now: number): boolean {
  return backgroundedAt === null || now - backgroundedAt >= LOCK_AFTER_MS;
}

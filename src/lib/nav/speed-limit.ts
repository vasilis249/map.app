/**
 * Speeding, the way Waze shows it: the speedometer turns red above the limit (+ a little, GPS speed is noisy), and the
 * limit is said once when you go over it — not again until you've been back under it for a while or the limit changes.
 * Pure (time passed in), unit-tested.
 */

/** Over = more than this above the limit (km/h): 5, or 5 % on fast roads. */
export const overBy = (limit: number) => Math.max(5, Math.round(limit * 0.05));
/** Back under the limit this long before going over again is said again. */
const CALM_MS = 10_000;

export interface SpeedState {
  over: boolean;
  /** Say the limit now (once per time you go over it). */
  say: number | null;
}

export function createSpeedWatch() {
  let saidFor: number | null = null;
  let underSince: number | null = null;
  return {
    update(kmh: number | null, limit: number | null, now: number): SpeedState {
      if (kmh == null || limit == null) return { over: false, say: null };
      const over = kmh > limit + overBy(limit);
      if (!over) {
        underSince ??= now;
        if (now - underSince >= CALM_MS) saidFor = null;
        return { over: false, say: null };
      }
      underSince = null;
      if (saidFor === limit) return { over: true, say: null };
      saidFor = limit;
      return { over: true, say: limit };
    },
  };
}

import { angleDiff, bearing, haversine, projectOnSegment, type LatLng } from "./geo";
import type { PreparedRoute } from "./route";

/** One position from the phone while navigating. */
export interface NavFix extends LatLng {
  /** Metres (68 % radius). */
  accuracy?: number | null;
  /** m/s. */
  speed?: number | null;
  /** Course over ground, degrees from north. */
  course?: number | null;
  /** ms (Date.now()). */
  t: number;
}

export interface NavProgress {
  /** Metres along the route (where you are, snapped). */
  along: number;
  /** Metres between the fix and the route. */
  off: number;
  snapped: LatLng;
  /** Direction of the route where you are (the heading-up camera uses it). */
  routeBearing: number;
  /** The maneuver you are on (the last one passed) and the next one. */
  step: number;
  next: number;
  /** Metres to the next maneuver, to the destination; seconds to the destination (the provider's times, scaled). */
  toNext: number;
  remaining: number;
  eta_s: number;
  /** Off the route for long enough to ask for a new one (debounced). */
  offRoute: boolean;
  arrived: boolean;
}

/** A fix worse than this tells nothing about being on or off the route. */
const USELESS_ACCURACY_M = 100;
/** Off the route = further than 30 m + the fix's error (≤ 60 m) from it, or driving the wrong way along it. */
export const offLimit = (accuracy: number | null | undefined) => 30 + Math.min(Math.max(accuracy ?? 10, 0), 60);
/** …for this many fixes in a row, spread over at least this long (one wild fix or a short wobble is not a detour). */
const OFF_FIXES = 3;
const OFF_MS = 4_000;
/** Moving faster than this, the course is trustworthy (wrong-way check, ambiguous matches). */
const COURSE_MPS = 4;
/** Arrived: within this many metres of the end, along the route or straight. */
const ARRIVE_M = 20;

/**
 * Follows you along one route: snaps each fix onto it (looking ahead of where you were, so a road that passes the same
 * place twice doesn't confuse it), measures what's left, and decides — with a debounce — that you left the route.
 */
export function createProgress(r: PreparedRoute) {
  let seg = 0;
  let along = 0;
  let offCount = 0;
  let offSince: number | null = null;
  let arrived = false;
  let last: NavProgress | null = null;

  const segBearing = (i: number) => bearing(r.pts[i], r.pts[i + 1]);

  function match(fix: NavFix, from: number, to: number) {
    const useCourse = fix.course != null && (fix.speed ?? 0) > COURSE_MPS;
    let best = { i: from, t: 0, dist: Infinity, cost: Infinity, point: r.pts[from] };
    for (let i = Math.max(0, from); i < Math.min(to, r.pts.length - 1); i++) {
      const p = projectOnSegment(fix, r.pts[i], r.pts[i + 1]);
      let cost = p.dist;
      // The same street both ways, a loop: prefer the stretch that goes your way.
      if (useCourse && r.cum[i + 1] - r.cum[i] > 3 && angleDiff(fix.course!, segBearing(i)) > 100) cost += 40;
      if (cost < best.cost) best = { i, t: p.t, dist: p.dist, cost, point: p.point };
    }
    return best;
  }

  function update(fix: NavFix): NavProgress {
    const acc = fix.accuracy ?? null;
    if (last && acc != null && acc > USELESS_ACCURACY_M) return last;
    const limit = offLimit(acc);
    // Look from a little behind where you were to a few hundred metres ahead (more when fast)…
    const ahead = along + Math.max(300, (fix.speed ?? 0) * 20 + 150);
    let from = seg;
    while (from > 0 && r.cum[from] > along - 50) from--;
    let to = seg;
    while (to < r.pts.length - 1 && r.cum[to] < ahead) to++;
    let m = match(fix, from, to + 1);
    // …and the whole route when that finds nothing close (first fix, a GPS jump, a tunnel, a shortcut).
    if (m.dist > limit) {
      const g = match(fix, 0, r.pts.length);
      if (g.dist + 10 < m.dist) m = g;
    }
    const segLen = r.cum[m.i + 1] - r.cum[m.i];
    const here = r.cum[m.i] + segLen * m.t;
    const rb = segBearing(Math.min(m.i, r.pts.length - 2));
    const wrongWay = fix.course != null && (fix.speed ?? 0) > COURSE_MPS && angleDiff(fix.course, rb) > 135;
    const isOff = m.dist > limit || wrongWay;
    if (isOff) {
      offCount++;
      offSince ??= fix.t;
    } else {
      offCount = 0;
      offSince = null;
      seg = m.i;
      along = here;
    }
    const offRoute = isOff && offCount >= OFF_FIXES && fix.t - (offSince ?? fix.t) >= OFF_MS;

    // While off the route, the numbers stay those of the last place on it.
    const n = r.at.length;
    let step = 0;
    while (step + 1 < n && r.at[step + 1] <= along) step++;
    const next = Math.min(step + 1, n - 1);
    const toNext = Math.max(0, r.at[next] - along);
    const remaining = Math.max(0, r.total - along);
    const stretch = Math.max(1, r.at[next] - r.at[step]);
    let eta = r.route.maneuvers[step].time_s * Math.min(1, toNext / stretch);
    for (let k = step + 1; k < n; k++) eta += r.route.maneuvers[k].time_s;
    if (!isOff && (remaining <= ARRIVE_M || haversine(fix, r.end) <= ARRIVE_M)) arrived = true;

    last = {
      along,
      off: m.dist,
      snapped: isOff ? (last?.snapped ?? m.point) : m.point,
      routeBearing: rb,
      step,
      next,
      toNext,
      remaining,
      eta_s: arrived ? 0 : eta,
      offRoute,
      arrived,
    };
    return last;
  }

  return { update };
}

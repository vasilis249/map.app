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
  /** Index of the route segment you are on (the map draws only what's ahead of you). */
  seg: number;
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
/** Whole-route search: metres of cost per metre of jump along the route (500 m away ≈ 25 m further off). */
const JUMP_COST = 0.05;
/** …and before joining it: you join near its start unless much closer to a later part. */
const JOIN_JUMP_COST = 0.5;
/** Before joining the route: how much further from it than at the start still counts as "on the way to it". */
const JOIN_SLACK_M = 100;
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
  // The route starts on the nearest road (a parking lot, a side street may be tens of metres away): until you first
  // reach it, you're "off" only when you move clearly further away from it than where you started.
  let joined = false;
  let startOff: number | null = null;

  const segBearing = (i: number) => bearing(r.pts[i], r.pts[i + 1]);

  /**
   * The best place on the route between points `from` and `to`. `jumpCost` (metres of cost per metre along the route
   * away from where you were): when searching the whole route, a road the route passes twice (a loop around a square)
   * must not pull you far ahead or back on a near-tie; a real jump (after a tunnel) still wins by being much closer.
   */
  function match(fix: NavFix, from: number, to: number, jumpCost = 0) {
    const useCourse = fix.course != null && (fix.speed ?? 0) > COURSE_MPS;
    let best = { i: from, t: 0, dist: Infinity, cost: Infinity, point: r.pts[from] };
    for (let i = Math.max(0, from); i < Math.min(to, r.pts.length - 1); i++) {
      const p = projectOnSegment(fix, r.pts[i], r.pts[i + 1]);
      let cost = p.dist;
      // The same street both ways, a loop: prefer the stretch that goes your way.
      if (useCourse && r.cum[i + 1] - r.cum[i] > 3 && angleDiff(fix.course!, segBearing(i)) > 100) cost += 40;
      if (jumpCost) cost += jumpCost * Math.abs(r.cum[i] + (r.cum[i + 1] - r.cum[i]) * p.t - along);
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
    // Not on the route yet: you join it at its start (where the provider put your origin), not where it comes back
    // close to you later.
    let m = match(fix, from, to + 1, joined ? 0 : JOIN_JUMP_COST);
    // …and the whole route when that finds nothing close (first fix, a GPS jump, a tunnel, a shortcut).
    if (m.dist > limit) {
      const g = match(fix, 0, r.pts.length, joined ? JUMP_COST : JOIN_JUMP_COST);
      if (g.dist + 10 < m.dist) m = g;
    }
    const segLen = r.cum[m.i + 1] - r.cum[m.i];
    const here = r.cum[m.i] + segLen * m.t;
    const rb = segBearing(Math.min(m.i, r.pts.length - 2));
    const wrongWay = fix.course != null && (fix.speed ?? 0) > COURSE_MPS && angleDiff(fix.course, rb) > 135;
    // Not joined yet: off = clearly further from every part of the route than at the start.
    const nearest = joined ? m.dist : match(fix, 0, r.pts.length).dist;
    startOff ??= nearest;
    const isOff = joined ? m.dist > limit || wrongWay : nearest > Math.max(limit, startOff + JOIN_SLACK_M);
    if (!isOff && m.dist <= limit) joined = true;
    if (isOff) {
      offCount++;
      offSince ??= fix.t;
    } else {
      offCount = 0;
      offSince = null;
      if (joined) {
        seg = m.i;
        along = here;
      }
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
      seg,
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

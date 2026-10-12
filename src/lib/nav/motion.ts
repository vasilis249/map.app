import { angleDiff, bearing, haversine, type LatLng } from "./geo";
import type { PreparedRoute } from "./route";

/**
 * Smooth navigation motion, like Google Maps: GPS gives a fix about once a second, the screen draws 60 frames. Between
 * fixes the arrow keeps gliding along the road at your speed (dead reckoning, at most 1.5 s ahead of the last fix);
 * the camera turns early and gently into bends (it looks a little ahead along the route); zoom and tilt follow your
 * speed — wider on fast roads, closer before a turn, and a close, tilted 3D view when you stop (a red light).
 * Pure: the map calls frame(now) on every animation frame and moves the camera / arrow there.
 */

export interface MotionInput {
  route: PreparedRoute;
  /** Metres along the route (snapped), and whether you are on it. */
  along: number;
  onRoute: boolean;
  /** The fix itself (used off the route). */
  lat: number;
  lng: number;
  course: number | null;
  /** m/s (0 when unknown). */
  speed: number;
  /** Metres to the next maneuver. */
  toNext: number;
  /** ms (Date.now()). */
  t: number;
}

export interface MotionFrame extends LatLng {
  /** Direction the camera faces and the arrow points (degrees from north). */
  bearing: number;
  zoom: number;
  pitch: number;
  /** Smoothed speed, m/s. */
  speed: number;
  /** Stopped long enough for the close-up view. */
  still: boolean;
}

/** Exponential smoothing factor for a time step (time constant tau, seconds). */
const follow = (dt: number, tau: number) => 1 - Math.exp(-dt / tau);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Shortest signed turn from a to b, degrees (-180…180). */
const turn = (a: number, b: number) => ((b - a + 540) % 360) - 180;

/** Dead reckoning: never more than this far past the last fix. */
const PREDICT_S = 1.5;
/** No fix for this long = standing still (an iPhone sends nothing while you stand, LESSONS #12). */
export const SILENT_STILL_MS = 2_500;
/** Stopped (below 0.8 m/s) for this long → the close-up 3D view. */
const STILL_MS = 2_000;
export const STILL_ZOOM = 19.3;
export const STILL_PITCH = 66;
const MOVING_PITCH = 52;
/** A jump bigger than this (a new route far away, a GPS jump after a tunnel) is not animated. */
const SNAP_M = 300;

/** Zoom for a speed (km/h → zoom, linear between the points), closer before a turn. */
export function targetZoom(mps: number, toNext: number): number {
  const kmh = mps * 3.6;
  const pts: [number, number][] = [[0, 18], [30, 17.5], [50, 17], [80, 16.4], [110, 15.9], [130, 15.6]];
  let z = pts.at(-1)![1];
  for (let i = 1; i < pts.length; i++)
    if (kmh <= pts[i][0]) {
      const [k0, z0] = pts[i - 1];
      const [k1, z1] = pts[i];
      z = z0 + ((kmh - k0) / (k1 - k0)) * (z1 - z0);
      break;
    }
  if (toNext < Math.max(120, mps * 7)) z = Math.max(z, 17.6);
  return z;
}

/** The point `d` metres along the route and the route's direction there (binary search: long routes stay cheap). */
export function routePoint(r: PreparedRoute, d: number): LatLng {
  const dd = clamp(d, 0, r.total);
  let lo = 0, hi = r.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (r.cum[mid] <= dd) lo = mid;
    else hi = mid;
  }
  const seg = r.cum[hi] - r.cum[lo];
  const k = seg > 0 ? (dd - r.cum[lo]) / seg : 0;
  const a = r.pts[lo], b = r.pts[hi];
  return { lat: a.lat + (b.lat - a.lat) * k, lng: a.lng + (b.lng - a.lng) * k };
}

export function createMotion() {
  let input: MotionInput | null = null;
  let along = 0;
  let pos: LatLng | null = null;
  let brg = 0;
  let zoom = 17;
  let pitch = MOVING_PITCH;
  let speed = 0;
  let stillSince: number | null = null;
  let last: number | null = null;
  let route: PreparedRoute | null = null;

  return {
    update(next: MotionInput) {
      if (next.route !== route) {
        // A new route (reroute): continue from where the arrow is on it.
        route = next.route;
        along = next.along;
      }
      if (next.speed >= 0.8) stillSince = null;
      input = next;
    },

    frame(now: number): MotionFrame | null {
      const i = input;
      if (!i) return null;
      const dt = last == null ? 1 : clamp((now - last) / 1000, 0, 0.5);
      last = now;
      // The last fix's speed, or 0 once fixes stopped coming (standing at a light).
      const v = now - i.t > SILENT_STILL_MS ? 0 : i.speed;
      if (v < 0.8) stillSince ??= v === i.speed ? i.t : i.t + SILENT_STILL_MS;
      else stillSince = null;
      speed += (v - speed) * follow(dt, 0.6);
      const ahead = clamp((now - i.t) / 1000, 0, PREDICT_S) * i.speed;
      let ideal: LatLng;
      let face: number | null;
      if (i.onRoute) {
        const want = Math.min(i.along + ahead, i.route.total);
        // Glide towards where you should be now; a small step back (GPS noise) is ignored instead of drawn.
        if (Math.abs(want - along) > SNAP_M) along = want;
        else if (want > along || along - want > 8) along += (want - along) * follow(dt, 0.35);
        ideal = routePoint(i.route, along);
        // Look ahead along the road: the camera starts turning before the corner, like a driver's eyes.
        const look = clamp(i.speed * 3, 20, 80);
        const there = routePoint(i.route, along + look);
        face = haversine(ideal, there) > 2 ? bearing(ideal, there) : null;
      } else {
        const c = i.course;
        const m = c == null ? 0 : ahead;
        const r = (m / 6_371_008.8) * (180 / Math.PI);
        ideal = c == null ? { lat: i.lat, lng: i.lng } : { lat: i.lat + r * Math.cos((c * Math.PI) / 180), lng: i.lng + (r * Math.sin((c * Math.PI) / 180)) / Math.cos((i.lat * Math.PI) / 180) };
        face = c;
      }
      const first = !pos;
      if (first && face != null) brg = face;
      if (!pos || haversine(pos, ideal) > SNAP_M) pos = ideal;
      else {
        const k = follow(dt, 0.12);
        pos = { lat: pos.lat + (ideal.lat - pos.lat) * k, lng: pos.lng + (ideal.lng - pos.lng) * k };
      }
      // Turning only while moving (a standing phone's direction is noise).
      if (face != null && v >= 0.8) brg = (brg + turn(brg, face) * follow(dt, angleDiff(brg, face) > 60 ? 0.35 : 0.6) + 360) % 360;
      const still = stillSince != null && now - stillSince >= STILL_MS;
      zoom += ((still ? STILL_ZOOM : targetZoom(v, i.toNext)) - zoom) * follow(dt, 1.2);
      pitch += ((still ? STILL_PITCH : MOVING_PITCH) - pitch) * follow(dt, 1.0);
      return { lat: pos.lat, lng: pos.lng, bearing: brg, zoom, pitch, speed, still };
    },

    /** The route still ahead of the arrow, as [lng, lat] (the map trims the line behind you with it). */
    ahead(): [number, number][] | null {
      if (!route || !pos || !input?.onRoute) return null;
      let lo = 0, hi = route.cum.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (route.cum[mid] <= along) lo = mid;
        else hi = mid;
      }
      const here = routePoint(route, along);
      return [[here.lng, here.lat], ...route.pts.slice(hi).map((p): [number, number] => [p.lng, p.lat])];
    },
  };
}

export type Motion = ReturnType<typeof createMotion>;

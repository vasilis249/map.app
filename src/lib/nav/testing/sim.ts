import { bearing, offset, type LatLng } from "../geo";
import type { NavFix } from "../progress";
import type { PreparedRoute } from "../route";

/**
 * Simulated GPS tracks for the unit tests: drive along a real route at a given speed, one fix per second, with
 * deterministic noise (a seeded PRNG, so a failure always reproduces), or leave the route in a given direction.
 */

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** The point `d` metres along the route, and the route's direction there. */
export function pointAt(r: PreparedRoute, d: number): { p: LatLng; brg: number } {
  const dd = Math.max(0, Math.min(d, r.total));
  let i = 0;
  while (i < r.cum.length - 2 && r.cum[i + 1] < dd) i++;
  const seg = r.cum[i + 1] - r.cum[i];
  const t = seg > 0 ? (dd - r.cum[i]) / seg : 0;
  const a = r.pts[i], b = r.pts[i + 1];
  return { p: { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t }, brg: bearing(a, b) };
}

export interface DriveOptions {
  /** m/s. */
  speed: number;
  /** Start / stop at these metres along the route. */
  from?: number;
  to?: number;
  /** Position noise (metres, uniform in a disc of this radius). */
  noise?: number;
  accuracy?: number;
  seed?: number;
  t0?: number;
}

/** One fix per second from `from` to `to` along the route. */
export function drive(r: PreparedRoute, o: DriveOptions): NavFix[] {
  const rand = rng(o.seed ?? 1);
  const out: NavFix[] = [];
  const to = o.to ?? r.total;
  let t = o.t0 ?? 0;
  for (let d = o.from ?? 0; ; d += o.speed) {
    const at = Math.min(d, to);
    const { p, brg } = pointAt(r, at);
    const n = o.noise ? offset(p, o.noise * Math.sqrt(rand()), rand() * 360) : p;
    out.push({ ...n, accuracy: o.accuracy ?? 8, speed: o.speed, course: brg, t });
    t += 1000;
    if (at >= to) break;
  }
  return out;
}

/** Leave the route: `seconds` fixes from `start` heading `brg` at `speed`. */
export function straight(start: LatLng, brg: number, speed: number, seconds: number, t0: number): NavFix[] {
  const out: NavFix[] = [];
  for (let s = 1; s <= seconds; s++) out.push({ ...offset(start, speed * s, brg), accuracy: 8, speed, course: brg, t: t0 + s * 1000 });
  return out;
}

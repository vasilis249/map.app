import { angleDiff, bearing, haversine, projectOnSegment, type LatLng } from "@/lib/nav/geo";
import type { PreparedRoute } from "@/lib/nav/route";

/**
 * Waze-style road reports, the logic the screens use (pure, unit-tested): which reports matter to you — near you, or
 * on your route ahead (≤ 50 m from the line, in your direction) — when to warn about one while navigating (once, early
 * enough for your speed) and when to ask "still there?" (once, as you pass it).
 */

export type RoadKind = "traffic" | "police" | "accident" | "hazard" | "closed" | "camera" | "help";
/** In the order of the report sheet's tiles (Waze's). */
export const ROAD_KINDS: RoadKind[] = ["traffic", "police", "accident", "hazard", "closed", "camera", "help"];

/**
 * The details you can add (one more tap), per kind — the server checks the same list (private.road_sub_ok). Hazards
 * come in two groups: on the road, and weather. "other_side": seen on the opposite carriageway.
 */
export const ROAD_SUBS: Record<RoadKind, readonly (readonly string[])[]> = {
  traffic: [["moderate", "heavy", "standstill"]],
  police: [["visible", "hidden", "other_side"]],
  accident: [["minor", "major", "other_side"]],
  hazard: [
    ["object", "pothole", "roadwork", "light_out", "stopped_car", "animal", "shoulder"],
    ["fog", "flood", "ice", "hail"],
  ],
  closed: [],
  camera: [["speed", "red_light"]],
  help: [["tire", "battery", "fuel", "other"]],
};

export interface RoadReport extends LatLng {
  id: string;
  kind: RoadKind;
  /** The detail (ROAD_SUBS), or null for a general report. */
  sub: string | null;
  /** Direction of travel of the reporter (degrees), or null. */
  heading: number | null;
  created_at: string;
  expires_at: string;
  up: number;
  down: number;
  /** You made it (you aren't asked to confirm your own). */
  mine: boolean;
  /** Your vote: 1 still there, -1 not there, 0 none. */
  voted: number;
}

/** How far from the route line a report still counts as "on it". */
export const ON_ROUTE_M = 50;
/** A report made by someone driving the other way (opposite carriageway) doesn't count for you. */
const OPPOSITE_DEG = 120;

/** Where along the route the report is (metres), if it's on the route ahead of `along` and for your direction. */
export function alongRoute(r: PreparedRoute, along: number, rep: RoadReport): number | null {
  let best: { at: number; dist: number; i: number } | null = null;
  for (let i = 0; i < r.pts.length - 1; i++) {
    // Only what's ahead of you (and a little behind: you may be right on it).
    if (r.cum[i + 1] < along - 30) continue;
    const p = projectOnSegment(rep, r.pts[i], r.pts[i + 1]);
    if (p.dist > ON_ROUTE_M) continue;
    const at = r.cum[i] + (r.cum[i + 1] - r.cum[i]) * p.t;
    if (!best || p.dist < best.dist) best = { at, dist: p.dist, i };
  }
  if (!best || best.at < along - 30) return null;
  // Reported for the other carriageway: it applies to those driving opposite to the reporter.
  const heading = rep.heading == null ? null : rep.sub === "other_side" ? (rep.heading + 180) % 360 : rep.heading;
  if (heading != null && angleDiff(heading, bearing(r.pts[best.i], r.pts[best.i + 1])) > OPPOSITE_DEG) return null;
  return best.at;
}

export interface Ahead {
  report: RoadReport;
  /** Metres to it along the route (navigating) or straight (not navigating). */
  distance: number;
  onRoute: boolean;
}

/** Reports that matter now: on your route ahead (navigating), else within `nearM` of you; nearest first. */
export function relevant(list: RoadReport[], me: LatLng | null, route: PreparedRoute | null, along: number, nearM = 2_000): Ahead[] {
  const out: Ahead[] = [];
  for (const rep of list) {
    if (route) {
      const at = alongRoute(route, along, rep);
      if (at != null) {
        out.push({ report: rep, distance: Math.max(0, at - along), onRoute: true });
        continue;
      }
    }
    if (me) {
      const d = haversine(me, rep);
      if (d <= nearM && !route) out.push({ report: rep, distance: d, onRoute: false });
    }
  }
  return out.sort((a, b) => a.distance - b.distance);
}

/** Warn this far ahead: about 30 s at your speed, 300 m … 1 km. */
export const alertDistance = (mps: number | null | undefined) => Math.min(1_000, Math.max(300, (mps ?? 13.9) * 30));
/** "Still there?" when you pass within this distance of it. */
export const PASS_M = 40;

export interface ReportEvent {
  type: "alert" | "ask";
  report: RoadReport;
  distance: number;
}

/**
 * While navigating: one warning per report on your route ahead, and one "still there?" when you pass it (not for your
 * own reports, nor ones you already voted on). One event per update (the nearest first).
 */
export function createReportAlerts() {
  const warned = new Set<string>();
  const asked = new Set<string>();
  return {
    next(ahead: Ahead[], mps: number | null | undefined, me: LatLng | null): ReportEvent | null {
      for (const a of ahead) {
        const rep = a.report;
        const near = me ? haversine(me, rep) : a.distance;
        if (!asked.has(rep.id) && near <= PASS_M) {
          asked.add(rep.id);
          warned.add(rep.id);
          if (!rep.mine && rep.voted === 0) return { type: "ask", report: rep, distance: near };
          continue;
        }
        if (a.onRoute && !warned.has(rep.id) && a.distance <= alertDistance(mps) && a.distance > PASS_M) {
          warned.add(rep.id);
          return { type: "alert", report: rep, distance: a.distance };
        }
      }
      return null;
    },
  };
}

/** Traffic reports: how bad (1 moderate, 2 heavy / unspecified, 3 standstill) and what each adds to the trip. */
export function trafficLevel(r: RoadReport): 0 | 1 | 2 | 3 {
  if (r.kind !== "traffic") return 0;
  return r.sub === "moderate" ? 1 : r.sub === "standstill" ? 3 : 2;
}
export const TRAFFIC_DELAY_S = [0, 60, 180, 300] as const;
/** A jam is reported where someone sits in it: colour the road from a little before it to just after it. */
const JAM_BEFORE_M = 250;
const JAM_AFTER_M = 50;

export interface Jam {
  from: number;
  to: number;
  level: 1 | 2 | 3;
}

/**
 * The stretches of your route ahead with traffic reported on them (merged where they overlap, the worse level wins),
 * and the extra time they add to the arrival (each jam once, by its worst level).
 */
export function trafficAhead(ahead: Ahead[], along: number): { jams: Jam[]; delay_s: number } {
  const raw = ahead
    .filter((a) => a.onRoute && trafficLevel(a.report) > 0)
    .map((a) => {
      const at = along + a.distance;
      return { from: Math.max(along, at - JAM_BEFORE_M), to: at + JAM_AFTER_M, level: trafficLevel(a.report) as 1 | 2 | 3 };
    })
    .sort((a, b) => a.from - b.from);
  const jams: Jam[] = [];
  for (const j of raw) {
    const last = jams.at(-1);
    if (last && j.from <= last.to) {
      last.to = Math.max(last.to, j.to);
      last.level = Math.max(last.level, j.level) as 1 | 2 | 3;
    } else jams.push({ ...j });
  }
  return { jams, delay_s: jams.reduce((s, j) => s + TRAFFIC_DELAY_S[j.level], 0) };
}

/** The route's line between two distances along it ([lng, lat], for drawing a jam). */
export function routeSlice(r: PreparedRoute, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  const at = (d: number): [number, number] => {
    let i = 1;
    while (i < r.cum.length - 1 && r.cum[i] < d) i++;
    const a = r.pts[i - 1], b = r.pts[i];
    const seg = r.cum[i] - r.cum[i - 1] || 1;
    const k = Math.min(1, Math.max(0, (d - r.cum[i - 1]) / seg));
    return [a.lng + (b.lng - a.lng) * k, a.lat + (b.lat - a.lat) * k];
  };
  if (to <= from || from >= r.total) return out;
  out.push(at(from));
  for (let i = 0; i < r.pts.length; i++) if (r.cum[i] > from && r.cum[i] < to) out.push([r.pts[i].lng, r.pts[i].lat]);
  out.push(at(Math.min(to, r.total)));
  return out;
}

/** Closed roads to route around: the active "closed" reports, nearest to `me` first (at most 10). */
export function closures(list: RoadReport[], me: LatLng | null): LatLng[] {
  return list
    .filter((r) => r.kind === "closed")
    .sort((a, b) => (me ? haversine(me, a) - haversine(me, b) : 0))
    .slice(0, 10)
    .map((r) => ({ lat: r.lat, lng: r.lng }));
}

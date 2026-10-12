import { describe, expect, it } from "vitest";
import athens from "./fixtures/valhalla-athens.json";
import reroute from "./fixtures/valhalla-athens-reroute.json";
import { angleDiff, haversine } from "./geo";
import { createMotion, routePoint, STILL_PITCH, STILL_ZOOM, targetZoom, type MotionFrame } from "./motion";
import { createProgress } from "./progress";
import { parseValhalla, prepareRoute, type PreparedRoute } from "./route";
import { drive } from "./testing/sim";

const r = prepareRoute(parseValhalla(athens)[0]);
const FRAME = 1000 / 60;

/** Feed fixes (through the real progress tracker) and draw 60 frames a second in between; returns every frame. */
function animate(route: PreparedRoute, fixes: ReturnType<typeof drive>, motion = createMotion()) {
  const p = createProgress(route);
  const frames: (MotionFrame & { t: number })[] = [];
  for (let i = 0; i < fixes.length; i++) {
    const f = fixes[i];
    const pr = p.update(f);
    motion.update({ route, along: pr.along, onRoute: !pr.offRoute, lat: f.lat, lng: f.lng, course: f.course ?? null, speed: f.speed ?? 0, toNext: pr.toNext, t: f.t });
    const until = i + 1 < fixes.length ? fixes[i + 1].t : f.t + 3000;
    for (let t = f.t; t < until; t += FRAME) frames.push({ ...motion.frame(t)!, t });
  }
  return frames;
}

describe("smooth motion between GPS fixes", () => {
  it("50 km/h with ±5 m GPS noise: no jumps, never backwards, gentle turns, on the road", () => {
    const frames = animate(r, drive(r, { speed: 13.9, noise: 5, seed: 3 }));
    let maxStep = 0, maxBack = 0, maxTurn = 0;
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1], b = frames[i];
      maxStep = Math.max(maxStep, haversine(a, b));
      maxTurn = Math.max(maxTurn, angleDiff(a.bearing, b.bearing));
    }
    // Along the route, frame by frame: how far each frame is from the start (never decreasing by more than noise).
    const alongOf = (f: MotionFrame) => {
      let best = 0, bd = Infinity;
      for (let d = 0; d <= r.total; d += 2) {
        const x = haversine(routePoint(r, d), f);
        if (x < bd) {
          bd = x;
          best = d;
        }
      }
      return { best, bd };
    };
    let prev = 0;
    for (let i = 0; i < frames.length; i += 30) {
      const { best, bd } = alongOf(frames[i]);
      expect(bd).toBeLessThan(3); // drawn on the road, not where the noisy fix was
      maxBack = Math.max(maxBack, prev - best);
      prev = Math.max(prev, best);
    }
    // 13.9 m/s = 0.23 m per frame; catching up after a fix may add a little, never a jump.
    expect(maxStep).toBeLessThan(0.9);
    expect(maxBack).toBeLessThan(3);
    // The sharpest corner on this route is ~90°: spread over many frames (< 4° per frame = 240°/s at most).
    expect(maxTurn).toBeLessThan(4);
  });

  it("a GPS gap (tunnel): keeps gliding for 1.5 s, then waits — no running away", () => {
    const fixes = drive(r, { speed: 10, to: 500, seed: 1 });
    const frames = animate(r, fixes);
    const lastFix = fixes.at(-1)!;
    const end = frames.at(-1)!; // 3 s after the last fix
    expect(haversine(end, lastFix)).toBeLessThan(10 * 1.5 + 2);
  });

  it("stopped at a red light: zooms in and tilts for the close 3D view; moving again: back", () => {
    const go = drive(r, { speed: 10, to: 300, seed: 2 });
    const stop = go.at(-1)!;
    const wait = Array.from({ length: 8 }, (_, i) => ({ ...stop, speed: 0, course: null, t: stop.t + (i + 1) * 1000 }));
    const frames = animate(r, [...go, ...wait]);
    const before = frames.find((f) => f.t >= stop.t)!;
    const after = frames.at(-1)!;
    expect(before.still).toBe(false);
    expect(after.still).toBe(true);
    expect(after.zoom).toBeGreaterThan(STILL_ZOOM - 0.2);
    expect(after.pitch).toBeGreaterThan(STILL_PITCH - 1);
    // The camera doesn't spin while you stand still (from the first fix that says so).
    const atStop = frames.filter((f) => f.t > stop.t + 1000);
    expect(Math.max(...atStop.map((f) => angleDiff(f.bearing, atStop[0].bearing)))).toBeLessThan(1);
  });

  it("no fixes at all while stopped (iPhones send none when you stand): still the close 3D view", () => {
    const go = drive(r, { speed: 10, to: 300, seed: 6 });
    const motion = createMotion();
    animate(r, go, motion); // (animate draws 3 s past the last fix)
    let f = motion.frame(go.at(-1)!.t + 3_000)!;
    for (let t = go.at(-1)!.t + 3_000; t < go.at(-1)!.t + 9_000; t += FRAME) f = motion.frame(t)!;
    expect(f.still).toBe(true);
    expect(f.speed).toBeLessThan(0.5);
    expect(f.zoom).toBeGreaterThan(STILL_ZOOM - 0.2);
  });

  it("zoom follows speed and comes closer before a turn", () => {
    expect(targetZoom(0, 1000)).toBe(18);
    expect(targetZoom(50 / 3.6, 1000)).toBeCloseTo(17);
    expect(targetZoom(130 / 3.6, 5000)).toBeCloseTo(15.6);
    expect(targetZoom(130 / 3.6, 200)).toBe(17.6);
    expect(targetZoom(80 / 3.6, 2000)).toBeLessThan(targetZoom(30 / 3.6, 2000));
  });

  it("a new route (reroute): the arrow doesn't jump — it slides over in a few frames", () => {
    const motion = createMotion();
    animate(r, drive(r, { speed: 10, to: 100, seed: 4 }), motion);
    const r2 = prepareRoute(parseValhalla(reroute)[0]);
    const before = motion.frame(1e9)!;
    motion.update({ route: r2, along: 0, onRoute: true, lat: r2.pts[0].lat, lng: r2.pts[0].lng, course: null, speed: 10, toNext: 100, t: 1e9 });
    const gap = haversine(before, routePoint(r2, 0));
    let prev = before;
    let maxStep = 0;
    for (let k = 1; k <= 120; k++) {
      const f = motion.frame(1e9 + k * FRAME)!;
      maxStep = Math.max(maxStep, haversine(prev, f));
      prev = f;
    }
    if (gap < 300) expect(maxStep).toBeLessThan(Math.max(3, gap * 0.15));
  });
});

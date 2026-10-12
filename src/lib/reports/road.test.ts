import { describe, expect, it } from "vitest";
import athens from "@/lib/nav/fixtures/valhalla-athens.json";
import { bearing, offset } from "@/lib/nav/geo";
import { routePoint } from "@/lib/nav/motion";
import { createProgress } from "@/lib/nav/progress";
import { parseValhalla, prepareRoute } from "@/lib/nav/route";
import { drive } from "@/lib/nav/testing/sim";
import { alertDistance, alongRoute, createReportAlerts, relevant, type RoadReport } from "./road";

const r = prepareRoute(parseValhalla(athens)[0]);
/** A report `side` metres beside the route at `at` metres along it, reported by someone going `dir` (+1 our way). */
function rep(id: string, at: number, side = 8, dir: 1 | -1 | 0 = 1, extra: Partial<RoadReport> = {}): RoadReport {
  const p = routePoint(r, at);
  const ahead = routePoint(r, at + 5);
  const brg = bearing(p, ahead);
  const q = offset(p, side, brg + 90);
  return { id, kind: "police", ...q, heading: dir === 0 ? null : dir === 1 ? brg : (brg + 180) % 360, created_at: "", expires_at: "", up: 0, down: 0, mine: false, voted: 0, ...extra };
}

describe("which road reports matter", () => {
  it("on the route ahead (≤ 50 m from the line), your direction: yes, at its place along the route", () => {
    expect(alongRoute(r, 0, rep("a", 1300))).toBeGreaterThan(1290);
    expect(alongRoute(r, 0, rep("a", 1300))).toBeLessThan(1310);
    expect(alongRoute(r, 0, rep("a", 1300, 0, 0))).not.toBeNull(); // no direction known: counts
  });
  it("too far from the line, behind you, or for the other direction: no", () => {
    expect(alongRoute(r, 0, rep("far", 1300, 120))).toBeNull();
    expect(alongRoute(r, 1500, rep("behind", 1300))).toBeNull();
    expect(alongRoute(r, 0, rep("opposite", 1300, 8, -1))).toBeNull();
  });
  it("navigating: only those on the route, nearest first; not navigating: those within 2 km of you", () => {
    const list = [rep("x", 2000), rep("y", 900), rep("off", 1300, 300)];
    const nav = relevant(list, routePoint(r, 0), r, 0);
    expect(nav.map((a) => a.report.id)).toEqual(["y", "x"]);
    expect(nav[0].distance).toBeCloseTo(900, -1);
    const walk = relevant(list, routePoint(r, 0), null, 0);
    expect(walk.map((a) => a.report.id).sort()).toEqual(["off", "x", "y"].sort());
  });
});

describe("warnings while navigating", () => {
  it("one warning per report, early enough for the speed; 'still there?' once as you pass it", () => {
    const reports = [rep("police", 1350), rep("mine", 2000, 8, 1, { mine: true }), rep("voted", 2400, 8, 1, { voted: 1 })];
    const alerts = createReportAlerts();
    const p = createProgress(r);
    const events: { type: string; id: string; distance: number; along: number }[] = [];
    for (const f of drive(r, { speed: 13.9, noise: 4, seed: 9 })) {
      const pr = p.update(f);
      const e = alerts.next(relevant(reports, f, r, pr.along), f.speed, f);
      if (e) events.push({ type: e.type, id: e.report.id, distance: e.distance, along: pr.along });
    }
    const of = (type: string, id: string) => events.filter((e) => e.type === type && e.id === id);
    expect(of("alert", "police")).toHaveLength(1);
    expect(of("alert", "police")[0].distance).toBeLessThanOrEqual(alertDistance(13.9));
    expect(of("alert", "police")[0].distance).toBeGreaterThan(alertDistance(13.9) - 14 * 1.5 - 10);
    expect(of("ask", "police")).toHaveLength(1);
    expect(of("ask", "police")[0].along).toBeGreaterThan(1300);
    // Your own report / one you voted on: warned about, never asked.
    expect(of("alert", "mine")).toHaveLength(1);
    expect(of("ask", "mine")).toHaveLength(0);
    expect(of("ask", "voted")).toHaveLength(0);
  });
  it("warning distance follows speed", () => {
    expect(alertDistance(5)).toBe(300);
    expect(alertDistance(20)).toBe(600);
    expect(alertDistance(40)).toBe(1000);
  });
});

import { describe, expect, it } from "vitest";
// Recorded answers (FOSSGIS Valhalla, OpenStreetMap data, 2026-10-14): the Syntagma → Koukaki route, and
// trace_attributes over its own shape (edge_walk) with edge.speed_limit / edge.length.
import athens from "./fixtures/valhalla-athens.json";
import limitsAnswer from "./fixtures/valhalla-athens.limits.json";
import { limitAt, parseLimits, parseValhalla } from "./route";
import { createSpeedWatch, overBy } from "./speed-limit";

describe("speed limits along the route", () => {
  const limits = parseLimits(limitsAnswer);
  const route = { ...parseValhalla(athens)[0], limits };

  it("parses the tagged stretches in order, merged, in metres; untagged stretches stay unknown", () => {
    expect(limits.length).toBeGreaterThan(0);
    expect(new Set(limits.map((l) => l[2]))).toEqual(new Set([30, 60]));
    for (let i = 0; i < limits.length; i++) {
      expect(limits[i][1]).toBeGreaterThan(limits[i][0]);
      if (i) expect(limits[i][0]).toBeGreaterThanOrEqual(limits[i - 1][1]);
    }
    // the edges add up to the route's length (2.748 km)
    expect(limits.at(-1)![1]).toBeLessThanOrEqual(2_760);
    // Όθωνος (the first ~80 m) has no limit in OSM; Βασιλίσσης Αμαλίας after it has 30
    expect(limitAt(route, 20)).toBeNull();
    expect(limitAt(route, limits[0][0] + 1)).toBe(limits[0][2]);
    expect(limitAt(route, 99_999)).toBeNull();
  });

  it("refuses answers that aren't trace_attributes; drops nonsense limits", () => {
    expect(() => parseLimits({ trip: {} })).toThrow();
    expect(parseLimits({ edges: [{ length: 0.1, speed_limit: 255 }, { length: 0.1, speed_limit: 0 }, { length: 0.1 }] })).toEqual([]);
    expect(parseLimits({ edges: [{ length: 0.1, speed_limit: 50 }, { length: 0.2, speed_limit: 50 }, { length: 0.1, speed_limit: 90 }] })).toEqual([
      [0, 300, 50],
      [300, 400, 90],
    ]);
  });
});

describe("speeding", () => {
  it("red above the limit + a margin; the limit is said once per time you go over", () => {
    const w = createSpeedWatch();
    expect(overBy(50)).toBe(5);
    expect(overBy(130)).toBe(7);
    expect(w.update(54, 50, 0)).toEqual({ over: false, say: null });
    expect(w.update(57, 50, 1_000)).toEqual({ over: true, say: 50 });
    expect(w.update(62, 50, 2_000)).toEqual({ over: true, say: null });
    // a short dip under the limit and back over: not said again
    expect(w.update(48, 50, 3_000).over).toBe(false);
    expect(w.update(58, 50, 5_000)).toEqual({ over: true, say: null });
    // a new, lower limit: said
    expect(w.update(58, 30, 6_000)).toEqual({ over: true, say: 30 });
    // under it for 10 s, then over again: said again
    w.update(28, 30, 7_000);
    w.update(28, 30, 17_500);
    expect(w.update(40, 30, 18_000)).toEqual({ over: true, say: 30 });
  });
  it("no speed or no known limit: never red, nothing said", () => {
    const w = createSpeedWatch();
    expect(w.update(null, 50, 0)).toEqual({ over: false, say: null });
    expect(w.update(140, null, 0)).toEqual({ over: false, say: null });
  });
});

import { describe, expect, it } from "vitest";
// Real Valhalla responses (FOSSGIS demo server, OpenStreetMap data, language el-GR, recorded 2026-10-12):
// Syntagma → Koukaki with one alternate, and the same destination from a point south-east of Syntagma (the reroute).
import athens from "./fixtures/valhalla-athens.json";
import reroute from "./fixtures/valhalla-athens-reroute.json";
import { bearing, haversine, offset } from "./geo";
import { farDistance, nearDistance, spokenMetres, type Utterance } from "./guidance";
import { createNavigator, REROUTE_GAP_MS } from "./navigator";
import { decodePolyline } from "./polyline";
import { createProgress, type NavFix } from "./progress";
import { parsePelias, parseValhalla, prepareRoute } from "./route";
import { createSpeechQueue } from "./speech-queue";
import { drive, pointAt, straight } from "./testing/sim";

const phrase = (m: number, s: string) => `Σε ${m} μέτρα, ${s}`;
const navOpts = { phrase, reroutedText: "Νέα διαδρομή." };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("polyline", () => {
  it("decodes the reference example (precision 5) and Valhalla's precision 6", () => {
    const p = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", 5);
    expect(p).toEqual([
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ]);
    // The route starts on the road nearest to the requested point (Valhalla snaps it: ≈ 60 m here).
    const first = decodePolyline(athens.trip.legs[0].shape)[0];
    expect(haversine(first, { lat: 37.9755, lng: 23.7348 })).toBeLessThan(80);
  });
  it("refuses a truncated string", () => {
    expect(() => decodePolyline("_p~iF~ps|U_", 5)).toThrow("bad_polyline");
  });
});

describe("Valhalla response", () => {
  const routes = parseValhalla(athens);
  const [main, alt] = routes;

  it("main route + its alternate, with summary numbers in metres / seconds", () => {
    expect(routes).toHaveLength(2);
    expect(main.length_m).toBe(2748);
    expect(main.time_s).toBe(614);
    expect(alt.length_m).toBe(1924);
    expect(main.toll || main.highway || main.ferry).toBe(false);
    expect(main.via).toBe("Χατζηχρήστου");
  });

  it("maneuvers: depart first, arrive last, Greek texts, increasing positions on the shape", () => {
    const m = main.maneuvers;
    expect(m).toHaveLength(11);
    expect(m[0].kind).toBe("depart");
    expect(m.at(-1)!.kind).toBe("arrive");
    expect(m.map((x) => x.kind).slice(1, 6)).toEqual(["left", "left", "left", "left", "right"]);
    expect(m[1].instruction).toBe("Στρίψτε αριστερά στη Βασιλίσσης Αμαλίας/ΕΟ91.");
    expect(m[1].alert).toBe("Στρίψτε αριστερά στη Βασιλίσσης Αμαλίας.");
    expect(m[1].pre).toBe("Στρίψτε αριστερά στη Βασιλίσσης Αμαλίας, ΕΟ91.");
    expect(m[1].post).toBe("Συνεχίστε για 100 μέτρα.");
    expect(m[1].street).toBe("Βασιλίσσης Αμαλίας");
    // The street you turn onto, and its name rather than its road number.
    expect(m[3].street).toBe("Πλατεία Συντάγματος");
    expect(parseValhalla(reroute)[0].maneuvers[1].street).toBe("Βασιλίσσης Σοφίας");
    for (let k = 1; k < m.length; k++) expect(m[k].begin).toBeGreaterThan(m[k - 1].begin);
    expect(m.at(-1)!.begin).toBe(main.points.length - 1);
  });

  it("geometry: [lng, lat] points whose length matches the provider's within 1 %", () => {
    const p = prepareRoute(main);
    expect(main.points[0][0]).toBeCloseTo(23.73, 1);
    expect(Math.abs(p.total - main.length_m) / main.length_m).toBeLessThan(0.01);
    expect(p.at[0]).toBe(0);
    expect(p.at.at(-1)).toBeCloseTo(p.total);
  });

  it("refuses an error or a malformed answer; skips a bad alternate", () => {
    expect(() => parseValhalla({ trip: { ...athens.trip, status: 442 } })).toThrow("bad_route");
    expect(() => parseValhalla({ error: "No path could be found" })).toThrow("bad_route");
    expect(() => parseValhalla("nonsense")).toThrow("bad_route");
    const noArrive = clone(athens);
    noArrive.trip.legs[0].maneuvers.pop();
    expect(() => parseValhalla(noArrive)).toThrow("bad_route");
    const badShapeIndex = clone(athens);
    (badShapeIndex.trip.legs[0].maneuvers[2] as { begin_shape_index: number }).begin_shape_index = 10_000;
    expect(() => parseValhalla(badShapeIndex)).toThrow("bad_route");
    const badAlt = clone(athens);
    (badAlt.alternates[0].trip as { legs: unknown }).legs = "x";
    expect(parseValhalla(badAlt)).toHaveLength(1);
  });

  it("caps text lengths (a provider can't push huge strings into the UI)", () => {
    const long = clone(athens);
    long.trip.legs[0].maneuvers[1].instruction = "x".repeat(5000);
    expect(parseValhalla(long)[0].maneuvers[1].instruction).toHaveLength(300);
  });
});

describe("Pelias places", () => {
  // Shape of a Pelias /v1/autocomplete answer (Stadia Maps' format), written by hand — not a recorded response.
  const json = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", geometry: { type: "Point", coordinates: [23.7348, 37.9755] }, properties: { gid: "openstreetmap:venue:node/1", name: "Πλατεία Συντάγματος", label: "Πλατεία Συντάγματος, Αθήνα, Ελλάδα" } },
      { type: "Feature", geometry: { type: "Point", coordinates: [23.7267, 37.9715] }, properties: { gid: "x:2", name: "Κουκάκι", label: "Αθήνα, Ελλάδα" } },
      { type: "Feature", geometry: { type: "Point", coordinates: [200, 37] }, properties: { gid: "bad", name: "Out of range", label: "" } },
      { type: "Feature", geometry: null, properties: { name: "No geometry" } },
    ],
  };
  it("name + second line, coordinates, bad features skipped", () => {
    expect(parsePelias(json)).toEqual([
      { id: "openstreetmap:venue:node/1", name: "Πλατεία Συντάγματος", detail: "Αθήνα, Ελλάδα", lat: 37.9755, lng: 23.7348 },
      { id: "x:2", name: "Κουκάκι", detail: "Αθήνα, Ελλάδα", lat: 37.9715, lng: 23.7267 },
    ]);
    expect(() => parsePelias({})).toThrow("bad_places");
  });
});

describe("guidance distances", () => {
  it("grow with speed, within bounds", () => {
    expect(nearDistance(1.4)).toBe(50); // walking
    expect(nearDistance(13.9)).toBeCloseTo(131.2); // 50 km/h
    expect(nearDistance(36)).toBe(300); // 130 km/h
    expect(farDistance(13.9)).toBeCloseTo(417);
    expect(farDistance(36)).toBe(1080);
    expect(farDistance(0)).toBe(300);
    expect(nearDistance(null)).toBe(nearDistance(13.9));
  });
  it("are rounded the way people say them", () => {
    expect([12, 74, 180, 260, 949, 1180, 1300, 2740].map(spokenMetres)).toEqual([50, 50, 200, 300, 900, 1000, 1500, 2500]);
  });
});

/** Run fixes through a navigator; collect what it says, when, and every progress. */
function run(nav: ReturnType<typeof createNavigator>, fixes: NavFix[]) {
  const said: { u: Utterance; toNext: number; next: number; t: number }[] = [];
  const steps: number[] = [];
  let reroutes = 0;
  let last = null as ReturnType<typeof nav.update> | null;
  for (const f of fixes) {
    const u = nav.update(f);
    if (u.say) said.push({ u: u.say, toNext: u.progress.toNext, next: u.progress.next, t: f.t });
    steps.push(u.progress.step);
    if (u.reroute) reroutes++;
    last = u;
  }
  return { said, steps, reroutes, last: last! };
}

describe("a simulated drive along the real route", () => {
  const [main] = parseValhalla(athens);
  const r = prepareRoute(main);

  it("50 km/h with ±6 m GPS noise: never off the route, maneuvers in order, each said in time, arrival", () => {
    const nav = createNavigator(main, navOpts);
    const fixes = drive(r, { speed: 13.9, noise: 6, seed: 7 });
    const { said, steps, reroutes, last } = run(nav, fixes);
    expect(reroutes).toBe(0);
    // The step never goes back, even where the route runs both ways along Amalias (maneuvers 1 and 5).
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThanOrEqual(steps[i - 1]);
    expect(steps.at(-1)).toBe(main.maneuvers.length - 1);
    expect(last.progress.arrived).toBe(true);
    expect(last.progress.eta_s).toBe(0);

    // First: the depart text (it already names the close first turn: "…Then turn left onto Amalias").
    expect(said[0].u.key).toBe("start");
    expect(said[0].u.text).toContain("Στη συνέχεια Στρίψτε αριστερά στη Βασιλίσσης Αμαλίας");
    // …so that turn, 78 m ahead, isn't announced again a second later.
    expect(said.find((s) => s.u.key === "1:near")).toBeUndefined();
    // A "Then …" turn further on is still announced when you get there (Filellinon → Amalias: 10 s later).
    expect(said.find((s) => s.u.key === "4:near")!.u.text).toContain("Στη συνέχεια Στρίψτε δεξιά");
    expect(said.filter((s) => s.u.key === "5:near")).toHaveLength(1);
    // Every later maneuver (except that first one) gets its "near" announcement once, before reaching it, and no further than near + one fix.
    const near = nearDistance(13.9);
    for (let k = 2; k < main.maneuvers.length; k++) {
      const hits = said.filter((s) => s.u.key === `${k}:near`);
      expect(hits, `maneuver ${k}`).toHaveLength(1);
      expect(hits[0].toNext).toBeGreaterThan(0);
      expect(hits[0].toNext).toBeLessThanOrEqual(near);
      const stretch = r.at[k] - r.at[k - 1];
      // Said as soon as it is within reach (from the previous turn when they are close together).
      expect(hits[0].toNext).toBeGreaterThan(Math.min(stretch, near) - 13.9 * 1.5 - 12);
    }
    // Stretches longer than near + 80 m get an "In … m" alert first (455, 477, 743 and 500 m); short ones don't.
    const far = said.filter((s) => s.u.key.endsWith(":far"));
    expect(far.map((s) => s.u.key)).toEqual(["4:far", "6:far", "8:far", "10:far"]);
    expect(far[1].u.text).toMatch(/^Σε (300|400) μέτρα, στρίψτε ελαφρώς δεξιά στη ΕΟ91\.$/);
    // …and "post" (Continue for …) only when the next maneuver is far beyond the alert distance.
    for (const s of said.filter((x) => x.u.key.endsWith(":post"))) expect(s.toNext).toBeGreaterThan(farDistance(13.9) + 200);
    // Never the same key twice, at most one announcement per fix, in route order.
    expect(new Set(said.map((s) => s.u.key)).size).toBe(said.length);
    expect(new Set(said.map((s) => s.t)).size).toBe(said.length);
    const order = said.map((s) => (s.u.key === "start" ? 0 : parseInt(s.u.key)));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The arrival announcement.
    expect(said.at(-1)!.u.text).toBe("Ο προορισμός σας βρίσκεται δεξιά.");
  });

  it("ETA follows the provider's times and only goes down while driving", () => {
    const p = createProgress(r);
    const fixes = drive(r, { speed: 13.9, seed: 3 });
    const etas = fixes.map((f) => p.update(f).eta_s);
    expect(etas[0]).toBeCloseTo(main.time_s, -1);
    for (let i = 1; i < etas.length; i++) expect(etas[i]).toBeLessThanOrEqual(etas[i - 1] + 0.5);
    expect(etas.at(-1)).toBe(0);
  });

  it("walking speed: smaller distances (near = 50 m) and still every maneuver once", () => {
    const nav = createNavigator(main, navOpts);
    const { said, reroutes, last } = run(nav, drive(r, { speed: 1.4, noise: 4, seed: 11 }));
    expect(reroutes).toBe(0);
    expect(last.progress.arrived).toBe(true);
    for (const s of said.filter((x) => x.u.key.endsWith(":near"))) expect(s.toNext).toBeLessThanOrEqual(50);
    for (let k = 2; k < main.maneuvers.length; k++) expect(said.filter((s) => s.u.key === `${k}:near`)).toHaveLength(1);
  });

  it("noise is not a detour: one wild fix 90 m off, a useless fix (±150 m), jitter at a red light", () => {
    const p = createProgress(r);
    const fixes = drive(r, { speed: 10, to: 600, seed: 5 });
    let t = 0;
    for (const f of fixes) {
      p.update(f);
      t = f.t;
    }
    const here = pointAt(r, 600).p;
    const wild = { ...offset(here, 90, 90), accuracy: 10, speed: 10, course: null, t: t + 1000 };
    const afterWild = p.update(wild);
    expect(afterWild.offRoute).toBe(false);
    expect(afterWild.along).toBeCloseTo(600, -1); // the numbers stay those of the last place on the route
    expect(p.update({ ...offset(here, 400, 0), accuracy: 150, t: t + 2000 })).toEqual(afterWild); // ignored
    let off = false;
    for (let i = 0; i < 60; i++) off ||= p.update({ ...offset(here, 8 * ((i * 7) % 10) / 10, i * 37), accuracy: 12, speed: 0, course: null, t: t + 3000 + i * 1000 }).offRoute;
    expect(off).toBe(false);
  });

  it("standing at a red light: nothing is said twice", () => {
    const nav = createNavigator(main, navOpts);
    const fixes = drive(r, { speed: 10, to: 700, seed: 9 });
    const stop = fixes.at(-1)!;
    for (let i = 1; i <= 90; i++) fixes.push({ ...offset(stop, 5, i * 40), accuracy: 10, speed: 0, course: null, t: stop.t + i * 1000 });
    const { said } = run(nav, fixes);
    expect(new Set(said.map((s) => s.u.key)).size).toBe(said.length);
  });

  it("leaving the route: off after 3 fixes / 4 s, one reroute, none again within 10 s, a failed one retried", () => {
    const nav = createNavigator(main, navOpts);
    // Drive to the first left turn (Amalias), go straight on south-east instead.
    const toTurn = drive(r, { speed: 10, to: r.at[1], seed: 2 });
    const turn = toTurn.at(-1)!;
    const away = straight(turn, 150, 10, 30, turn.t);
    const a = run(nav, toTurn);
    expect(a.reroutes).toBe(0);
    let firstOff = -1, firstReroute = -1;
    const reroutes: number[] = [];
    away.forEach((f, i) => {
      const u = nav.update(f);
      if (u.progress.offRoute && firstOff < 0) firstOff = i;
      if (u.reroute) {
        reroutes.push(f.t);
        if (firstReroute < 0) firstReroute = i;
      }
      // While off, the banner keeps the last place on the route and nothing is said about the old route.
      if (u.progress.offRoute) expect(u.say).toBeNull();
      if (u.reroute) nav.rerouted(null); // the request failed (no network)
    });
    // 40 m + accuracy → leaves the corridor after ≈ 4–5 s, then 3 fixes / 4 s of debounce.
    expect(firstOff).toBeGreaterThanOrEqual(6);
    expect(firstOff).toBeLessThanOrEqual(10);
    expect(firstReroute).toBe(firstOff);
    for (let i = 1; i < reroutes.length; i++) expect(reroutes[i] - reroutes[i - 1]).toBeGreaterThanOrEqual(REROUTE_GAP_MS);
    expect(reroutes.length).toBeGreaterThanOrEqual(2); // retried after the failure
  });

  it("…then the new route (recorded reroute): 'new route' first, followed to the destination", () => {
    const nav = createNavigator(main, navOpts);
    const toTurn = drive(r, { speed: 10, to: r.at[1], seed: 2 });
    const turn = toTurn.at(-1)!;
    run(nav, toTurn);
    // Drive off towards the point the recorded reroute was asked from (its first point, on the road).
    const [next] = parseValhalla(reroute);
    const start = { lat: next.points[0][1], lng: next.points[0][0] };
    const away = straight(turn, bearing(turn, start), 10, Math.round(haversine(turn, start) / 10), turn.t);
    let asked = false;
    for (const f of away) asked ||= nav.update(f).reroute;
    expect(asked).toBe(true);
    nav.rerouted(next);
    const r2 = nav.route;
    // The new route starts close to where the detour went (a recorded answer for that point).
    expect(haversine(away.at(-1)!, r2.pts[0])).toBeLessThan(15);
    const { said, reroutes, last } = run(nav, drive(r2, { speed: 12, noise: 5, seed: 4, t0: away.at(-1)!.t + 1000 }));
    expect(said[0].u).toEqual({ key: "rerouted", text: "Νέα διαδρομή." });
    expect(reroutes).toBe(0);
    expect(last.progress.arrived).toBe(true);
  });

  it("starting off the road (the route begins on the nearest street, ≈ 60 m away): no reroute until you reach it", () => {
    const nav = createNavigator(main, navOpts);
    // Recorded request point (Syntagma) → the route's first point, then along the route.
    const origin = { lat: 37.9755, lng: 23.7348 };
    const fixes: NavFix[] = [];
    for (let i = 0; i < 20; i++) fixes.push({ ...origin, accuracy: 10, speed: 0, course: null, t: i * 1000 }); // waiting 20 s
    const toRoad = haversine(origin, r.pts[0]);
    fixes.push({ lat: 37.97535, lng: 23.73425, accuracy: 8, t: fixes.at(-1)!.t + 1000 }); // (as in the browser flow)
    for (let d = 5; d < toRoad; d += 5) fixes.push({ ...offset(origin, d, bearing(origin, r.pts[0])), accuracy: 10, speed: 5, course: null, t: fixes.at(-1)!.t + 1000 });
    fixes.push(...drive(r, { speed: 10, to: 600, t0: fixes.at(-1)!.t + 1000 }));
    const { reroutes, last, said } = run(nav, fixes);
    expect(reroutes).toBe(0);
    expect(last.progress.along).toBeGreaterThan(550);
    // The route loops round Syntagma square and passes ≈ 30 m from that start point again 400 m later: the first
    // fixes must not be taken for that later stretch (it once said "In 300 m, turn onto Filellinon" first).
    const order = said.map((s) => (s.u.key === "start" ? 0 : parseInt(s.u.key)));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // …but going away from it (north-east: the route lies south-west of Syntagma) is a reason to ask again.
    const nav2 = createNavigator(main, navOpts);
    const away = straight(origin, 45, 10, 20, 0);
    expect(run(nav2, [{ ...origin, accuracy: 10, t: -1000 }, ...away]).reroutes).toBe(1);
  });

  it("driving the wrong way along the route counts as leaving it", () => {
    const p = createProgress(r);
    for (const f of drive(r, { speed: 10, to: 1000, seed: 8 })) p.update(f);
    let off = false;
    let t = 1_000_000;
    for (let d = 1000; d > 900; d -= 10) {
      const { p: pt, brg } = pointAt(r, d);
      off = p.update({ ...pt, accuracy: 8, speed: 10, course: (brg + 180) % 360, t: (t += 1000) }).offRoute;
    }
    expect(off).toBe(true);
  });
});

describe("speech queue (guidance vs push-to-talk)", () => {
  function fakeEngine() {
    const log: string[] = [];
    let finish: (() => void) | null = null;
    return {
      log,
      done: () => {
        const f = finish;
        finish = null;
        f?.();
      },
      engine: {
        speak: (text: string) => {
          log.push(`say:${text}`);
          return new Promise<void>((res) => (finish = res));
        },
        stop: () => {
          log.push("stop");
          const f = finish;
          finish = null;
          f?.();
        },
      },
    };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("waits while someone talks, then says the newest; an interrupted one is said again; stale ones dropped", async () => {
    const f = fakeEngine();
    const q = createSpeechQueue(f.engine);
    q.say({ key: "1", text: "A" });
    expect(f.log).toEqual(["say:A"]);
    // A talk starts mid-sentence: stopped, and repeated after the talk.
    q.setTalking(true);
    expect(f.log).toEqual(["say:A", "stop"]);
    await tick();
    expect(q.waiting).toBe("A");
    q.setTalking(false);
    await tick();
    expect(f.log).toEqual(["say:A", "stop", "say:A"]);
    f.done();
    await tick();
    // During a talk, two announcements: only the newest is said afterwards.
    q.setTalking(true);
    q.say({ key: "2", text: "B" });
    q.say({ key: "3", text: "C" });
    q.setTalking(false);
    await tick();
    expect(f.log.at(-1)).toBe("say:C");
    f.done();
    await tick();
    // One that no longer applies (the turn is behind you) is dropped.
    q.setTalking(true);
    q.say({ key: "4", text: "D", still: () => false });
    q.setTalking(false);
    await tick();
    expect(f.log.at(-1)).toBe("say:C");
    // While speaking, a new one waits for the end (never cuts the current sentence).
    q.say({ key: "5", text: "E" });
    q.say({ key: "6", text: "F" });
    expect(f.log.at(-1)).toBe("say:E");
    f.done();
    await tick();
    expect(f.log.at(-1)).toBe("say:F");
  });
});

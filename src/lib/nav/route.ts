import { haversine, type LatLng } from "./geo";
import { decodePolyline } from "./polyline";

/**
 * Provider-neutral routes and places: what the server function returns to the app, whatever the routing / search
 * provider is (today Stadia Maps: Valhalla routing, Pelias autocomplete — see `provider.server.ts`).
 */

export type ManeuverKind =
  | "depart"
  | "arrive"
  | "straight"
  | "slight-right"
  | "right"
  | "sharp-right"
  | "slight-left"
  | "left"
  | "sharp-left"
  | "uturn"
  | "ramp-right"
  | "ramp-left"
  | "merge"
  | "roundabout"
  | "ferry";

export interface NavManeuver {
  kind: ManeuverKind;
  /** Written instruction for the banner ("Στρίψτε αριστερά στη Φιλελλήνων/ΕΟ1."). */
  instruction: string;
  /** Spoken well before the maneuver, after "In 400 m, …". */
  alert: string | null;
  /** Spoken right before it. */
  pre: string | null;
  /** Spoken right after it ("Continue for 500 m."). */
  post: string | null;
  /** The street you are on after the maneuver (for the banner). */
  street: string | null;
  /** Index into `points` where the maneuver happens. */
  begin: number;
  /** Length / time of the stretch that follows the maneuver. */
  length_m: number;
  time_s: number;
  /** Roundabout exit number. */
  exit: number | null;
  /** The spoken `pre` also names the next maneuver ("… Then turn right onto …"). */
  cuesNext: boolean;
}

export interface NavRoute {
  /** [lng, lat], 6 decimals. */
  points: [number, number][];
  length_m: number;
  time_s: number;
  maneuvers: NavManeuver[];
  toll: boolean;
  highway: boolean;
  ferry: boolean;
  /** The main road (the longest stretch) — tells alternatives apart ("via Syngrou"). */
  via: string | null;
}

export interface Place {
  id: string;
  name: string;
  /** Second line (street, area, city). */
  detail: string;
  lat: number;
  lng: number;
}

// --- Valhalla -----------------------------------------------------------------------------------------------------


const KINDS: Record<number, ManeuverKind> = {
  1: "depart", 2: "depart", 3: "depart",
  4: "arrive", 5: "arrive", 6: "arrive",
  7: "straight", 8: "straight", 22: "straight", 17: "straight",
  9: "slight-right", 10: "right", 11: "sharp-right", 12: "uturn",
  13: "uturn", 14: "sharp-left", 15: "left", 16: "slight-left",
  18: "ramp-right", 20: "ramp-right", 23: "slight-right",
  19: "ramp-left", 21: "ramp-left", 24: "slight-left",
  25: "merge", 37: "merge", 38: "merge",
  26: "roundabout", 27: "roundabout",
  28: "ferry", 29: "ferry",
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 300): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bad = (): never => {
  throw new Error("bad_route");
};

function parseTrip(trip: unknown): NavRoute {
  if (!isObj(trip) || trip.status !== 0 || !Array.isArray(trip.legs) || trip.legs.length === 0) bad();
  const t = trip as Obj;
  const unit = t.units === "miles" ? 1609.344 : 1000;
  const points: [number, number][] = [];
  const maneuvers: NavManeuver[] = [];
  for (const leg of t.legs as unknown[]) {
    if (!isObj(leg) || typeof leg.shape !== "string" || !Array.isArray(leg.maneuvers)) bad();
    const l = leg as Obj;
    const base = points.length ? points.length - 1 : 0;
    const shape = decodePolyline(l.shape as string);
    if (shape.length < 2) bad();
    // Legs share their end / start point: keep it once.
    for (const p of points.length ? shape.slice(1) : shape) points.push([+p.lng.toFixed(6), +p.lat.toFixed(6)]);
    for (const m of l.maneuvers as unknown[]) {
      if (!isObj(m)) bad();
      const mm = m as Obj;
      const type = num(mm.type);
      const begin = num(mm.begin_shape_index);
      const instruction = str(mm.instruction);
      if (type == null || begin == null || !instruction || begin < 0 || begin >= shape.length) bad();
      const kind = KINDS[type!] ?? "straight";
      // An intermediate leg's "destination" is just a waypoint: keep only the trip's last arrival.
      if (kind === "arrive" && maneuvers.length && leg !== (t.legs as unknown[]).at(-1)) continue;
      if (kind === "depart" && maneuvers.length) continue;
      const names = Array.isArray(mm.street_names) ? (mm.street_names as unknown[]).map((s) => str(s, 80)).filter(Boolean) : [];
      maneuvers.push({
        kind,
        instruction: instruction!,
        alert: str(mm.verbal_transition_alert_instruction),
        pre: str(mm.verbal_pre_transition_instruction),
        post: str(mm.verbal_post_transition_instruction),
        street: (names[0] as string | undefined) ?? null,
        begin: base + begin!,
        length_m: Math.max(0, (num(mm.length) ?? 0) * unit),
        time_s: Math.max(0, num(mm.time) ?? 0),
        exit: num(mm.roundabout_exit_count),
        cuesNext: mm.verbal_multi_cue === true,
      });
    }
  }
  if (!maneuvers.length || maneuvers.at(-1)!.kind !== "arrive") bad();
  const s = isObj(t.summary) ? t.summary : {};
  const longest = maneuvers.filter((m) => m.street).sort((a, b) => b.length_m - a.length_m)[0];
  return {
    points,
    length_m: Math.round((num(s.length) ?? 0) * unit),
    time_s: Math.round(num(s.time) ?? maneuvers.reduce((a, m) => a + m.time_s, 0)),
    maneuvers,
    toll: s.has_toll === true,
    highway: s.has_highway === true,
    ferry: s.has_ferry === true,
    via: longest?.street ?? null,
  };
}

/** A Valhalla /route response → the main route first, then its alternates (bad alternates are skipped). */
export function parseValhalla(json: unknown): NavRoute[] {
  if (!isObj(json)) bad();
  const routes = [parseTrip((json as Obj).trip)];
  const alts = (json as Obj).alternates;
  if (Array.isArray(alts))
    for (const a of alts) {
      try {
        if (isObj(a)) routes.push(parseTrip(a.trip));
      } catch {
        // an alternate we can't read is just not offered
      }
    }
  return routes;
}

// --- Pelias (Stadia autocomplete) -----------------------------------------------------------------------------------

/** A Pelias GeoJSON response → places (bad features skipped). */
export function parsePelias(json: unknown): Place[] {
  if (!isObj(json) || !Array.isArray(json.features)) throw new Error("bad_places");
  const out: Place[] = [];
  for (const f of json.features as unknown[]) {
    if (!isObj(f) || !isObj(f.geometry) || !isObj(f.properties)) continue;
    const c = f.geometry.coordinates;
    if (!Array.isArray(c) || c.length < 2) continue;
    const [lng, lat] = c as unknown[];
    const p = f.properties as Obj;
    const name = str(p.name, 120);
    if (num(lat) == null || num(lng) == null || !name || Math.abs(lat as number) > 90 || Math.abs(lng as number) > 180) continue;
    const label = str(p.label, 200) ?? "";
    // The label repeats the name first ("Σύνταγμα, Αθήνα, Ελλάδα"): the rest is the second line.
    const detail = label.startsWith(name) ? label.slice(name.length).replace(/^[,\s]+/, "") : label;
    out.push({ id: str(p.gid, 200) ?? `${lat},${lng}`, name, detail, lat: lat as number, lng: lng as number });
  }
  return out;
}

// --- On the client ---------------------------------------------------------------------------------------------------

/** A route ready for tracking: points as {lat, lng}, metres from the start at every point and at every maneuver. */
export interface PreparedRoute {
  route: NavRoute;
  pts: LatLng[];
  /** cum[i] = metres along the route at point i. */
  cum: number[];
  /** at[k] = metres along the route where maneuver k happens. */
  at: number[];
  /** Geometric length (the tracker's own metres; the provider's length_m may differ slightly). */
  total: number;
  end: LatLng;
}

export function prepareRoute(route: NavRoute): PreparedRoute {
  const pts = route.points.map(([lng, lat]) => ({ lat, lng }));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
  const at = route.maneuvers.map((m) => cum[Math.min(m.begin, cum.length - 1)]);
  return { route, pts, cum, at, total: cum.at(-1) ?? 0, end: pts.at(-1)! };
}

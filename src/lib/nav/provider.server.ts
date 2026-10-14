// Server-only: the routing / search provider. The ONE place that knows who the provider is (today Stadia Maps:
// hosted Valhalla routing + Pelias autocomplete); swap it by rewriting these two functions — the app only sees
// NavRoute / Place (src/lib/nav/route.ts). The key comes from the Worker's secrets and never leaves the server.
import { parseLimits, parsePelias, parseValhalla, type NavRoute, type Place } from "./route";
import type { LatLng } from "./geo";

export class ProviderError extends Error {
  constructor(public code: "no_route" | "provider" | "not_configured") {
    super(code);
  }
}

const TIMEOUT_MS = 8_000;

function config() {
  const key = process.env.ROUTING_API_KEY;
  const base = (process.env.ROUTING_BASE_URL || "https://api.stadiamaps.com").replace(/\/+$/, "");
  if (!key) throw new ProviderError("not_configured");
  return { key, base };
}

const valhallaLang = (lang: string) => (lang === "en" ? "en-US" : "el-GR");

/** Driving routes from → to (the main one first, up to 2 alternatives). `heading`: where you're going now (reroute). */
export async function providerRoute(from: LatLng & { heading?: number }, to: LatLng, lang: string, alternatives: boolean): Promise<NavRoute[]> {
  const { key, base } = config();
  const language = valhallaLang(lang);
  const body = {
    locations: [
      // While driving, start in your direction of travel (no route that begins with a U-turn).
      { lat: from.lat, lon: from.lng, ...(from.heading != null ? { heading: Math.round(from.heading), heading_tolerance: 45 } : {}) },
      { lat: to.lat, lon: to.lng },
    ],
    costing: "auto",
    units: "kilometers",
    language,
    directions_options: { units: "kilometers", language },
    ...(alternatives ? { alternates: 2 } : {}),
  };
  let res: Response;
  try {
    res = await fetch(`${base}/route/v1?api_key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ProviderError("provider");
  }
  // Valhalla answers 400 with error_code 442 / 171 … when there is no road between the two points.
  if (res.status === 400) throw new ProviderError("no_route");
  if (!res.ok) throw new ProviderError("provider");
  let routes: NavRoute[];
  try {
    routes = parseValhalla(await res.json());
  } catch {
    throw new ProviderError("provider");
  }
  // Speed limits: a second, optional call per route (map matching over its own shape). A route without them still works.
  const limits = await Promise.all(routes.map((r) => providerLimits(r, key, base).catch(() => [])));
  return routes.map((r, i) => ({ ...r, limits: limits[i] }));
}

const LIMITS_TIMEOUT_MS = 4_000;

/** Speed limits along a route: Valhalla trace_attributes over the route's own points (edge_walk follows them exactly). */
async function providerLimits(route: NavRoute, key: string, base: string): Promise<[number, number, number][]> {
  if (route.points.length < 2 || route.points.length > 20_000) return [];
  const res = await fetch(`${base}/trace_attributes/v1?api_key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      shape: route.points.map(([lng, lat]) => ({ lat, lon: lng })),
      shape_match: "edge_walk",
      costing: "auto",
      filters: { attributes: ["edge.speed_limit", "edge.length"], action: "include" },
    }),
    signal: AbortSignal.timeout(LIMITS_TIMEOUT_MS),
  });
  if (!res.ok) return [];
  return parseLimits(await res.json());
}

/** Places matching what you typed, nearest to `near` first. */
export async function providerSearch(q: string, near: LatLng | null, lang: string): Promise<Place[]> {
  const { key, base } = config();
  const params = new URLSearchParams({ text: q, size: "8", lang: lang === "en" ? "en" : "el", api_key: key });
  if (near) {
    params.set("focus.point.lat", near.lat.toFixed(3));
    params.set("focus.point.lon", near.lng.toFixed(3));
  }
  let res: Response;
  try {
    res = await fetch(`${base}/geocoding/v1/autocomplete?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ProviderError("provider");
  }
  if (!res.ok) throw new ProviderError("provider");
  try {
    return parsePelias(await res.json());
  } catch {
    throw new ProviderError("provider");
  }
}

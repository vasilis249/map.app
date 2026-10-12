// Server-only: the app's navigation endpoints on the Worker (src/server.ts routes /api/nav/* here).
//   POST /api/nav/route   { from: {lat, lng, heading?}, to: {lat, lng}, alternatives?, lang? } → { routes: NavRoute[] }
//   POST /api/nav/search  { q, near?: {lat, lng}, lang? } → { places: Place[] }
// POST (not GET) keeps the trip's coordinates and the search text out of URLs and access logs. Every call needs the
// caller's Supabase session (Authorization: Bearer <access token>): the database checks it and the per-user limits
// (public.nav_quota) before the provider is called. Answers are cached at the edge (no user in the key).
import { haversine, type LatLng } from "./geo";
import { providerRoute, providerSearch, ProviderError } from "./provider.server";

type Json = Record<string, unknown>;
const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
const fail = (status: number, error: string) => json(status, { error });

const MAX_BODY = 4_096;
/** The longest trip we route (a straight line; Greece end to end is ≈ 1 000 km). */
const MAX_TRIP_M = 1_500_000;
const ROUTE_TTL_S = 300;
/** Part of every cache key: bump it when the shape of NavRoute / Place (route.ts) changes. */
const CACHE_VERSION = 1;
const SEARCH_TTL_S = 86_400;

function point(v: unknown): LatLng | null {
  if (typeof v !== "object" || v === null) return null;
  const { lat, lng } = v as Json;
  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}
const lang = (v: unknown) => (v === "en" ? "en" : "el");

/** Ask the database: is this a signed-in, allowed person within their limits? */
async function quota(token: string, kind: "route" | "search"): Promise<Response | null> {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anon) return fail(503, "not_configured");
  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/+$/, "")}/rest/v1/rpc/nav_quota`, {
      method: "POST",
      headers: { apikey: anon, authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ p_kind: kind }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return fail(503, "unavailable");
  }
  if (res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as Json;
  if (res.status === 401 || res.status === 403 || body.message === "not_allowed" || body.message === "age_not_confirmed")
    return fail(401, String(body.message === "age_not_confirmed" ? "age_not_confirmed" : "not_allowed"));
  if (body.message === "rate_limited") return fail(429, "rate_limited");
  return fail(503, "unavailable");
}

/** The edge cache (Cloudflare); absent elsewhere (then: no cache). */
function edgeCache(): Cache | null {
  try {
    return (globalThis.caches as unknown as { default?: Cache } | undefined)?.default ?? null;
  } catch {
    return null;
  }
}
async function cached(key: string, ttl: number, make: () => Promise<unknown>): Promise<Response> {
  const cache = edgeCache();
  const req = new Request(`https://nav-cache.invalid/v${CACHE_VERSION}/${key}`);
  const hit = await cache?.match(req).catch(() => undefined);
  if (hit) return json(200, await hit.json(), { "x-nav-cache": "hit" });
  const body = await make();
  await cache
    ?.put(req, new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}` } }))
    .catch(() => undefined);
  return json(200, body, { "x-nav-cache": "miss" });
}

function providerFailure(e: unknown): Response {
  if (e instanceof ProviderError) {
    if (e.code === "no_route") return fail(422, "no_route");
    if (e.code === "not_configured") return fail(503, "not_configured");
  }
  return fail(502, "provider");
}

export async function handleNav(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const kind = path === "/api/nav/route" ? "route" : path === "/api/nav/search" ? "search" : null;
  if (!kind) return fail(404, "not_found");
  if (request.method !== "POST") return fail(405, "method_not_allowed");
  const auth = request.headers.get("authorization") ?? "";
  const token = /^Bearer ([A-Za-z0-9._~+/=-]{20,4096})$/.exec(auth)?.[1];
  if (!token) return fail(401, "not_allowed");
  const text = await request.text();
  if (text.length > MAX_BODY) return fail(413, "too_large");
  let body: Json;
  try {
    body = JSON.parse(text) as Json;
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error();
  } catch {
    return fail(400, "bad_input");
  }

  if (kind === "route") {
    const from = point(body.from);
    const to = point(body.to);
    if (!from || !to) return fail(400, "bad_input");
    const h = (body.from as Json).heading;
    const heading = typeof h === "number" && Number.isFinite(h) && h >= 0 && h <= 360 ? h : undefined;
    if (haversine(from, to) > MAX_TRIP_M) return fail(422, "too_far");
    const alternatives = body.alternatives !== false;
    const l = lang(body.lang);
    const denied = await quota(token, "route");
    if (denied) return denied;
    // ≈ 10 m grid for the start, 1 m for the destination; heading in 30° steps.
    const key = `route/${l}/${from.lat.toFixed(4)},${from.lng.toFixed(4)}/${heading == null ? "-" : Math.round(heading / 30) % 12}/${to.lat.toFixed(5)},${to.lng.toFixed(5)}/${alternatives ? 1 : 0}`;
    try {
      return await cached(key, ROUTE_TTL_S, async () => ({
        routes: await providerRoute({ ...from, heading: heading == null ? undefined : Math.round(heading / 30) * 30 }, to, l, alternatives),
      }));
    } catch (e) {
      return providerFailure(e);
    }
  }

  const q = typeof body.q === "string" ? body.q.normalize("NFC").replace(/\s+/g, " ").trim() : "";
  if (q.length < 2 || q.length > 100) return fail(400, "bad_input");
  const near = body.near == null ? null : point(body.near);
  if (body.near != null && !near) return fail(400, "bad_input");
  const l = lang(body.lang);
  const denied = await quota(token, "search");
  if (denied) return denied;
  // Results depend on where you are only roughly: a ≈ 1 km grid.
  const nearKey = near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : "-";
  const rounded = near ? { lat: +near.lat.toFixed(2), lng: +near.lng.toFixed(2) } : null;
  try {
    return await cached(`search/${l}/${nearKey}/${encodeURIComponent(q.toLocaleLowerCase())}`, SEARCH_TTL_S, async () => ({
      places: await providerSearch(q, rounded, l),
    }));
  } catch (e) {
    return providerFailure(e);
  }
}

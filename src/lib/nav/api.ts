import { supabase } from "@/integrations/supabase/client";
import type { LatLng } from "./geo";
import type { NavRoute, Place } from "./route";

/** Errors the screens explain: no road there, too far, too many requests, offline / provider down, signed out. */
export type NavError = "no_route" | "too_far" | "rate_limited" | "unavailable" | "not_allowed";

export class NavApiError extends Error {
  constructor(public code: NavError) {
    super(code);
  }
}

/** Our Worker's /api/nav/* (same origin as the app: the provider key stays on the server). */
async function call<T>(path: "route" | "search", body: unknown, signal?: AbortSignal): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new NavApiError("not_allowed");
  let res: Response;
  try {
    res = await fetch(`/api/nav/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new NavApiError("unavailable");
  }
  if (res.ok) return (await res.json()) as T;
  const { error } = (await res.json().catch(() => ({}))) as { error?: string };
  if (error === "no_route" || error === "too_far" || error === "rate_limited" || error === "not_allowed") throw new NavApiError(error);
  throw new NavApiError("unavailable");
}

export async function fetchRoutes(
  from: LatLng & { heading?: number | null },
  to: LatLng,
  lang: string,
  alternatives = true,
): Promise<NavRoute[]> {
  const heading = from.heading ?? undefined;
  const { routes } = await call<{ routes: NavRoute[] }>("route", {
    from: { lat: from.lat, lng: from.lng, ...(heading != null ? { heading } : {}) },
    to: { lat: to.lat, lng: to.lng },
    lang: lang.startsWith("en") ? "en" : "el",
    alternatives,
  });
  return routes;
}

export async function searchPlaces(q: string, near: LatLng | null, lang: string, signal?: AbortSignal): Promise<Place[]> {
  const { places } = await call<{ places: Place[] }>(
    "search",
    { q, ...(near ? { near: { lat: near.lat, lng: near.lng } } : {}), lang: lang.startsWith("en") ? "en" : "el" },
    signal,
  );
  return places;
}

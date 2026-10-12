import { supabase } from "@/integrations/supabase/client";
import type { LatLng } from "@/lib/nav/geo";
import type { RoadKind, RoadReport } from "./road";

/** Errors the screens explain (anything else: the generic message). */
export type RoadError = "too_many_strikes" | "rate_limited" | "own_report" | "not_found";
const KNOWN: RoadError[] = ["too_many_strikes", "rate_limited", "own_report", "not_found"];

export class RoadApiError extends Error {
  constructor(public code: RoadError | "generic") {
    super(code);
  }
}
function fail(error: { message: string } | null) {
  if (!error) return;
  const code = KNOWN.find((k) => error.message === k);
  throw new RoadApiError(code ?? "generic");
}

export interface Box {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

/** A box around you (≈ 2 km), or around a route (+ ≈ 500 m), rounded so the query key stays put while you move. */
export function boxAround(points: LatLng[], marginDeg: number): Box | null {
  if (!points.length) return null;
  const r = (v: number, up: boolean) => (up ? Math.ceil(v * 100) / 100 : Math.floor(v * 100) / 100);
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }
  // (the server refuses boxes larger than 2° × 2.5°: a very long route is watched around you instead)
  if (maxLat - minLat > 1.9 || maxLng - minLng > 2.4) return boxAround([points[0]], 0.02);
  return { minLat: r(minLat - marginDeg, false), minLng: r(minLng - marginDeg, false), maxLat: r(maxLat + marginDeg, true), maxLng: r(maxLng + marginDeg, true) };
}

export const roadKeys = { box: (b: Box | null) => ["road", b?.minLat, b?.minLng, b?.maxLat, b?.maxLng] as const };

export async function roadReportsIn(b: Box): Promise<RoadReport[]> {
  const { data, error } = await supabase.rpc("road_reports_in", { p_min_lat: b.minLat, p_min_lng: b.minLng, p_max_lat: b.maxLat, p_max_lng: b.maxLng });
  fail(error);
  return (data ?? []) as RoadReport[];
}

export async function createRoadReport(kind: RoadKind, at: LatLng, heading: number | null): Promise<string> {
  const { data, error } = await supabase.rpc("road_report", { p_kind: kind, p_lat: at.lat, p_lng: at.lng, p_heading: heading ?? undefined });
  fail(error);
  return data as string;
}

export async function voteRoadReport(id: string, vote: 1 | -1) {
  fail((await supabase.rpc("road_vote", { p_id: id, p_vote: vote })).error);
}

export async function reportRoadAbuse(id: string) {
  fail((await supabase.rpc("report_content", { p_kind: "road", p_target: id, p_reason: "road" })).error);
}

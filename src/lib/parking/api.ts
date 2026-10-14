import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { LatLng } from "@/lib/nav/geo";
import { boxAround, type Box } from "@/lib/reports/api";
import type { ParkingSpot } from "./parking";

export type ParkingError = "rate_limited" | "not_found";

export class ParkingApiError extends Error {
  constructor(public code: ParkingError | "generic") {
    super(code);
  }
}
function fail(error: { message: string } | null) {
  if (!error) return;
  throw new ParkingApiError(error.message === "rate_limited" || error.message === "not_found" ? error.message : "generic");
}

/** I'm leaving this spot (green for others). */
export async function leaveSpot(at: LatLng): Promise<string> {
  const { data, error } = await supabase.rpc("parking_leave", { p_lat: at.lat, p_lng: at.lng });
  fail(error);
  return data as string;
}

/** I parked here (red; a green spot here turns red). */
export async function parkHere(at: LatLng): Promise<string> {
  const { data, error } = await supabase.rpc("parking_park", { p_lat: at.lat, p_lng: at.lng });
  fail(error);
  return data as string;
}

/** That green spot got taken. */
export async function markTaken(id: string) {
  fail((await supabase.rpc("parking_taken", { p_id: id })).error);
}

async function parkingIn(b: Box): Promise<ParkingSpot[]> {
  const { data, error } = await supabase.rpc("parking_in", { p_min_lat: b.minLat, p_min_lng: b.minLng, p_max_lat: b.maxLat, p_max_lng: b.maxLng });
  fail(error);
  return (data ?? []) as ParkingSpot[];
}

/**
 * Parking spots around you (≈ 1.5 km), and around your destination while you're heading there; refreshed every 20 s
 * (spots change fast).
 */
export function useParking(me: LatLng | null, dest: LatLng | null) {
  const key = (p: LatLng | null) => (p ? `${p.lat.toFixed(2)},${p.lng.toFixed(2)}` : "-");
  const meKey = key(me), destKey = key(dest);
  const boxes = useMemo(() => {
    const out: Box[] = [];
    for (const k of [meKey, destKey]) {
      if (k === "-" || (k === destKey && k === meKey && out.length)) continue;
      const [lat, lng] = k.split(",").map(Number);
      out.push(boxAround([{ lat, lng }], 0.015)!);
    }
    return out;
  }, [meKey, destKey]);
  return useQuery({
    queryKey: ["parking", meKey, destKey],
    queryFn: async () => {
      const lists = await Promise.all(boxes.map(parkingIn));
      const seen = new Set<string>();
      return lists.flat().filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
    },
    enabled: boxes.length > 0,
    refetchInterval: 20_000,
    staleTime: 10_000,
  });
}

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LatLng } from "@/lib/nav/geo";
import type { PreparedRoute } from "@/lib/nav/route";
import { boxAround, roadKeys, roadReportsIn } from "./api";

/**
 * Road reports for the map: around you (≈ 2 km), or along your whole route while navigating (its box + ≈ 500 m; the
 * screen keeps only those on the route ahead for warnings). Refreshed every 30 s.
 */
export function useRoadReports(me: LatLng | null, route: PreparedRoute | null) {
  const lat = me ? me.lat.toFixed(2) : null;
  const lng = me ? me.lng.toFixed(2) : null;
  const box = useMemo(() => {
    if (route) return boxAround(route.pts.filter((_, i) => i % 20 === 0 || i === route.pts.length - 1), 0.005);
    return lat && lng ? boxAround([{ lat: +lat, lng: +lng }], 0.02) : null;
  }, [route, lat, lng]);
  return useQuery({
    queryKey: roadKeys.box(box),
    queryFn: () => roadReportsIn(box!),
    enabled: !!box,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

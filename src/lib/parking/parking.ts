import { haversine, type LatLng } from "@/lib/nav/geo";

/**
 * Parking (P7, the owner's idea): leaving a spot shows it green to others for 15 min; parking shows a red one for
 * 10 min (and turns a green one there red). Where *your* car is stays on this phone only — it lets the app ask
 * "did you free your spot?" when you drive off from it. Pure helpers (unit-tested); storage and server calls aside.
 */
export interface ParkingSpot extends LatLng {
  id: string;
  state: "free" | "taken";
  updated_at: string;
  expires_at: string;
  mine: boolean;
}

/** Where you parked (device only). */
export interface MyCar extends LatLng {
  at: number;
}

/** "Did you free your spot?": driving (> 4 m/s ≈ 15 km/h) 40–400 m from where you parked, within a day of parking. */
export const LEFT_MIN_M = 40;
export const LEFT_MAX_M = 400;
const DRIVING_MPS = 4;
const CAR_MAX_AGE_MS = 24 * 3_600_000;

export function droveOff(car: MyCar | null, fix: (LatLng & { speed?: number | null }) | null, now: number): boolean {
  if (!car || !fix || now - car.at > CAR_MAX_AGE_MS) return false;
  if ((fix.speed ?? 0) < DRIVING_MPS) return false;
  const d = haversine(car, fix);
  return d >= LEFT_MIN_M && d <= LEFT_MAX_M;
}

/** A car parked more than a day ago is forgotten (you'll have moved it, or don't need the reminder). */
export const carStale = (car: MyCar | null, now: number) => !car || now - car.at > CAR_MAX_AGE_MS;

/** Free spots (not your own) within `m` of a point, nearest first — near your destination while navigating. */
export function freeNear(spots: ParkingSpot[], at: LatLng, m = 300): { spot: ParkingSpot; distance: number }[] {
  return spots
    .filter((s) => s.state === "free" && !s.mine)
    .map((s) => ({ spot: s, distance: haversine(at, s) }))
    .filter((x) => x.distance <= m)
    .sort((a, b) => a.distance - b.distance);
}

const CAR_KEY = "mapapp:myCar";
export function readCar(): MyCar | null {
  try {
    const v = JSON.parse(localStorage.getItem(CAR_KEY) ?? "null") as MyCar | null;
    return v && typeof v.lat === "number" && typeof v.lng === "number" && typeof v.at === "number" ? v : null;
  } catch {
    return null;
  }
}
export function saveCar(car: MyCar | null) {
  try {
    if (car) localStorage.setItem(CAR_KEY, JSON.stringify(car));
    else localStorage.removeItem(CAR_KEY);
  } catch {
    // private mode: the reminder just won't come
  }
}

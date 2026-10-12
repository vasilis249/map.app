/** Small geometry for navigation: distances, bearings, projecting a point onto a route segment. */

export interface LatLng {
  lat: number;
  lng: number;
}

const R = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in metres. */
export function haversine(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing a → b, degrees from north (0–360). */
export function bearing(a: LatLng, b: LatLng): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest difference between two bearings (0–180). */
export function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** The point `m` metres from `a` towards bearing `brg` (good enough for the short distances of tests). */
export function offset(a: LatLng, m: number, brg: number): LatLng {
  const d = m / R;
  const lat1 = rad(a.lat);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(rad(brg)));
  const lng2 = rad(a.lng) + Math.atan2(Math.sin(rad(brg)) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: deg(lat2), lng: deg(lng2) };
}

/**
 * Project p onto the segment a–b (flat-earth around p: exact enough for the few hundred metres of one segment).
 * Returns the fraction along the segment (0–1), the projected point and its distance from p in metres.
 */
export function projectOnSegment(p: LatLng, a: LatLng, b: LatLng): { t: number; point: LatLng; dist: number } {
  const kx = Math.cos(rad(p.lat)) * 111_320;
  const ky = 110_574;
  const ax = (a.lng - p.lng) * kx, ay = (a.lat - p.lat) * ky;
  const bx = (b.lng - p.lng) * kx, by = (b.lat - p.lat) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  const x = ax + t * dx, y = ay + t * dy;
  return { t, point: { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t }, dist: Math.hypot(x, y) };
}

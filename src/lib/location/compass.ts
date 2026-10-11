/**
 * Which way the phone points (degrees from north), for the direction beam on your own map marker, like Find My /
 * Apple Maps. iOS: `webkitCompassHeading`, after a permission asked from a tap (`enableCompass` in a click handler).
 * Android: `deviceorientationabsolute`. Nothing leaves the phone.
 */

type OrientationEventWithCompass = DeviceOrientationEvent & { webkitCompassHeading?: number };
type PermissionApi = { requestPermission?: () => Promise<"granted" | "denied"> };

let heading: number | null = null;
let started = false;
let lastEmit = 0;
const listeners = new Set<(h: number | null) => void>();

function onOrientation(e: Event) {
  const o = e as OrientationEventWithCompass;
  let h: number | null = null;
  if (typeof o.webkitCompassHeading === "number" && o.webkitCompassHeading >= 0) h = o.webkitCompassHeading;
  else if (e.type === "deviceorientationabsolute" && typeof o.alpha === "number") h = (360 - o.alpha) % 360;
  if (h == null) return;
  const now = Date.now();
  if (heading != null && now - lastEmit < 100 && Math.abs(((h - heading + 540) % 360) - 180) < 3) return;
  heading = h;
  lastEmit = now;
  listeners.forEach((fn) => fn(h));
}

/** Start the compass. Call it inside a tap: iOS asks for motion permission then. Resolves whether it runs. */
export async function enableCompass(): Promise<boolean> {
  if (started) return true;
  if (typeof window === "undefined" || typeof DeviceOrientationEvent === "undefined") return false;
  const api = DeviceOrientationEvent as unknown as PermissionApi;
  if (typeof api.requestPermission === "function") {
    try {
      if ((await api.requestPermission()) !== "granted") return false;
    } catch {
      return false;
    }
  }
  started = true;
  const absolute = "ondeviceorientationabsolute" in window; // Android: true north
  window.addEventListener(absolute ? "deviceorientationabsolute" : "deviceorientation", onOrientation);
  return true;
}

export function compassHeading(): number | null {
  return heading;
}

export function onCompass(fn: (h: number | null) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

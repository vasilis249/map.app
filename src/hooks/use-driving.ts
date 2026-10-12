import { useEffect, useState } from "react";
import { localFix, onLocalFix, type LocalFix } from "@/lib/location/tracker";

/** Faster than this (m/s, 18 km/h) the phone is in a moving vehicle: no reading, one big button. */
const DRIVING_MPS = 5;
const FRESH_MS = 15_000;

const isDriving = (f: LocalFix | null) => !!f && f.speed != null && f.speed > DRIVING_MPS && Date.now() - f.at < FRESH_MS;

/**
 * True while this phone moves at driving speed (from the device's own fixes: the tracker while sharing, the map's
 * watch while it is open). Screens use it to hide anything that needs reading (lists, settings) and keep only the
 * big push-to-talk target. Falls back to false after 15 s without a fix.
 */
export function useDriving(): boolean {
  const [driving, setDriving] = useState(() => isDriving(localFix()));
  useEffect(() => {
    const off = onLocalFix((f) => setDriving(isDriving(f)));
    const t = setInterval(() => setDriving(isDriving(localFix())), 5_000);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);
  return driving;
}

import { BackgroundGeolocation, hasNativeLocation, localFix, onLocalFix, watchLocal, type LocalFix } from "@/lib/location/tracker";
import type { NavFix } from "./progress";

/**
 * Positions for navigation, also with the screen locked. In the iOS app: a separate native watcher WITH a background
 * message (Core Location keeps delivering in the background; iOS shows the blue location pill), alive only while
 * navigating. In a browser / an app build without the plugin: the map's foreground watch (`watchLocal`).
 * These positions stay on the phone: only the route requests (start + destination) go to our server and the provider.
 */
const fromLocal = (f: LocalFix): NavFix => ({ lat: f.lat, lng: f.lng, accuracy: f.accuracy, speed: f.speed, course: f.course, t: f.at });

export function watchNavigation(texts: { title: string; message: string }, onFix: (f: NavFix) => void): () => void {
  // Start from the position the map already has (a phone standing still may not report again for a while).
  const known = localFix();
  if (known && Date.now() - known.at < 30_000) queueMicrotask(() => onFix({ ...fromLocal(known), t: Date.now() }));
  if (hasNativeLocation()) {
    let id: string | null = null;
    let stopped = false;
    void BackgroundGeolocation.addWatcher(
      { backgroundTitle: texts.title, backgroundMessage: texts.message, requestPermissions: true, stale: false, distanceFilter: 3 },
      (p) => {
        if (!p) return;
        const moving = p.speed != null && p.speed > 1 && p.bearing != null && p.bearing >= 0;
        onFix({
          lat: p.latitude,
          lng: p.longitude,
          accuracy: p.accuracy,
          speed: p.speed != null && p.speed >= 0 ? p.speed : null,
          course: moving ? p.bearing : null,
          t: Date.now(),
        });
      },
    )
      .then((w) => {
        if (stopped) void BackgroundGeolocation.removeWatcher({ id: w }).catch(() => {});
        else id = w;
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
      if (id) void BackgroundGeolocation.removeWatcher({ id }).catch(() => {});
      id = null;
    };
  }
  const stop = watchLocal();
  const off = onLocalFix((f) => onFix(fromLocal(f)));
  return () => {
    off();
    stop();
  };
}

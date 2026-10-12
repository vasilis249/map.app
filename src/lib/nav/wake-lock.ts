import { Capacitor } from "@capacitor/core";
import { KeepAwake } from "@capacitor-community/keep-awake";

/**
 * Keep the screen on while navigating (like every navigation app). In the iOS app: the native keep-awake plugin
 * (idle timer off); in a browser: the Screen Wake Lock API, taken again when the page comes back (the browser drops
 * it whenever the page is hidden). The phone can still be locked by hand: guidance continues (background location +
 * audio, see nav-location.ts).
 */

let sentinel: WakeLockSentinel | null = null;
let wanted = false;
const native = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("KeepAwake");

async function take() {
  if (!wanted || sentinel || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
  try {
    sentinel = await navigator.wakeLock.request("screen");
    sentinel.addEventListener("release", () => (sentinel = null));
  } catch {
    // not allowed (no user gesture yet, battery saver): the screen just dims as usual
  }
}
const onVisible = () => {
  if (document.visibilityState === "visible") void take();
};

export function keepAwake(on: boolean) {
  if (on === wanted) return;
  wanted = on;
  if (native()) {
    void (on ? KeepAwake.keepAwake() : KeepAwake.allowSleep()).catch(() => undefined);
    return;
  }
  if (typeof document === "undefined") return;
  if (on) {
    document.addEventListener("visibilitychange", onVisible);
    void take();
  } else {
    document.removeEventListener("visibilitychange", onVisible);
    void sentinel?.release().catch(() => undefined);
    sentinel = null;
  }
}

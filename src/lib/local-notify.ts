// iOS local notifications (no APNs): "X is talking to you" while the app is in the background. Permission asked
// from a tap (turning a walkie channel on). No-ops outside the app.
import { isNativeApp } from "@/lib/native";

export type NotifyPermission = "granted" | "denied" | "prompt" | "unsupported";

/**
 * Wrapped: a Capacitor plugin proxy must never be the value of a promise — resolving it calls its `then`, which the
 * proxy forwards to the native side as a method call ("then() is not implemented"), so the await always failed
 * (kit LESSONS #16).
 */
async function plugin() {
  return { ln: (await import("@capacitor/local-notifications")).LocalNotifications };
}

export async function notifyPermission(): Promise<NotifyPermission> {
  if (!isNativeApp()) return "unsupported";
  const { display } = await (await plugin()).ln.checkPermissions();
  return display === "granted" ? "granted" : display === "denied" ? "denied" : "prompt";
}

/** Shows the iOS permission dialog (only the first time). */
export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (!isNativeApp()) return "unsupported";
  const { display } = await (await plugin()).ln.requestPermissions();
  return display === "granted" ? "granted" : display === "denied" ? "denied" : "prompt";
}

/** Tapping a local notification opens its route (extra.route). */
export async function onNotificationTap(open: (route: string) => void) {
  if (!isNativeApp()) return () => {};
  const handle = await (await plugin()).ln.addListener("localNotificationActionPerformed", (e) => {
    const route = (e.notification.extra as { route?: string } | undefined)?.route;
    if (route?.startsWith("/")) open(route);
  });
  return () => void handle.remove();
}

import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";
import { isNativeApp } from "@/lib/native";

/**
 * A short tap felt in the hand: light = taps, likes, tabs; medium = recording starts / stops; success = sent.
 * Native only when the app was built with the Haptics plugin (older builds skip it), else the web vibrate API
 * where it exists (Android browsers). Never throws.
 */
export function haptic(kind: "light" | "medium" | "success" = "light") {
  try {
    if (isNativeApp() && Capacitor.isPluginAvailable("Haptics")) {
      const done =
        kind === "success"
          ? Haptics.notification({ type: NotificationType.Success })
          : Haptics.impact({ style: kind === "medium" ? ImpactStyle.Medium : ImpactStyle.Light });
      void done.catch(() => undefined);
      return;
    }
    navigator.vibrate?.(kind === "medium" ? 18 : 8);
  } catch {
    // no haptics here
  }
}

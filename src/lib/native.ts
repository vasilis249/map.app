// Helpers for running inside the Capacitor iOS shell (see capacitor.config.ts).
// The shell loads this web app from its hosted URL, so every native code path
// is guarded by isNativeApp() and is a no-op in a normal browser or during SSR.
import { APP_SLUG } from "@/lib/brand";

/** Custom URL scheme registered in ios/App/App/Info.plist (CFBundleURLSchemes). */
export const APP_URL_SCHEME = APP_SLUG;

const HANDLED_LAUNCH_URL_KEY = `${APP_SLUG}:handledLaunchUrl`;

type CapacitorGlobal = { isNativePlatform?: () => boolean };

export function isNativeApp(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  return !!cap?.isNativePlatform?.();
}

/**
 * Where Supabase auth emails send the user back to. Inside the app this is a
 * deep link (<scheme>://app/<path>) so the email link reopens the app instead
 * of Safari. Must be listed in Supabase → Auth → URL Configuration → Redirect URLs.
 */
export function authRedirectUrl(path: string): string {
  return isNativeApp() ? `${APP_URL_SCHEME}://app${path}` : `${window.location.origin}${path}`;
}

/** <scheme>://app/<path>?<query>#<hash> → the same path on the hosted origin. */
function deepLinkToWebUrl(url: string): string | null {
  if (!url.startsWith(`${APP_URL_SCHEME}://`)) return null;
  try {
    const u = new URL(url);
    return `${window.location.origin}${u.pathname || "/"}${u.search}${u.hash}`;
  } catch {
    return null;
  }
}

let initialized = false;

/** Call once on the client after the app mounts. */
export async function initNativeShell(): Promise<void> {
  if (initialized || !isNativeApp()) return;
  initialized = true;
  document.documentElement.classList.add("native-app");

  const [{ App }, { SplashScreen }] = await Promise.all([
    import("@capacitor/app"),
    import("@capacitor/splash-screen"),
  ]);

  const openDeepLink = (url: string | undefined) => {
    const target = url ? deepLinkToWebUrl(url) : null;
    if (!target) return;
    // Social sign-in comes back from the Safari sheet opened by signInWithProvider(); close it.
    void import("@capacitor/browser").then(({ Browser }) => Browser.close()).catch(() => {});
    window.location.assign(target);
  };

  // App already running: iOS delivers the link as an event.
  await App.addListener("appUrlOpen", (event) => openDeepLink(event.url));

  // Cold start from a link. The launch URL stays the same for the whole app
  // session, so remember it — otherwise every page load would re-open it.
  try {
    const launch = await App.getLaunchUrl();
    if (launch?.url && sessionStorage.getItem(HANDLED_LAUNCH_URL_KEY) !== launch.url) {
      sessionStorage.setItem(HANDLED_LAUNCH_URL_KEY, launch.url);
      openDeepLink(launch.url);
    }
  } catch {
    // No launch URL.
  }

  await SplashScreen.hide();
}

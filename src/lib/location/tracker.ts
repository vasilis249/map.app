import { Capacitor, registerPlugin } from "@capacitor/core";
import { isNativeApp } from "@/lib/native";
import { sendPosition } from "./api";

/**
 * Keeps the server's copy of your position fresh and precise while sharing is on (like Find My).
 * In the iOS app: @capacitor-community/background-geolocation (Core Location "best" accuracy, never paused; Always
 * permission → updates keep coming with the app closed; iOS shows the blue location indicator). On the web:
 * watchPosition with high accuracy, only while the page is open.
 * Sent when you really moved (more than the fix's own error, at least 8 m), when a fix is clearly more precise than
 * the last one sent, every 30 s while you drift a little, and once a minute as a heartbeat while you stand still
 * (iOS sends nothing then), so friends see "now" instead of an old time. Never more than one every 3 s — every 1 s
 * while driving (speed > 18 km/h). A much
 * worse fix right after a good one (a jump to a Wi-Fi/cell estimate) is ignored.
 *
 * Separately, the map shows where you are right now straight from the device (`watchLocal`), whether you share or
 * not; that position never leaves the phone unless sharing is on.
 */

interface BgLocation {
  latitude: number;
  longitude: number;
  accuracy: number;
  bearing: number | null;
  speed: number | null;
}
interface BgError {
  code?: string;
  message: string;
}
interface BackgroundGeolocationPlugin {
  addWatcher(
    options: { backgroundMessage?: string; backgroundTitle?: string; requestPermissions?: boolean; stale?: boolean; distanceFilter?: number },
    callback: (position?: BgLocation, error?: BgError) => void,
  ): Promise<string>;
  removeWatcher(options: { id: string }): Promise<void>;
  openSettings(): Promise<void>;
}
const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>("BackgroundGeolocation");

/**
 * The app's native location plugin is there. An iPhone app built before the plugin was added (the web part updates
 * by itself, the native part only with a new Xcode build) doesn't have it: then location comes from the web view's
 * own geolocation, foreground only.
 */
export function hasNativeLocation(): boolean {
  return isNativeApp() && Capacitor.isPluginAvailable("BackgroundGeolocation");
}

export type TrackerStatus = "idle" | "running" | "denied" | "unavailable";

let status: TrackerStatus = "idle";
let nativeWatcher: string | null = null;
let webWatcher: number | null = null;
const listeners = new Set<(s: TrackerStatus) => void>();

interface Fix {
  lat: number;
  lng: number;
  accuracy?: number | null;
  heading?: number | null;
  speed?: number | null;
}
/** What the server last got from us, and the newest fix (the heartbeat re-sends it). */
let last: { lat: number; lng: number; acc: number | null; at: number } | null = null;
let latest: Fix | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
const HEARTBEAT_MS = 60_000;

/** Above this error (m) the position is only approximate: iOS "Precise Location" off, or no GPS. */
export const APPROXIMATE_M = 500;

/** Your position on this device (for your own dot on the map). */
export interface LocalFix {
  lat: number;
  lng: number;
  accuracy: number | null;
  /** Direction of travel (degrees from north) while moving, else null. */
  course: number | null;
  /** Speed in m/s when the device reports one, else null (driving-safe UI, navigation). */
  speed: number | null;
  at: number;
}
let fix: LocalFix | null = null;
const fixListeners = new Set<(f: LocalFix) => void>();

/** A much worse fix right after a good one is noise (a jump to a Wi-Fi / cell estimate). */
function isJump(prev: { acc: number | null; at: number } | null, acc: number | null | undefined, now: number) {
  return !!prev && prev.acc != null && acc != null && acc > 50 && acc > prev.acc * 3 && now - prev.at < 60_000;
}

function emitFix(p: Fix) {
  const now = Date.now();
  if (isJump(fix && { acc: fix.accuracy, at: fix.at }, p.accuracy, now)) return;
  const moving = p.speed != null && p.speed > 1 && p.heading != null && p.heading >= 0;
  fix = { lat: p.lat, lng: p.lng, accuracy: p.accuracy ?? null, course: moving ? p.heading! : null, speed: p.speed != null && p.speed >= 0 ? p.speed : null, at: now };
  fixListeners.forEach((fn) => fn(fix!));
}

function setStatus(s: TrackerStatus) {
  status = s;
  listeners.forEach((fn) => fn(s));
}

/** Great-circle distance in metres. */
export function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = (d: number) => (d * Math.PI) / 180;
  const x = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(x)));
}

/** Faster than this (m/s, 18 km/h) = driving or riding: send about every second (15–25 m apart at road speeds). */
const FAST_MPS = 5;

function shouldSend(p: Fix, now: number): boolean {
  if (!last) return true;
  const age = now - last.at;
  // The server stores about one a second. Driving needs that (people 200 m away pass in seconds); walking or
  // standing, one every 3 s is plenty and saves battery.
  const fast = p.speed != null && p.speed > FAST_MPS;
  if (age < (fast ? 1_000 : 3_000)) return false;
  if (isJump(last, p.accuracy, now)) return false;
  const acc = p.accuracy ?? 30;
  if (last.acc != null && acc < last.acc * 0.6) return true; // clearly more precise than what friends see
  const moved = metres(last, p);
  if (moved >= Math.max(8, Math.min(acc, 50))) return true; // moved more than the fix's own error
  return age >= 30_000 && moved >= 3;
}

function push(p: Fix) {
  last = { lat: p.lat, lng: p.lng, acc: p.accuracy ?? null, at: Date.now() };
  sendPosition({
    lat: p.lat,
    lng: p.lng,
    accuracy: p.accuracy,
    heading: p.heading != null && p.heading >= 0 ? p.heading : null,
    speed: p.speed != null && p.speed >= 0 ? p.speed : null,
  }).catch(() => {
    last = null; // try again with the next update
  });
}

function report(p: Fix) {
  latest = p;
  if (shouldSend(p, Date.now())) push(p);
}

export function trackerStatus() {
  return status;
}

export function onTrackerStatus(fn: (s: TrackerStatus) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Start sending your position (asks for permission the first time). */
export async function startTracking(texts: { title: string; message: string }) {
  if (status === "running") return;
  // The map may already know where you are (its own watch started first): share that at once instead of waiting
  // for the next fix, which a phone standing still may not send for a while.
  if (fix && Date.now() - fix.at < 60_000) report({ lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy });
  if (hasNativeLocation()) {
    try {
      nativeWatcher = await BackgroundGeolocation.addWatcher(
        { backgroundTitle: texts.title, backgroundMessage: texts.message, requestPermissions: true, stale: false, distanceFilter: 5 },
        (position, error) => {
          if (error) {
            if (error.code === "NOT_AUTHORIZED") setStatus("denied");
            return;
          }
          if (!position) return;
          if (status !== "running") setStatus("running");
          const p = { lat: position.latitude, lng: position.longitude, accuracy: position.accuracy, heading: position.bearing, speed: position.speed };
          emitFix(p);
          report(p);
        },
      );
      setStatus("running");
      startHeartbeat();
    } catch {
      setStatus("unavailable");
    }
    return;
  }
  if (typeof navigator === "undefined" || !navigator.geolocation) return setStatus("unavailable");
  webWatcher = navigator.geolocation.watchPosition(
    (pos) => {
      if (status !== "running") setStatus("running");
      const p = fromCoords(pos.coords);
      emitFix(p);
      report(p);
    },
    (err) => setStatus(err.code === err.PERMISSION_DENIED ? "denied" : "unavailable"),
    { enableHighAccuracy: true, maximumAge: 0 },
  );
  setStatus("running");
  startHeartbeat();
}

function fromCoords(c: GeolocationCoordinates): Fix {
  return { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, heading: c.heading, speed: c.speed };
}

/** Standing still sends nothing (iOS gives no new fixes): re-send the newest fix once a minute while we run. */
function startHeartbeat() {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    if (status === "running" && latest && (!last || Date.now() - last.at >= HEARTBEAT_MS - 1_000)) push(latest);
  }, 15_000);
}

export async function stopTracking() {
  if (nativeWatcher) {
    const id = nativeWatcher;
    nativeWatcher = null;
    await BackgroundGeolocation.removeWatcher({ id }).catch(() => {});
  }
  if (webWatcher !== null) {
    navigator.geolocation.clearWatch(webWatcher);
    webWatcher = null;
  }
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  last = null;
  latest = null;
  setStatus("idle");
}

/** iOS: open the app's page in Settings (to switch location to "Always"). */
export function openLocationSettings() {
  if (!isNativeApp()) return;
  const viaUrl = () => {
    window.location.href = "app-settings:"; // iOS Settings → the app (UIApplication.openSettingsURLString)
  };
  if (hasNativeLocation()) void BackgroundGeolocation.openSettings().catch(viaUrl);
  else viaUrl();
}

/** Latest position of this device (may be a few seconds old), or null. */
export function localFix(): LocalFix | null {
  return fix;
}

export function onLocalFix(fn: (f: LocalFix) => void): () => void {
  fixListeners.add(fn);
  return () => void fixListeners.delete(fn);
}

function onLocal(p: Fix) {
  emitFix(p);
  if (status === "running") report(p);
}

let localUsers = 0;
let localNative: string | null = null;
let localWeb: number | null = null;

let localFallback: ReturnType<typeof setTimeout> | null = null;
const localProblems = new Set<(p: LocalProblem) => void>();

/** Why there is no position: permission refused, or no location service at all. */
export type LocalProblem = "denied" | "unavailable";

function problem(p: LocalProblem) {
  localProblems.forEach((fn) => fn(p));
}

function startWebLocal() {
  if (localWeb !== null) return;
  if (typeof navigator === "undefined" || !navigator.geolocation) return problem("unavailable");
  localWeb = navigator.geolocation.watchPosition(
    (pos) => onLocal(fromCoords(pos.coords)),
    (err) => {
      if (err.code === err.PERMISSION_DENIED) problem("denied");
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
  );
}

function startNativeLocal() {
  void BackgroundGeolocation.addWatcher({ requestPermissions: true, stale: false, distanceFilter: 5 }, (position, error) => {
    if (error) {
      if (error.code === "NOT_AUTHORIZED") problem("denied");
      else startWebLocal(); // anything else from the plugin: let the web view try
      return;
    }
    if (position) onLocal({ lat: position.latitude, lng: position.longitude, accuracy: position.accuracy, heading: position.bearing, speed: position.speed });
  })
    .then((id) => {
      if (localUsers > 0) localNative = id;
      else void BackgroundGeolocation.removeWatcher({ id }).catch(() => {});
    })
    .catch(() => startWebLocal());
}

/**
 * Follow your position while a screen needs it (the map), foreground only. Returns the stop. Nothing is sent
 * because of it — except that while sharing is on, these extra fixes also keep the shared position precise.
 * In the app the native plugin answers; if it is missing (older app build), fails, or gives nothing within 8 s, the
 * web view's own geolocation takes over too. onProblem: permission refused / no location at all.
 */
export function watchLocal(onProblem?: (p: LocalProblem) => void): () => void {
  if (onProblem) localProblems.add(onProblem);
  localUsers++;
  if (localUsers === 1) {
    if (hasNativeLocation()) {
      startNativeLocal();
      const since = Date.now();
      localFallback = setTimeout(() => {
        localFallback = null;
        if (localUsers > 0 && (!fix || fix.at < since)) startWebLocal();
      }, 8_000);
    } else startWebLocal();
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (onProblem) localProblems.delete(onProblem);
    localUsers--;
    if (localUsers > 0) return;
    if (localFallback) clearTimeout(localFallback);
    localFallback = null;
    if (localNative) {
      const id = localNative;
      localNative = null;
      void BackgroundGeolocation.removeWatcher({ id }).catch(() => {});
    }
    if (localWeb !== null) {
      navigator.geolocation.clearWatch(localWeb);
      localWeb = null;
    }
  };
}

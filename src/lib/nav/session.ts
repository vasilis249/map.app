import { useSyncExternalStore } from "react";
import { walkieHub } from "@/lib/walkie/hub";
import { fetchRoutes, NavApiError, type NavError } from "./api";
import type { LatLng } from "./geo";
import { bearing as bearingOf, haversine } from "./geo";
import { createMotion, type Motion } from "./motion";
import { createNavigator } from "./navigator";
import { watchNavigation } from "./nav-location";
import type { NavFix, NavProgress } from "./progress";
import type { NavRoute, Place, PreparedRoute } from "./route";
import { speechEngine, unlockSpeech } from "./speech";
import { createSpeechQueue } from "./speech-queue";
import { keepAwake } from "./wake-lock";

/**
 * The trip in progress, kept outside any screen: guidance goes on while you switch to the walkie tab (or lock the
 * phone in the app). The map screen draws it; this module talks to the server, the location watcher, the voice.
 */

export type NavPhase = "idle" | "loading" | "preview" | "navigating" | "arrived";

export interface NavState {
  phase: NavPhase;
  dest: Place | null;
  /** Route choices (preview). */
  routes: NavRoute[];
  chosen: number;
  error: NavError | null;
  /** While navigating. */
  route: PreparedRoute | null;
  progress: NavProgress | null;
  rerouting: boolean;
  muted: boolean;
  /** Last fix used (the camera follows it). */
  fix: NavFix | null;
  /** Smooth motion for the map (60 fps arrow and camera between fixes). */
  motion: Motion | null;
  /** Current speed, km/h (from the device, else from the last two fixes). */
  speedKmh: number | null;
}

export interface NavTexts {
  phrase: (metres: number, instruction: string) => string;
  rerouted: string;
  bgTitle: string;
  bgMessage: string;
}

const MUTE_KEY = "mapapp:navMuted";
const readMuted = () => {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
};

const IDLE: NavState = { phase: "idle", dest: null, routes: [], chosen: 0, error: null, route: null, progress: null, rerouting: false, muted: false, fix: null, motion: null, speedKmh: null };
let state: NavState = IDLE;
const listeners = new Set<() => void>();
function set(patch: Partial<NavState>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}

export function useNav(): NavState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => state,
    () => IDLE,
  );
}
export const navState = () => state;

/** Someone is talking (you on air or opening the mic, or a voice arriving): guidance waits. */
const anyoneTalking = () => walkieHub.peers().some(({ snap }) => snap.talking || snap.starting || snap.waiting || snap.peerTalking);

let planSeq = 0;
let stopTrip: (() => void) | null = null;
let silence: (() => void) | null = null;

/** Routes from where you are to a place (the preview with choices). */
export async function planTo(dest: Place, from: LatLng, lang: string) {
  const seq = ++planSeq;
  set({ phase: "loading", dest, routes: [], chosen: 0, error: null });
  try {
    const routes = await fetchRoutes(from, dest, lang);
    if (seq === planSeq) set({ phase: "preview", routes });
  } catch (e) {
    if (seq === planSeq) set({ phase: "preview", routes: [], error: e instanceof NavApiError ? e.code : "unavailable" });
  }
}

export function chooseRoute(i: number) {
  if (state.phase === "preview" && i >= 0 && i < state.routes.length) set({ chosen: i });
}

/** Start guidance on the chosen route. Call inside the tap (the browser's voice needs it). */
export function startNav(texts: NavTexts, lang: string) {
  const route = state.routes[state.chosen];
  const dest = state.dest;
  if (state.phase !== "preview" || !route || !dest) return;
  stopTrip?.();
  unlockSpeech();
  keepAwake(true);
  const nav = createNavigator(route, { phrase: texts.phrase, reroutedText: texts.rerouted });
  const voice = createSpeechQueue(speechEngine(lang));
  voice.setTalking(anyoneTalking());
  const offTalk = walkieHub.subscribe(() => voice.setTalking(anyoneTalking()));
  let ended = false;
  /** Which route an announcement was about (a waiting "turn left" of the old route is dropped after a reroute). */
  let generation = 0;
  silence = () => voice.clear();
  let arrivedTimer: ReturnType<typeof setTimeout> | null = null;

  const motion = createMotion();
  let prev: NavFix | null = null;
  const onFix = (raw: NavFix) => {
    if (ended) return;
    const fix = withMotion(raw, prev);
    // (a repeat of the same fix a moment later must not become the base for the next speed)
    if (!prev || fix.t - prev.t >= 400) prev = fix;
    const u = nav.update(fix);
    const p = u.progress;
    if (u.say && !state.muted) {
      const k = parseInt(u.say.key, 10);
      const gen = generation;
      // "Turn left" for a turn already behind you, or on a route you've left, is worse than nothing (the banner
      // shows what's next anyway).
      const ahead = Number.isNaN(k) || u.say.key.endsWith(":post") ? () => true : () => (state.progress?.step ?? 0) < k || !!state.progress?.arrived;
      voice.say({ ...u.say, still: () => gen === generation && ahead() });
    }
    if (u.reroute) {
      set({ rerouting: true });
      fetchRoutes({ lat: fix.lat, lng: fix.lng, heading: fix.course }, dest, lang, false)
        .then((r) => {
          if (ended) return;
          nav.rerouted(r[0] ?? null);
          if (r[0]) generation++;
          set({ route: nav.route, rerouting: false });
        })
        .catch(() => {
          nav.rerouted(null);
          if (!ended) set({ rerouting: false });
        });
    }
    motion.update({
      route: nav.route,
      along: p.along,
      onRoute: !p.offRoute,
      lat: fix.lat,
      lng: fix.lng,
      course: fix.course ?? null,
      speed: fix.speed ?? 0,
      toNext: p.toNext,
      t: fix.t,
    });
    set({ progress: p, fix, route: nav.route, speedKmh: kmh(fix.speed) });
    if (p.arrived && state.phase === "navigating") {
      set({ phase: "arrived" });
      // The trip ends by itself a little after arriving (or with "Τέλος").
      arrivedTimer = setTimeout(stopNav, 120_000);
    }
  };

  // No fix for a few seconds = standing still (iPhones send nothing then): the speedometer drops to 0.
  const idle = setInterval(() => {
    if (prev && Date.now() - prev.t > 3_000 && state.speedKmh) set({ speedKmh: 0 });
  }, 1_000);
  const stopWatch = watchNavigation({ title: texts.bgTitle, message: texts.bgMessage }, onFix);
  stopTrip = () => {
    ended = true;
    stopWatch();
    clearInterval(idle);
    offTalk();
    voice.clear();
    keepAwake(false);
    if (arrivedTimer) clearTimeout(arrivedTimer);
    silence = null;
  };
  set({ phase: "navigating", route: nav.route, progress: null, rerouting: false, error: null, muted: readMuted(), fix: null, motion, speedKmh: null });
}

export function stopNav() {
  planSeq++;
  stopTrip?.();
  stopTrip = null;
  set(IDLE);
}

export function setMuted(muted: boolean) {
  try {
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    // private mode: only for this trip
  }
  if (muted) silence?.();
  set({ muted });
}

/**
 * Speed and direction when the device doesn't give them (browsers, some fixes): from the previous fix, if it is recent
 * and both are precise enough. Smoothed a little so a speedometer doesn't flicker.
 */
function withMotion(f: NavFix, prev: NavFix | null): NavFix {
  if (f.speed != null && f.course != null) return f;
  if (!prev) return { ...f, speed: f.speed ?? null };
  const dt = (f.t - prev.t) / 1000;
  // Too soon after the previous one (browsers repeat a fix) or too imprecise to tell: keep the last speed / direction.
  if (dt < 0.4) return { ...f, speed: f.speed ?? prev.speed ?? null, course: f.course ?? prev.course ?? null };
  const good = dt <= 6 && (f.accuracy ?? 10) <= 50 && (prev.accuracy ?? 10) <= 50;
  if (!good) return f;
  const d = haversine(prev, f);
  const raw = d / dt;
  const speed = f.speed ?? (prev.speed != null ? prev.speed * 0.4 + raw * 0.6 : raw);
  const course = f.course ?? (d > 3 && speed > 1 ? bearingOf(prev, f) : null);
  return { ...f, speed, course };
}

/** km/h for the speedometer: GPS noise while standing still reads 0, like a car's dial. */
function kmh(mps: number | null | undefined): number | null {
  if (mps == null) return null;
  const v = mps * 3.6;
  return v < 3 ? 0 : Math.round(v);
}

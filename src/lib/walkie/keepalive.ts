import { APP_SLUG } from "@/lib/brand";
import { isNativeApp } from "@/lib/native";

/**
 * Experimental, opt-in (app only): keep listening with the screen off. iOS suspends the app soon after it goes to
 * the background unless it is playing audio (Info.plist has UIBackgroundModes audio), so while you have open walkie
 * channels a silent loop plays in the background. It can stop other apps' music and costs battery, hence off by
 * default. No guarantees: iOS may still suspend the web view.
 */

const PREF_KEY = `${APP_SLUG}:walkieBackground`;
let el: HTMLAudioElement | null = null;

export function backgroundWanted(): boolean {
  if (!isNativeApp()) return false;
  try {
    return localStorage.getItem(PREF_KEY) === "on";
  } catch {
    return false;
  }
}

export function setBackgroundWanted(on: boolean) {
  try {
    localStorage.setItem(PREF_KEY, on ? "on" : "off");
  } catch {
    /* ignore */
  }
  if (on) arm();
  else stop();
}

/** One second of silence (8 kHz, 8-bit mono WAV). */
function silentWav(): string {
  const n = 8000;
  const b = new Uint8Array(44 + n);
  const v = new DataView(b.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  str(36, "data");
  v.setUint32(40, n, true);
  b.fill(128, 44);
  return URL.createObjectURL(new Blob([b], { type: "audio/wav" }));
}

function element(): HTMLAudioElement {
  if (!el) {
    el = new Audio(silentWav());
    el.loop = true;
    el.setAttribute("playsinline", "");
  }
  return el;
}

/** Inside a tap: iOS lets an element play later from script only once a gesture has played it. */
export function arm() {
  if (!backgroundWanted()) return;
  const a = element();
  void a
    .play()
    .then(() => {
      if (document.visibilityState === "visible") a.pause();
    })
    .catch(() => {});
}

/** Going to the background with open channels: start the loop; coming back: stop it. */
export function onVisibility(hasChannels: boolean) {
  if (!backgroundWanted() || !el) return;
  if (document.visibilityState === "hidden" && hasChannels) void el.play().catch(() => {});
  else el.pause();
}

function stop() {
  el?.pause();
}

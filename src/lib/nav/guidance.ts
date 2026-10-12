import type { NavProgress } from "./progress";
import type { PreparedRoute } from "./route";

/**
 * What to say and when. Every maneuver gets at most three announcements, each once:
 *   far  — "In 400 m, turn left onto …" (about 30 s ahead; skipped when the previous turn is too close)
 *   near — the provider's pre-transition text, about 8 s ahead ("Turn left onto …. Then turn right …")
 *   post — right after a maneuver, when the next one is far ("Continue for 2 km.")
 * Distances grow with speed, so a driver on a highway hears it in time and a walker isn't told 300 m early.
 */

export interface Utterance {
  /** `<maneuver>:<far|near|post>`, or "start" / "rerouted". */
  key: string;
  text: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Speed unknown (no fix yet, or the device doesn't report it): assume city driving, 50 km/h. */
const DEFAULT_MPS = 13.9;
export const nearDistance = (mps: number | null | undefined) => clamp((mps ?? DEFAULT_MPS) * 8 + 20, 50, 300);
export const farDistance = (mps: number | null | undefined) => clamp((mps ?? DEFAULT_MPS) * 30, 300, 1500);

/** A distance as people say it: 50 m steps below 200 m, 100 m below 1 km, then half kilometres. */
export function spokenMetres(m: number): number {
  if (m < 200) return Math.max(50, Math.round(m / 50) * 50);
  if (m < 1000) return Math.round(m / 100) * 100;
  return Math.round(m / 500) * 500;
}

export interface AnnouncerOptions {
  /** "In {distance}, {instruction}" in the app's language (distance already rounded by spokenMetres). */
  phrase: (metres: number, instruction: string) => string;
  /** First words: the depart instruction (a new trip), or this text (a new route after leaving the old one). */
  rerouted?: string;
}

export function createAnnouncer(r: PreparedRoute, opts: AnnouncerOptions) {
  const said = new Set<string>();
  /** Maneuvers named as "Then …" by an earlier announcement → how far ahead they were then (metres). */
  const cued = new Map<number, number>();
  const cue = (k: number, along: number) => {
    if (m[k].cuesNext && k + 1 < m.length) cued.set(k + 1, r.at[k + 1] - along);
  };
  const m = r.route.maneuvers;
  const last = m.length - 1;
  const once = (key: string, text: string | null | undefined): Utterance | null => {
    if (!text || said.has(key)) return null;
    said.add(key);
    return { key, text };
  };

  function next(p: NavProgress, mps: number | null | undefined): Utterance | null {
    if (p.offRoute) return null;
    if (!said.has("start")) {
      said.add("start");
      if (opts.rerouted) return { key: "rerouted", text: opts.rerouted };
      // The depart text already names the first turn when it is close ("…Then turn left onto …").
      cue(0, p.along);
      return { key: "start", text: m[0].pre ?? m[0].instruction };
    }
    if (p.arrived) return once(`${last}:near`, m[last].pre ?? m[last].instruction);
    const near = nearDistance(mps);
    const far = farDistance(mps);
    const k = p.next;
    if (k > p.step) {
      if (p.toNext <= near) {
        said.add(`${k}:far`);
        // Already named as "…Then turn left" from within this distance: that was its announcement. (Named from
        // further away, it is said again here as a reminder.)
        if ((cued.get(k) ?? Infinity) <= near) said.add(`${k}:near`);
        const u = once(`${k}:near`, m[k].pre ?? m[k].instruction);
        if (u) cue(k, p.along);
        return u;
      }
      const stretch = r.at[k] - r.at[p.step];
      if (p.toNext <= far && p.toNext > near + 30 && stretch > near + 80)
        return once(`${k}:far`, opts.phrase(spokenMetres(p.toNext), lowerFirst(m[k].alert ?? m[k].instruction)));
      // Just past a maneuver with a long way to the next one: "Continue for 2 km."
      if (p.step > 0 && p.along - r.at[p.step] < 150 && p.toNext > far + 200) return once(`${p.step}:post`, m[p.step].post);
    }
    return null;
  }

  return { next };
}

/** "Στρίψτε αριστερά…" → "στρίψτε αριστερά…" (it follows "Σε 400 μέτρα, "). */
export function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLocaleLowerCase() + s.slice(1) : s;
}

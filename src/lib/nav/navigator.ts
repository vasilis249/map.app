import { createAnnouncer, type AnnouncerOptions, type Utterance } from "./guidance";
import { createProgress, type NavFix, type NavProgress } from "./progress";
import { prepareRoute, type NavRoute, type PreparedRoute } from "./route";

/** Ask for a new route at most this often (a reroute that fails or lands off-route again waits). */
export const REROUTE_GAP_MS = 10_000;

export interface NavUpdate {
  progress: NavProgress;
  /** Say this now (or once nobody is talking). */
  say: Utterance | null;
  /** Time to ask the provider for a new route from where you are. */
  reroute: boolean;
}

/**
 * One trip: the route being followed, where you are on it, what to say, and when to ask for a new route.
 * Pure (no timers, no I/O): the screen feeds it fixes and acts on what it returns.
 */
export function createNavigator(route: NavRoute, opts: AnnouncerOptions & { reroutedText: string }) {
  let prepared: PreparedRoute = prepareRoute(route);
  let progress = createProgress(prepared);
  let announcer = createAnnouncer(prepared, { phrase: opts.phrase });
  let lastReroute = -Infinity;
  let rerouting = false;

  return {
    get route() {
      return prepared;
    },
    update(fix: NavFix): NavUpdate {
      const p = progress.update(fix);
      const reroute = p.offRoute && !p.arrived && !rerouting && fix.t - lastReroute >= REROUTE_GAP_MS;
      if (reroute) {
        rerouting = true;
        lastReroute = fix.t;
      }
      return { progress: p, say: announcer.next(p, fix.speed), reroute };
    },
    /** The new route arrived (null: the request failed — try again after the gap). */
    rerouted(next: NavRoute | null) {
      rerouting = false;
      if (!next) return;
      prepared = prepareRoute(next);
      progress = createProgress(prepared);
      announcer = createAnnouncer(prepared, { phrase: opts.phrase, rerouted: opts.reroutedText });
    },
  };
}

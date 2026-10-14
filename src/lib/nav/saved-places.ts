import { haversine } from "./geo";
import type { Place } from "./route";

/**
 * Home, Work and recent destinations (Waze's shortcuts). Kept only on this device — where you live and work never goes
 * to our server; a trip to one of them sends the route request like any other.
 */
export interface SavedPlaces {
  home: Place | null;
  work: Place | null;
  /** Newest first. */
  recent: Place[];
}

const KEY = "mapapp:places";
export const MAX_RECENT = 8;
/** Two destinations this close are the same place (a café picked twice from slightly different results). */
const SAME_M = 30;

const isPlace = (v: unknown): v is Place => {
  const p = v as Place | null;
  return !!p && typeof p.name === "string" && typeof p.lat === "number" && typeof p.lng === "number" && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
};

export function readSaved(): SavedPlaces {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<SavedPlaces>;
    return {
      home: isPlace(v.home) ? v.home : null,
      work: isPlace(v.work) ? v.work : null,
      recent: Array.isArray(v.recent) ? v.recent.filter(isPlace).slice(0, MAX_RECENT) : [],
    };
  } catch {
    return { home: null, work: null, recent: [] };
  }
}

function write(s: SavedPlaces) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // private mode / full: shortcuts just aren't kept
  }
}

/** The list with `p` first; the same place further down (same id, or within 30 m) is dropped; at most 8. */
export function withRecent(list: Place[], p: Place): Place[] {
  const same = (o: Place) => o.id === p.id || haversine(o, p) <= SAME_M;
  return [p, ...list.filter((o) => !same(o))].slice(0, MAX_RECENT);
}

export function addRecent(p: Place) {
  const s = readSaved();
  write({ ...s, recent: withRecent(s.recent, p) });
}

export function setShortcut(which: "home" | "work", p: Place | null) {
  write({ ...readSaved(), [which]: p });
}

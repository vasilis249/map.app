import { supabase } from "@/integrations/supabase/client";
import { walkieHub } from "@/lib/walkie/hub";
import type { WalkieItem } from "@/lib/walkie/history";

/**
 * Push to talk on the map. Pressing knocks first (the server checks you may talk to them and tells their phone);
 * both phones then keep the pair channel open for a few minutes so the other one can answer. At most a handful of
 * such conversations stay open at once (each is a Realtime channel).
 */

const HOLD_MS = 3 * 60_000;
const MAX_OPEN = 6;

/** Who knocked you (from the knock) or whom you talked to (from the map): name and photo for the banner. */
export interface NearbyPerson {
  user_id: string;
  username: string;
  full_name: string;
  avatar_path: string | null;
  distance_m: number | null;
}

interface Hold {
  release: () => void;
  timer: ReturnType<typeof setTimeout> | null;
  since: number;
}

const holds = new Map<string, Hold>();
const people = new Map<string, NearbyPerson>();

export const nearbyKeys = {
  history: (peer: string) => ["nearby", "history", peer] as const,
};

export function rememberNearby(p: NearbyPerson) {
  people.set(p.user_id, p);
}

export function nearbyPerson(id: string): NearbyPerson | undefined {
  return people.get(id);
}

/** Keep the conversation with this person open for a few more minutes (after a knock either way). */
export function holdNearby(peer: string) {
  let h = holds.get(peer);
  if (!h) {
    const got = walkieHub.acquire(peer, "nearby");
    if (!got) return;
    h = { release: got.release, timer: null, since: Date.now() };
    holds.set(peer, h);
    if (holds.size > MAX_OPEN) {
      // The oldest quiet one goes.
      const quiet = new Set(walkieHub.peers().filter((p) => p.kind === "nearby" && !p.snap.talking && !p.snap.peerTalking).map((p) => p.peer));
      const oldest = [...holds.entries()].filter(([id]) => id !== peer && quiet.has(id)).sort((a, b) => a[1].since - b[1].since)[0];
      if (oldest) dropHold(oldest[0]);
    }
  }
  if (h.timer) clearTimeout(h.timer);
  h.since = Date.now();
  h.timer = setTimeout(() => expire(peer), HOLD_MS);
}

function expire(peer: string) {
  const busy = walkieHub.peers().some((p) => p.kind === "nearby" && p.peer === peer && (p.snap.talking || p.snap.peerTalking || p.snap.waiting));
  if (busy) {
    const h = holds.get(peer);
    if (h) h.timer = setTimeout(() => expire(peer), 30_000);
    return;
  }
  dropHold(peer);
}

function dropHold(peer: string) {
  const h = holds.get(peer);
  if (!h) return;
  if (h.timer) clearTimeout(h.timer);
  holds.delete(peer);
  h.release();
}

/** Blocked from the map: close that conversation and forget their knock. */
export function forgetNearby(peer: string) {
  dropHold(peer);
  people.delete(peer);
}

/** Sign-out / sharing off: close every map conversation. */
export function releaseAllNearby() {
  for (const peer of [...holds.keys()]) dropHold(peer);
}

/** Someone knocked you: open the channel so you hear them live. */
export function onKnock(payload: unknown) {
  const p = payload as Partial<NearbyPerson> & { from?: string };
  if (!p?.from || typeof p.from !== "string") return;
  rememberNearby({
    user_id: p.from,
    username: p.username ?? "",
    full_name: p.full_name ?? "",
    avatar_path: p.avatar_path ?? null,
    distance_m: typeof p.distance_m === "number" ? p.distance_m : null,
  });
  holdNearby(p.from);
}

/** Ask the server to let you talk to them now (errors: not_nearby, too_many_people, rate_limited). */
export async function nearbyKnock(peer: string) {
  const { error } = await supabase.rpc("nearby_knock", { p_to: peer });
  if (error) throw new Error(error.message);
}

export async function nearbyHistory(peer: string): Promise<WalkieItem[]> {
  const { data, error } = await supabase.rpc("nearby_history", { p_other: peer, p_limit: 20 });
  if (error) throw new Error(error.message);
  return (data ?? []) as WalkieItem[];
}

export async function nearbyAudio(id: string): Promise<{ mime: string; audio_b64: string }> {
  const { data, error } = await supabase.rpc("nearby_audio", { p_id: id });
  if (error) throw new Error(error.message);
  const row = (data ?? [])[0];
  if (!row) throw new Error("not_available");
  return row;
}

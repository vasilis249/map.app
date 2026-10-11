import { silenceAll } from "@/lib/audio";
import { WalkieSession, walkieAudioRunning, type WalkieKind, type WalkieSnapshot } from "./engine";

/**
 * Every live walkie session of this device, one per person and kind. "Channel on" friends are kept connected while
 * you use the rest of the app (you hear them anywhere, they see you as here); a friend's walkie screen borrows the
 * same session, so there is never a second join of the same channel. Nearby (map) sessions are held by
 * lib/location/nearby.ts for a few minutes after a knock.
 */

interface Entry {
  session: WalkieSession;
  refs: number;
  pinned: boolean;
  off: (() => void)[];
}

export interface HubPeer {
  peer: string;
  kind: WalkieKind;
  snap: WalkieSnapshot;
}

let me: string | null = null;
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const startListeners = new Set<(peer: string, kind: WalkieKind) => void>();
let version = 0;
let nearbyArmed = false;

const keyOf = (peer: string, kind: WalkieKind) => `${kind}:${peer}`;

function changed() {
  version++;
  listeners.forEach((fn) => fn());
}

function open(peer: string, kind: WalkieKind = "walkie"): Entry {
  const key = keyOf(peer, kind);
  let e = entries.get(key);
  if (e) return e;
  const session = new WalkieSession(me!, peer, kind);
  e = { session, refs: 0, pinned: false, off: [] };
  e.off.push(session.subscribe(changed));
  e.off.push(
    session.on("peerStart", () => {
      // An incoming voice interrupts the podcast queue / clips, like a call.
      if (walkieAudioRunning()) silenceAll();
      startListeners.forEach((fn) => fn(peer, kind));
    }),
  );
  entries.set(key, e);
  session.connect();
  changed();
  return e;
}

function closeIfUnused(key: string) {
  const e = entries.get(key);
  if (!e || e.refs > 0 || e.pinned) return;
  e.off.forEach((f) => f());
  e.session.dispose();
  entries.delete(key);
  changed();
}

export const walkieHub = {
  /** Signed-in user (null on sign-out closes everything). */
  setUser(id: string | null) {
    if (id === me) return;
    for (const [key, e] of entries) {
      e.off.forEach((f) => f());
      e.session.dispose();
      entries.delete(key);
    }
    me = id;
    changed();
  },

  /** Friends whose channel stays open (walkie_list → channel_on). */
  setPinned(peers: string[]) {
    if (!me) return;
    const want = new Set(peers.map((p) => keyOf(p, "walkie")));
    for (const [key, e] of entries) {
      if (e.pinned && !want.has(key)) {
        e.pinned = false;
        closeIfUnused(key);
      }
    }
    for (const peer of peers) open(peer, "walkie").pinned = true;
  },

  /** A screen uses this person's session until it calls the returned release. */
  acquire(peer: string, kind: WalkieKind = "walkie"): { session: WalkieSession; release: () => void } | null {
    if (!me || peer === me) return null;
    const e = open(peer, kind);
    e.refs++;
    let released = false;
    return {
      session: e.session,
      release: () => {
        if (released) return;
        released = true;
        e.refs--;
        // Let a quick remount (route change, StrictMode) reuse the connection.
        setTimeout(() => closeIfUnused(keyOf(peer, kind)), 1500);
      },
    };
  },

  /** Every open session (for the "… is talking" banner). */
  peers(): HubPeer[] {
    return [...entries.values()].map((e) => ({ peer: e.session.peer, kind: e.session.kind, snap: e.session.snapshot }));
  },

  /** Back in the foreground / online again: rejoin whatever is not connected. */
  refresh() {
    for (const e of entries.values()) if (!e.session.snapshot.connected) e.session.reconnect();
  },

  pinnedCount(): number {
    return [...entries.values()].filter((e) => e.pinned).length;
  },

  /** Location sharing is on: someone near you may start talking any moment. */
  setNearbyArmed(on: boolean) {
    nearbyArmed = on;
  },

  /** Something may play without a tap (unlock Web Audio on the first tap, keep-alive in the background). */
  wantsAudio(): boolean {
    return nearbyArmed || [...entries.values()].some((e) => e.pinned || e.session.kind === "nearby");
  },

  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },

  /** Someone started talking on any open session. */
  onPeerStart(fn: (peer: string, kind: WalkieKind) => void): () => void {
    startListeners.add(fn);
    return () => void startListeners.delete(fn);
  },

  /** Changes on every change (useSyncExternalStore). */
  version: () => version,
};

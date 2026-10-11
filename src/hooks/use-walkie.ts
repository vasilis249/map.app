import { useEffect, useRef, useState } from "react";
import type { WalkieKind, WalkieSession, WalkieSnapshot } from "@/lib/walkie/engine";
import { walkieHub } from "@/lib/walkie/hub";

/**
 * The live walkie-talkie channel with one person (shared with the hub): a friend's walkie, or someone near you on
 * the map (kind "nearby").
 */
export function useWalkie(
  me: string | undefined,
  peer: string,
  events: { onSaved?: () => void; onYield?: () => void } = {},
  kind: WalkieKind = "walkie",
) {
  const [snap, setSnap] = useState<WalkieSnapshot | null>(null);
  const session = useRef<WalkieSession | null>(null);
  const handlers = useRef(events);
  handlers.current = events;

  useEffect(() => {
    if (!me) return;
    walkieHub.setUser(me); // no-op when the hub already runs for this user
    const got = walkieHub.acquire(peer, kind);
    if (!got) return;
    const s = got.session;
    session.current = s;
    setSnap(s.snapshot);
    const off = [
      s.subscribe(setSnap),
      s.on("saved", () => handlers.current.onSaved?.()),
      s.on("yield", () => handlers.current.onYield?.()),
    ];
    return () => {
      off.forEach((f) => f());
      // Leaving the screen mid-transmission stops it (and saves what was said).
      s.release();
      got.release();
      session.current = null;
    };
  }, [me, peer, kind]);

  return {
    snap,
    press: (gate?: Promise<unknown>) => session.current?.press(gate) ?? Promise.resolve(false),
    abort: () => session.current?.abort(),
    release: () => session.current?.release(),
    unlockAudio: () => void session.current?.unlockAudio(),
  };
}

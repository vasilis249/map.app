import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { useRecorder } from "@/hooks/use-recorder";

type Recorder = ReturnType<typeof useRecorder>;

/**
 * Push to talk: hold the button to record, let go to stop. Holding for less than `minMs` throws the clip away
 * (`onTooShort`); a quick tap (< `tapMs`) calls `onTap` instead when given. Space / Enter work the same way.
 * Spread `bind` on the button.
 */
export function usePushToTalk(
  r: Recorder,
  { minMs = 700, tapMs = 250, onTap, onTooShort }: { minMs?: number; tapMs?: number; onTap?: () => void; onTooShort?: () => void } = {},
) {
  const held = useRef(false);
  const downAt = useRef(0);
  const [holding, setHolding] = useState(false);

  const press = useCallback(() => {
    if (held.current) return;
    held.current = true;
    downAt.current = Date.now();
    setHolding(true);
    // Let go while the microphone was still starting (e.g. the permission prompt) → nothing is kept.
    void r.start().then((ok) => {
      if (ok && !held.current) r.discard();
    });
  }, [r]);

  const release = useCallback(() => {
    if (!held.current) return;
    held.current = false;
    setHolding(false);
    const dt = Date.now() - downAt.current;
    if (onTap && dt < tapMs) {
      r.discard();
      onTap();
    } else if (dt < minMs) {
      r.discard();
      onTooShort?.();
    } else {
      r.stop();
    }
  }, [r, minMs, tapMs, onTap, onTooShort]);

  // Stopped without a release (hit the time limit while held, no microphone): the button may be gone by the time
  // the finger lifts, so forget the press — otherwise the next one would be ignored.
  useEffect(() => {
    if (held.current && (r.state === "recorded" || r.error)) {
      held.current = false;
      setHolding(false);
    }
  }, [r.state, r.error]);

  const bind = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      press();
    },
    onPointerUp: release,
    onPointerCancel: release,
    onLostPointerCapture: release,
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if ((e.key === " " || e.key === "Enter") && !e.repeat) {
        e.preventDefault();
        press();
      }
    },
    onKeyUp: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        release();
      }
    },
    // No long-press menu, text selection or double-tap zoom on iOS: WebKit's long-press (selection / loupe) would
    // cancel the pointer after ~0.5 s and the voice would be thrown away as "too short".
    style: { WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none", touchAction: "none" } as const,
  };
  return { bind, holding };
}

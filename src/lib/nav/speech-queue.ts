/**
 * Voice guidance and push-to-talk share the speaker (brief: "duck, never cut the guidance silently"). While anyone
 * talks (you on air, or a voice arriving) guidance waits; an announcement that was playing when the talk started is
 * stopped and said again afterwards. Only the newest waiting announcement is kept (it describes what's next), and
 * one that no longer applies (`still()` false: you already passed that turn) is dropped — the banner shows it anyway.
 */

export interface SpeechEngine {
  /** Resolves when done (or stopped). */
  speak(text: string): Promise<void>;
  stop(): void;
}

export interface QueuedUtterance {
  key: string;
  text: string;
  still?: () => boolean;
}

export function createSpeechQueue(engine: SpeechEngine) {
  let talking = false;
  let current: QueuedUtterance | null = null;
  let pending: QueuedUtterance | null = null;
  let token = 0;

  function play(u: QueuedUtterance) {
    current = u;
    const mine = ++token;
    void engine
      .speak(u.text)
      .catch(() => undefined)
      .then(() => {
        if (mine !== token) return; // stopped for a talk, or replaced
        current = null;
        pump();
      });
  }

  function pump() {
    if (talking || current || !pending) return;
    const u = pending;
    pending = null;
    if (u.still && !u.still()) return pump();
    play(u);
  }

  return {
    say(u: QueuedUtterance) {
      pending = u;
      pump();
    },
    /** Someone started / stopped talking. */
    setTalking(on: boolean) {
      if (on === talking) return;
      talking = on;
      if (on && current) {
        // Interrupted: say it again after the talk, unless something newer is already waiting.
        pending ??= current;
        current = null;
        token++;
        engine.stop();
      }
      if (!on) pump();
    },
    /** Navigation ended. */
    clear() {
      pending = null;
      if (current) {
        current = null;
        token++;
        engine.stop();
      }
    },
    get busy() {
      return !!current;
    },
    get waiting() {
      return pending?.text ?? null;
    },
  };
}

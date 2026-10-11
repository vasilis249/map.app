/**
 * Browser audio helpers for voice clips (recording format, base64, playback).
 *
 * Playback uses one shared <audio> element. iOS only lets a page start audio from a
 * user gesture, and listen-once clips arrive after an async RPC, so the tap handler
 * calls `player.prime()` synchronously (plays a few ms of silence to unlock the
 * element) and the real clip is played on the same element afterwards. An <audio>
 * element also plays with the ringer switch on silent, unlike Web Audio.
 */

/** Best recording format the browser supports (AAC/MP4 plays everywhere, incl. iOS). */
export function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m));
}

export type AudioSessionType = "auto" | "playback" | "play-and-record" | "ambient";
/**
 * Safari 16.4+ `navigator.audioSession`: 'playback' plays through the silent switch, 'play-and-record' is needed
 * while the mic is on — WebKit refuses getUserMedia under 'playback' (looks like "permission denied").
 * Returns the previous type (undefined where unsupported).
 */
export function setAudioSession(type: AudioSessionType): AudioSessionType | undefined {
  const s = (navigator as unknown as { audioSession?: { type: AudioSessionType } }).audioSession;
  if (!s) return undefined;
  const prev = s.type;
  try {
    s.type = type;
  } catch {
    /* not supported */
  }
  return prev;
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** 50 ms of silence as a WAV data URL (used to unlock playback inside a tap). */
function silentWav(): string {
  const rate = 8000;
  const n = rate / 20;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + n, true); str(8, "WAVEfmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, "data"); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  let s = "";
  new Uint8Array(buf).forEach((b) => (s += String.fromCharCode(b)));
  return "data:audio/wav;base64," + btoa(s);
}

type PlayOptions = { onProgress?: (fraction: number) => void; onEnd?: () => void; durationMs?: number };

// The feed queue (lib/queue.ts) registers here so a private clip starting pauses it.
let onExclusive: (() => void) | null = null;
export function setExclusiveHandler(fn: () => void) {
  onExclusive = fn;
}
/** Pause the voice queue and any clip — e.g. when the microphone starts, so nothing plays into the recording. */
export function silenceAll() {
  onExclusive?.();
  player.stop();
}

class ClipPlayer {
  private el: HTMLAudioElement | null = null;
  private url: string | null = null;
  private raf = 0;
  private onEnd: (() => void) | undefined;

  private element(): HTMLAudioElement {
    if (!this.el) {
      this.el = new Audio();
      this.el.setAttribute("playsinline", "");
      this.el.preload = "auto";
    }
    return this.el;
  }

  /** Call synchronously inside the tap handler, before any await. */
  prime() {
    onExclusive?.();
    const el = this.element();
    this.stop();
    el.src = silentWav();
    void el.play().catch(() => {});
  }

  async play(blob: Blob, { onProgress, onEnd, durationMs }: PlayOptions = {}) {
    const el = this.element();
    this.stop();
    this.url = URL.createObjectURL(blob);
    this.onEnd = onEnd;
    el.src = this.url;
    el.onended = () => this.finish();
    const tick = () => {
      const total = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : (durationMs ?? 0) / 1000;
      if (total > 0) onProgress?.(Math.min(1, el.currentTime / total));
      this.raf = requestAnimationFrame(tick);
    };
    await el.play();
    this.raf = requestAnimationFrame(tick);
  }

  private finish() {
    cancelAnimationFrame(this.raf);
    const cb = this.onEnd;
    this.onEnd = undefined;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    cb?.();
  }

  stop() {
    if (!this.el) return;
    this.el.pause();
    this.el.onended = null;
    if (this.url) this.finish();
  }
}

export const player = new ClipPlayer();

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

import { useCallback, useEffect, useRef, useState } from "react";
import { pickRecorderMime, setAudioSession, silenceAll, type AudioSessionType } from "@/lib/audio";

export type RecorderState = "idle" | "recording" | "recorded";
export type MicError = "denied" | "busy" | "unsupported";
/** i18n key of the toast for each microphone error. */
export const MIC_ERROR_KEY: Record<MicError, string> = { denied: "voice.micDenied", busy: "voice.micBusy", unsupported: "voice.unsupported" };
/** Only a real permission refusal says "allow access in Settings"; anything else (mic in use, a call…) is "busy". */
export function micError(e: unknown): MicError {
  const name = (e as { name?: string } | null)?.name;
  return name === "NotAllowedError" || name === "SecurityError" ? "denied" : "busy";
}

/** Microphone recorder with a hard time limit (auto-stops at `maxMs`). */
export function useRecorder(maxMs: number, initial?: { blob: Blob; mime: string; durationMs: number } | null) {
  const [state, setState] = useState<RecorderState>(initial ? "recorded" : "idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [clip, setClip] = useState<{ blob: Blob; mime: string; durationMs: number } | null>(initial ?? null);
  const [error, setError] = useState<MicError | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const prevSession = useRef<AudioSessionType | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAt = useRef(0);
  const discardNext = useRef(false);
  const mounted = useRef(true);

  const cleanup = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    if (prevSession.current) setAudioSession(prevSession.current);
    prevSession.current = undefined;
  }, []);

  const stop = useCallback(() => {
    if (rec.current && rec.current.state !== "inactive") rec.current.stop();
  }, []);

  /** Resolves true once recording has begun (false: no microphone / not allowed). */
  const start = useCallback(async (): Promise<boolean> => {
    setError(null);
    silenceAll();
    const mime = pickRecorderMime();
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("unsupported");
      return false;
    }
    // An open walkie channel keeps the page in 'playback', where iOS refuses the mic.
    prevSession.current = setAudioSession("play-and-record");
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
    } catch (e) {
      cleanup();
      if (mounted.current) setError(micError(e));
      return false;
    }
    // The screen went away while the microphone was starting: don't leave it on.
    if (!mounted.current) {
      cleanup();
      return false;
    }
    const chunks: Blob[] = [];
    const r = new MediaRecorder(stream.current, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 64000 });
    rec.current = r;
    discardNext.current = false;
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    r.onstop = () => {
      const durationMs = Math.min(maxMs, Date.now() - startedAt.current);
      cleanup();
      if (discardNext.current || !chunks.length) {
        setState("idle");
        return;
      }
      const type = (r.mimeType || mime || "audio/mp4").split(";")[0];
      setClip({ blob: new Blob(chunks, { type }), mime: type, durationMs });
      setState("recorded");
    };
    startedAt.current = Date.now();
    setElapsedMs(0);
    r.start(250);
    setState("recording");
    timer.current = setInterval(() => {
      const ms = Date.now() - startedAt.current;
      setElapsedMs(ms);
      if (ms >= maxMs) stop();
    }, 100);
    return true;
  }, [cleanup, maxMs, stop]);

  /** Cancel a recording in progress, or throw away the recorded clip. */
  const discard = useCallback(() => {
    if (rec.current && rec.current.state !== "inactive") {
      discardNext.current = true;
      rec.current.stop();
    }
    setClip(null);
    setElapsedMs(0);
    setState("idle");
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      discardNext.current = true;
      if (rec.current && rec.current.state !== "inactive") rec.current.stop();
      cleanup();
    };
  }, [cleanup]);

  return { state, elapsedMs, clip, error, start, stop, discard };
}

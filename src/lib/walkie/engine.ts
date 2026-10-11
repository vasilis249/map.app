import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { blobToBase64, pickRecorderMime, setAudioSession, silenceAll } from "@/lib/audio";
import { CHUNK_SAMPLES, decodeChunk, Downsampler, encodeChunk, WALKIE_RATE } from "./codec";

/**
 * One live walkie-talkie channel between two people (Supabase Realtime, private channel `<kind>:<a>:<b>`):
 * `walkie` = two friends, `nearby` = two people near each other on the map (each transmission is approved by the
 * server first — a knock — and waits on your phone until the other one has joined).
 *
 * Talking: the microphone runs through a ScriptProcessor → 16 kHz μ-law pieces of 0.25 s → binary broadcast
 * `audio`, framed by `start` / `end`. A MediaRecorder records the same voice so it can be saved (24 h replay).
 * Listening: pieces are scheduled on a Web Audio clock with a 0.3 s cushion (jitter buffer); a missing piece is
 * just a short gap. One speaker at a time: you can't press while the friend talks, and if both press at once the
 * later press gives way. Presence on the channel says whether the friend is there.
 *
 * A session may be shared (the walkie hub keeps "channel on" friends connected while you use the rest of the app,
 * and their walkie screen borrows the same session): listeners subscribe to changes and events.
 */

export const WALKIE_MAX_MS = 60_000;
const JITTER_S = 0.3;
const PEER_SILENT_MS = 1500; // no piece for this long = the friend's transmission ended (lost `end`)
const BEEP_S = 0.09;
const MIN_SAVE_MS = 500;

export type WalkieError = "denied" | "unsupported" | "channel";
export type WalkieKind = "walkie" | "nearby";
export interface WalkieSnapshot {
  connected: boolean;
  peerOnline: boolean;
  /** Mic is starting (permission, hardware). */
  starting: boolean;
  /** You are on air. */
  talking: boolean;
  /** You talk, but your voice waits on this phone (approval, the other one joining). */
  waiting: boolean;
  peerTalking: boolean;
  elapsedMs: number;
  /** iOS needs one tap before Web Audio may play. */
  audioLocked: boolean;
  error: WalkieError | null;
}

export function walkieTopic(a: string, b: string, kind: WalkieKind = "walkie"): string {
  return a < b ? `${kind}:${a}:${b}` : `${kind}:${b}:${a}`;
}

const BACKLOG_KEEP_MS = 20_000; // a held-back transmission nobody joined for is dropped (the saved copy remains)

// ---------------------------------------------------------------------------------------------------------------
// One AudioContext for the app (iOS allows few), unlocked by a tap.
let ctx: AudioContext | null = null;
function audioContext(): AudioContext {
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new AC();
    // iOS pauses Web Audio whenever the audio session changes (after you talk, a recording elsewhere in the app, a
    // call): nothing would play or be captured until something resumes it. Resume it ourselves.
    ctx.onstatechange = () => {
      if (ctx && ctx.state !== "running" && live.size) setTimeout(() => void wakeAudio(), 150);
    };
  }
  return ctx;
}

/** Resume the context without a gesture (works once it was unlocked by a tap). True when it runs. */
function wakeAudio(): Promise<boolean> {
  const c = ctx;
  if (!c) return Promise.resolve(false);
  if (c.state === "running") return Promise.resolve(true);
  return Promise.race([
    c.resume().then(
      () => c.state === "running",
      () => false,
    ),
    new Promise<boolean>((r) => setTimeout(() => r(false), 1000)),
  ]);
}

/** Back from the background: iOS may have suspended / interrupted the context. Best effort (no gesture). */
export function resumeWalkieAudio() {
  if (ctx && ctx.state !== "running") void ctx.resume().catch(() => {});
}

/** Call inside a tap: lets Web Audio play (iOS) and plays nothing audible. */
export async function unlockWalkieAudio(): Promise<boolean> {
  const c = audioContext();
  try {
    const b = c.createBuffer(1, 1, 22050);
    const src = c.createBufferSource();
    src.buffer = b;
    src.connect(c.destination);
    src.start(0);
    await c.resume();
  } catch {
    /* ignore */
  }
  return c.state === "running";
}

/**
 * Diagnostics of live audio (technical counters only, never audio), sent only when something went wrong: the alarm
 * if the walkie breaks again. Read: `select at, user_id, data from private.walkie_diag order by id desc`.
 */
function diag(kind: string, data: Record<string, unknown>) {
  const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession?.type ?? null;
  void supabase
    .rpc("walkie_diag", {
      p_data: { kind, ctx: ctx?.state ?? null, rate: ctx?.sampleRate ?? null, session, ua: navigator.userAgent.slice(0, 160), ...data },
    })
    .then(() => {}, () => {});
}

/** Sessions connected right now (the audio session goes back to "auto" when the last one closes). */
const live = new Set<WalkieSession>();
const openSessions = () => live.size;

/** The shared AudioContext, when it can play (tests / UI hints). */
export function walkieAudioRunning(): boolean {
  return !!ctx && ctx.state === "running";
}

function beep(c: AudioContext, freq: number) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.12, c.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + BEEP_S);
  osc.connect(gain).connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + BEEP_S);
}

// ---------------------------------------------------------------------------------------------------------------
interface Transmission {
  sid: string;
  at: number;
  seq: number;
  startedAt: number;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  proc: ScriptProcessorNode;
  sink: GainNode;
  down: Downsampler;
  pending: Float32Array;
  sendFrom: number; // AudioContext time: skip the beep
  recorder: MediaRecorder | null;
  recorded: Blob[];
  mime: string;
  timer: ReturnType<typeof setInterval>;
  aborted: boolean;
  /** Approval of this transmission (nearby knock); nothing leaves the phone before it. */
  gate: Promise<unknown> | null;
  gateOk: boolean;
  /** Diagnostics: onaudioprocess calls, pieces sent, input peak, context state at press / after waking it. */
  d: { calls: number; sent: number; peak: number; ctxPress: string; ctxWoken: string; gumMs: number };
}

export type WalkieEvent = "saved" | "yield" | "peerStart";

interface Reception {
  sid: string;
  at: number;
  lastAt: number;
  playhead: number;
  ended: boolean;
  /** Diagnostics: pieces received / played / held while paused, output peak. */
  d: { pieces: number; played: number; held: number; peak: number; start: boolean; expected?: number };
}

export class WalkieSession {
  private channel: RealtimeChannel | null = null;
  private tx: Transmission | null = null;
  private rx: Reception | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private disposed = false;
  /** Messages held back until the gate is open and the other one is on the channel. */
  private backlog: { event: string; payload: unknown }[] | null = null;
  /** A release that came while the mic was still opening: cancel the press (nothing goes out). */
  private cancelStart = false;
  /** Diagnostics: recent channel statuses, sends the client reported as not ok. */
  private statusLog: string[] = [];
  private sendFails = 0;
  /** Transmissions heard completely live (by sid), and saved copies already replayed (by id). */
  private heard = new Set<string>();
  private replayed = new Set<string>();
  private backlogDrop: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(s: WalkieSnapshot) => void>();
  private handlers: Record<WalkieEvent, Set<() => void>> = { saved: new Set(), yield: new Set(), peerStart: new Set() };
  private snap: WalkieSnapshot = {
    connected: false,
    peerOnline: false,
    starting: false,
    talking: false,
    waiting: false,
    peerTalking: false,
    elapsedMs: 0,
    audioLocked: true,
    error: null,
  };

  constructor(
    readonly me: string,
    readonly peer: string,
    readonly kind: WalkieKind = "walkie",
  ) {}

  get snapshot() {
    return this.snap;
  }

  /** Changes of the snapshot. Returns the unsubscribe. */
  subscribe(fn: (s: WalkieSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /**
   * saved: a transmission was saved (yours or the friend's) — refresh the history. yield: both pressed at once and
   * the friend was first. peerStart: the friend started talking.
   */
  on(event: WalkieEvent, fn: () => void): () => void {
    this.handlers[event].add(fn);
    return () => void this.handlers[event].delete(fn);
  }

  private emit(event: WalkieEvent) {
    this.handlers[event].forEach((fn) => fn());
  }

  private set(patch: Partial<WalkieSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    if (!this.disposed) this.listeners.forEach((fn) => fn(this.snap));
  }

  connect() {
    live.add(this);
    setAudioSession("playback");
    this.set({ audioLocked: typeof window === "undefined" || audioContext().state !== "running" });
    this.openChannel();
    this.watchdog = setInterval(() => this.checkPeerSilence(), 500);
  }

  /** Drop the channel and join again (after an error, a long background, the network coming back). */
  reconnect() {
    if (this.disposed || this.tx) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    if (this.channel) {
      void this.channel.untrack();
      void supabase.removeChannel(this.channel);
      this.channel = null;
    }
    this.rx = null;
    this.set({ connected: false, peerOnline: false, peerTalking: false });
    this.openChannel();
  }

  /** Joining failed: try again later (5 s, 15 s, 45 s, then every 60 s). */
  private scheduleRetry() {
    if (this.disposed || this.retry) return;
    const wait = Math.min(60_000, 5_000 * 3 ** this.failures++);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.reconnect();
    }, wait);
  }

  private openChannel() {
    const ch = supabase.channel(walkieTopic(this.me, this.peer, this.kind), {
      config: { private: true, broadcast: { self: false }, presence: { key: this.me } },
    });
    ch.on("broadcast", { event: "start" }, ({ payload }) => this.onPeerStart(payload as { sid: string; at: number }))
      .on("broadcast", { event: "audio" }, ({ payload }) => this.onPeerAudio(payload as ArrayBuffer))
      .on("broadcast", { event: "end" }, ({ payload }) => this.onPeerEnd(payload as { sid: string }))
      .on("broadcast", { event: "saved" }, ({ payload }) => {
        this.emit("saved");
        // Saved copy of a transmission we did not hear completely live: play it now.
        const sid = (payload as { sid?: string } | null)?.sid;
        if (sid && !this.heard.has(sid) && this.rx?.sid !== sid) void this.replayMissed(Date.now() - 20_000); // playing: decided at its end
      })
      .on("presence", { event: "sync" }, () => {
        this.set({ peerOnline: (ch.presenceState()[this.peer]?.length ?? 0) > 0 });
        this.tryFlush();
      })
      .subscribe((status) => {
        if (this.disposed || this.channel !== ch) return; // a replaced channel's late status
        this.statusLog = [...this.statusLog.slice(-5), `${status}@${new Date().toISOString().slice(14, 23)}`];
        if (status === "SUBSCRIBED") {
          this.failures = 0;
          this.set({ connected: true, error: null });
          void ch.track({ at: Date.now() });
          this.tryFlush();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          this.set({ connected: false, error: "channel" });
          this.scheduleRetry();
        } else if (status === "CLOSED") {
          this.set({ connected: false });
        }
      });
    this.channel = ch;
  }

  dispose() {
    this.disposed = true;
    live.delete(this);
    if (this.retry) clearTimeout(this.retry);
    if (this.backlogDrop) clearTimeout(this.backlogDrop);
    if (this.tx) this.finishTransmission(false);
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.channel) {
      void this.channel.untrack();
      void supabase.removeChannel(this.channel);
    }
    this.channel = null;
    this.listeners.clear();
    Object.values(this.handlers).forEach((h) => h.clear());
    if (!openSessions()) setAudioSession("auto");
  }

  /** Tap handler: unlock playback on iOS. */
  async unlockAudio() {
    const ok = await unlockWalkieAudio();
    this.set({ audioLocked: !ok });
  }

  // ------------------------------------------------------------------------------------------------ talking ----
  /**
   * Start talking (call from the press). Resolves false if busy, no microphone or not connected. With a gate (the
   * server's approval), the voice is held on this phone until the gate resolves and the other one is on the channel;
   * a rejected gate aborts the transmission.
   */
  async press(gate?: Promise<unknown>): Promise<boolean> {
    if (this.tx || this.snap.starting || !this.channel || !this.snap.connected || this.snap.peerTalking) return false;
    const c = audioContext();
    void this.unlockAudio(); // the press is a gesture: good moment on iOS
    if (!navigator.mediaDevices?.getUserMedia || typeof c.createScriptProcessor !== "function") {
      this.set({ error: "unsupported" });
      return false;
    }
    silenceAll();
    this.cancelStart = false;
    const ctxPress = c.state;
    const t0 = Date.now();
    setAudioSession("play-and-record");
    this.set({ starting: true });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (e) {
      diag("tx-fail", { error: (e as { name?: string })?.name ?? String(e), ctxPress });
      setAudioSession("playback");
      this.set({ starting: false, error: "denied" });
      return false;
    }
    // The switch to play-and-record paused the context on iOS: without this the mic is never read (no live voice,
    // only the saved copy).
    const gumMs = Date.now() - t0;
    await wakeAudio();
    const ctxWoken = c.state;
    if (this.disposed || this.snap.peerTalking || this.cancelStart) {
      // Let go before the mic was ready (iOS takes ~1 s): nothing was said, nothing goes out.
      stream.getTracks().forEach((t) => t.stop());
      setAudioSession("playback");
      void wakeAudio();
      this.set({ starting: false });
      return false;
    }

    const source = c.createMediaStreamSource(stream);
    const proc = c.createScriptProcessor(4096, 1, 1);
    const sink = c.createGain();
    sink.gain.value = 0;
    source.connect(proc);
    proc.connect(sink).connect(c.destination);

    const mime = pickRecorderMime();
    let recorder: MediaRecorder | null = null;
    try {
      recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 32000 });
    } catch {
      recorder = null; // live only, nothing saved
    }
    const tx: Transmission = {
      sid: crypto.randomUUID(),
      at: Date.now(),
      seq: 0,
      startedAt: Date.now(),
      stream,
      source,
      proc,
      sink,
      down: new Downsampler(c.sampleRate),
      pending: new Float32Array(0),
      sendFrom: c.currentTime + BEEP_S,
      recorder,
      recorded: [],
      mime: (recorder?.mimeType || mime || "audio/mp4").split(";")[0],
      timer: setInterval(() => {
        const ms = Date.now() - tx.startedAt;
        this.set({ elapsedMs: ms });
        if (ms >= WALKIE_MAX_MS) this.release();
      }, 200),
      aborted: false,
      gate: gate ?? null,
      gateOk: !gate,
      d: { calls: 0, sent: 0, peak: 0, ctxPress, ctxWoken, gumMs },
    };
    if (recorder) {
      recorder.ondataavailable = (e) => e.data.size && tx.recorded.push(e.data);
      recorder.start(500);
    }
    proc.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      tx.d.calls++;
      for (let i = 0; i < input.length; i += 32) tx.d.peak = Math.max(tx.d.peak, Math.abs(input[i]));
      if (this.tx !== tx || c.currentTime < tx.sendFrom) return;
      const s16 = tx.down.process(input);
      const all = new Float32Array(tx.pending.length + s16.length);
      all.set(tx.pending);
      all.set(s16, tx.pending.length);
      let off = 0;
      for (; off + CHUNK_SAMPLES <= all.length; off += CHUNK_SAMPLES) this.sendAudio(tx, all.subarray(off, off + CHUNK_SAMPLES));
      tx.pending = all.slice(off);
    };
    this.tx = tx;
    beep(c, 880);
    if (gate || (this.kind === "nearby" && !this.snap.peerOnline)) this.holdBack();
    if (gate) {
      gate.then(
        () => {
          tx.gateOk = true;
          this.tryFlush();
        },
        () => {
          if (this.tx === tx) this.abort();
        },
      );
    }
    this.out("start", { sid: tx.sid, at: tx.at });
    this.set({ starting: false, talking: true, elapsedMs: 0 });
    return true;
  }

  /** Stop at once, nothing sent any more, nothing saved (the approval was refused). */
  abort() {
    if (this.tx) {
      this.tx.aborted = true;
      this.finishTransmission(false);
    }
    this.dropBacklog();
  }

  private holdBack() {
    if (this.backlogDrop) clearTimeout(this.backlogDrop);
    this.backlogDrop = null;
    this.backlog = [];
    this.set({ waiting: true });
  }

  private dropBacklog() {
    if (this.backlogDrop) clearTimeout(this.backlogDrop);
    this.backlogDrop = null;
    this.backlog = null;
    if (this.snap.waiting) this.set({ waiting: false });
  }

  /** The channel can take a broadcast over the WebSocket right now. */
  private canPush(): boolean {
    return !!this.channel && this.channel.state === "joined" && supabase.realtime.isConnected();
  }

  private push(m: { event: string; payload: unknown }) {
    void this.channel!.send({ type: "broadcast", event: m.event, payload: m.payload }).then((r) => {
      if (r !== "ok") this.sendFails++;
    });
  }

  /** Send what was held back once the channel is joined, the approval came and (nearby) the other one is here. */
  private tryFlush() {
    if (!this.backlog || !this.canPush()) return;
    if (this.kind === "nearby" && !this.snap.peerOnline) return;
    if (this.tx && !this.tx.gateOk) return;
    const items = this.backlog;
    this.dropBacklog();
    items.forEach((m) => this.push(m));
  }

  /**
   * Broadcast now, or hold it back (waiting for an approval, or the channel is rejoining). Never while the channel
   * is not joined: realtime-js would fall back to its REST endpoint, which JSON-encodes the payload — a binary audio
   * piece arrives as {} and is lost. Held pieces go out in order once the channel is back.
   */
  private out(event: string, payload: unknown) {
    if (this.backlog) this.backlog.push({ event, payload });
    else if (this.canPush()) this.push({ event, payload });
    else this.backlog = [{ event, payload }];
  }

  /** Stop talking (release). The voice is saved for 24 h replay. */
  release() {
    if (this.tx) this.finishTransmission(true);
    else if (this.snap.starting) this.cancelStart = true;
  }

  private sendAudio(tx: Transmission, samples: Float32Array) {
    tx.d.sent++;
    this.out("audio", encodeChunk(tx.seq++, samples));
  }

  private finishTransmission(save: boolean) {
    const tx = this.tx;
    if (!tx) return;
    this.tx = null;
    clearInterval(tx.timer);
    if (tx.pending.length && !tx.aborted) this.sendAudio(tx, tx.pending);
    tx.proc.onaudioprocess = null;
    try {
      tx.source.disconnect();
      tx.proc.disconnect();
      tx.sink.disconnect();
    } catch {
      /* already */
    }
    const ms = Date.now() - tx.startedAt;
    this.out("end", { sid: tx.sid, ms });
    if ((tx.d.sent === 0 && ms > 400) || this.sendFails > 0 || tx.d.peak === 0)
      diag("tx", { ...tx.d, peak: Math.round(tx.d.peak * 1000) / 1000, ms, ctxEnd: ctx?.state, ...this.chanDiag() });
    this.sendFails = 0;
    // Still held back: give the other one a little longer to join, then drop it (the saved copy remains).
    if (this.backlog) this.backlogDrop = setTimeout(() => this.dropBacklog(), BACKLOG_KEEP_MS);
    const stopTracks = () => tx.stream.getTracks().forEach((t) => t.stop());
    const keep = save && !tx.aborted && ms >= MIN_SAVE_MS && tx.recorder;
    if (tx.recorder && tx.recorder.state !== "inactive") {
      tx.recorder.onstop = () => {
        stopTracks();
        if (keep) void this.save(tx, Math.min(ms, WALKIE_MAX_MS));
      };
      tx.recorder.stop();
    } else stopTracks();
    setAudioSession("playback");
    void wakeAudio();
    if (ctx) beep(ctx, 660);
    this.set({ talking: false, starting: false, elapsedMs: 0 });
  }

  private async save(tx: Transmission, ms: number) {
    if (!tx.recorded.length) return;
    try {
      if (tx.gate) await tx.gate; // refused → nothing saved
      const blob = new Blob(tx.recorded, { type: tx.mime });
      const { error } = await supabase.rpc(this.kind === "nearby" ? "send_nearby" : "send_walkie", {
        p_to: this.peer,
        p_audio_b64: await blobToBase64(blob),
        p_mime: tx.mime,
        p_duration_ms: Math.round(ms),
      });
      if (error) throw error;
      this.emit("saved");
      this.out("saved", { sid: tx.sid });
    } catch {
      /* live part already heard; the replay copy is best effort */
    }
  }

  /** Channel facts for the diagnostics. */
  private chanDiag() {
    return {
      walkie: this.kind,
      chan: this.statusLog.join(" "),
      chanState: this.channel?.state ?? null,
      socket: supabase.realtime.isConnected(),
      sendFails: this.sendFails,
      peerOnline: this.snap.peerOnline,
    };
  }

  private replaying = false;

  /**
   * Play the friend's newest saved transmission since `since` (the one not heard completely live) unless replayed
   * already — so nothing is ever lost, live or right after. Through Web Audio: it is unlocked already (no tap needed).
   */
  private async replayMissed(since: number) {
    if (this.replaying || this.disposed) return;
    this.replaying = true;
    try {
      const rpc = this.kind === "nearby" ? { history: "nearby_history", audio: "nearby_audio" } : { history: "walkie_history", audio: "walkie_audio" };
      const { data } = await supabase.rpc(rpc.history as "walkie_history", { p_other: this.peer, p_limit: 5 });
      const item = ((data ?? []) as { id: string; sender_id: string; created_at: string }[])
        .filter((i) => i.sender_id === this.peer && !this.replayed.has(i.id) && Date.parse(i.created_at) >= since)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      if (!item) return;
      this.replayed.add(item.id);
      const { data: rows } = await supabase.rpc(rpc.audio as "walkie_audio", { p_id: item.id });
      const row = (rows ?? [])[0] as { audio_b64: string } | undefined;
      if (!row || !(await wakeAudio()) || !ctx) return;
      const bytes = Uint8Array.from(atob(row.audio_b64), (ch) => ch.charCodeAt(0));
      const buffer = await ctx.decodeAudioData(bytes.buffer);
      if (this.tx || this.rx || this.disposed) return; // someone is talking now: it stays in the history
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.onended = () => this.set({ peerTalking: false });
      this.set({ peerTalking: true });
      src.start();
      diag("replay", { id: item.id, ms: Math.round(buffer.duration * 1000), ...this.chanDiag() });
    } catch (e) {
      diag("replay-fail", { error: String(e).slice(0, 120), ...this.chanDiag() });
    } finally {
      this.replaying = false;
    }
  }

  // ---------------------------------------------------------------------------------------------- listening ----
  private onPeerStart(p: { sid: string; at: number }) {
    if (this.tx) {
      // Both pressed at once: the earlier press keeps the floor (ties: the smaller id).
      const peerFirst = p.at < this.tx.at || (p.at === this.tx.at && this.peer < this.me);
      if (!peerFirst) return;
      this.tx.aborted = true;
      this.finishTransmission(false);
      this.emit("yield");
    }
    this.rx = { sid: p.sid, at: p.at, lastAt: Date.now(), playhead: 0, ended: false, d: { pieces: 0, played: 0, held: 0, peak: 0, start: true } };
    this.set({ peerTalking: true });
    this.emit("peerStart");
  }

  private onPeerAudio(buf: ArrayBuffer) {
    if (this.tx) return; // half duplex
    const chunk = decodeChunk(buf);
    if (!chunk) return;
    if (!this.rx || this.rx.ended)
      this.rx = { sid: "", at: Date.now(), lastAt: Date.now(), playhead: 0, ended: false, d: { pieces: 0, played: 0, held: 0, peak: 0, start: false } };
    const rx = this.rx;
    rx.lastAt = Date.now();
    rx.d.pieces++;
    if (!this.snap.peerTalking) this.set({ peerTalking: true });
    if (audioContext().state !== "running") {
      // Paused (iOS audio session change) or never unlocked: keep the last ~2 s and play them once it runs.
      this.held.push(chunk.samples);
      rx.d.held++;
      if (this.held.length > 8) this.held.shift();
      void wakeAudio().then((ok) => (ok ? this.playHeld() : this.set({ audioLocked: true })));
      return;
    }
    this.playHeld();
    this.play(chunk.samples);
  }

  private held: Float32Array<ArrayBuffer>[] = [];

  private playHeld() {
    if (this.snap.audioLocked) this.set({ audioLocked: false }); // unlocked by a tap elsewhere
    const held = this.held;
    this.held = [];
    held.forEach((s) => this.play(s));
  }

  private play(samples: Float32Array<ArrayBuffer>) {
    const rx = this.rx;
    const c = ctx;
    if (!rx || !c || c.state !== "running") return;
    const buffer = c.createBuffer(1, samples.length, WALKIE_RATE);
    buffer.copyToChannel(samples, 0);
    rx.d.played++;
    for (let i = 0; i < samples.length; i += 16) rx.d.peak = Math.max(rx.d.peak, Math.abs(samples[i]));
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.connect(c.destination);
    if (rx.playhead < c.currentTime + 0.02) rx.playhead = c.currentTime + JITTER_S;
    src.start(rx.playhead);
    rx.playhead += buffer.duration;
  }

  private onPeerEnd(p: { sid: string; ms?: number }) {
    if (this.rx) {
      this.rx.ended = true;
      this.rx.d.expected = Math.round((p.ms ?? 0) / 250);
    }
    this.finishReceptionSoon();
  }

  private checkPeerSilence() {
    if (this.rx && !this.rx.ended && Date.now() - this.rx.lastAt > PEER_SILENT_MS) {
      this.rx.ended = true;
      this.finishReceptionSoon();
    }
  }

  /** peerTalking goes off once what was scheduled has played. */
  private finishReceptionSoon() {
    const rx = this.rx;
    if (!rx) return;
    const left = ctx && ctx.state === "running" ? Math.max(0, rx.playhead - ctx.currentTime) : 0;
    setTimeout(() => {
      if (this.rx === rx && rx.ended) {
        this.rx = null;
        this.set({ peerTalking: false });
        const expected = rx.d.expected ?? 0;
        const complete = rx.d.start && expected > 0 && rx.d.played >= expected * 0.8;
        if (complete) {
          this.heard.add(rx.sid);
          if (this.heard.size > 50) this.heard.delete(this.heard.values().next().value!);
        } else {
          // Part of it was lost live: play the saved copy as soon as it is there (the "saved" broadcast also
          // triggers this; these two tries cover a lost "saved").
          const since = rx.at - 3000;
          setTimeout(() => void this.replayMissed(since), 2500);
          setTimeout(() => void this.replayMissed(since), 8000);
        }
        if (!complete || this.snap.audioLocked)
          diag("rx", { ...rx.d, peak: Math.round(rx.d.peak * 1000) / 1000, ms: Date.now() - rx.at, ...this.chanDiag() });
      }
    }, left * 1000 + 50);
  }
}

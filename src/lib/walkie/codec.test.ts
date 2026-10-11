import { describe, expect, it } from "vitest";
import { CHUNK_SAMPLES, decodeChunk, Downsampler, encodeChunk, WALKIE_RATE } from "./codec";

describe("walkie codec", () => {
  it("round-trips a 0.25 s piece through μ-law with its sequence number", () => {
    const tone = Float32Array.from({ length: CHUNK_SAMPLES }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / WALKIE_RATE));
    const buf = encodeChunk(7, tone);
    expect(buf.byteLength).toBe(5 + CHUNK_SAMPLES);
    const out = decodeChunk(buf)!;
    expect(out.seq).toBe(7);
    expect(out.samples.length).toBe(CHUNK_SAMPLES);
    // μ-law: ~2 % error at this level
    let worst = 0;
    for (let i = 0; i < tone.length; i++) worst = Math.max(worst, Math.abs(out.samples[i] - tone[i]));
    expect(worst).toBeLessThan(0.03);
  });

  it("clips out-of-range samples instead of wrapping", () => {
    const out = decodeChunk(encodeChunk(0, Float32Array.from([2, -2, 0])))!;
    expect(out.samples[0]).toBeGreaterThan(0.9);
    expect(out.samples[1]).toBeLessThan(-0.9);
    expect(Math.abs(out.samples[2])).toBeLessThan(0.01);
  });

  it("rejects what isn't a piece (a JSON-encoded {} from the REST fallback, wrong version, empty)", () => {
    expect(decodeChunk({} as unknown as ArrayBuffer)).toBeNull();
    expect(decodeChunk(new ArrayBuffer(5))).toBeNull();
    const bad = encodeChunk(1, new Float32Array(10));
    new DataView(bad).setUint8(0, 2);
    expect(decodeChunk(bad)).toBeNull();
  });

  it("downsamples 48 kHz blocks to 16 kHz without losing or adding samples across block edges", () => {
    const d = new Downsampler(48000);
    let total = 0;
    for (let b = 0; b < 10; b++) total += d.process(new Float32Array(4096)).length;
    expect(Math.abs(total - (10 * 4096) / 3)).toBeLessThanOrEqual(1);
  });
});

// Live walkie-talkie audio: 16 kHz mono, G.711 μ-law (8 bits per sample → 16 KB/s). Plain and fast to encode in
// JavaScript on any phone; good enough for speech. Each Realtime message carries ~0.25 s:
//   [0]    version (1)
//   [1..4] sequence number (uint32, big-endian), per transmission
//   [5..]  μ-law samples

export const WALKIE_RATE = 16000;
export const CHUNK_SAMPLES = 4000; // 0.25 s
const HEADER = 5;

const BIAS = 0x84;
const CLIP = 32635;

function encodeSample(s: number): number {
  let pcm = Math.max(-1, Math.min(1, s)) * 32767;
  const sign = pcm < 0 ? 0x80 : 0;
  if (sign) pcm = -pcm;
  pcm = Math.min(pcm, CLIP) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (pcm & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

const DECODE = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  DECODE[i] = (sign ? -magnitude : magnitude) / 32768;
}

/**
 * Turns microphone blocks (any sample rate) into 16 kHz samples. Keeps its position across blocks so the output
 * has no clicks at block edges; averages the input samples that fall into each output sample (a cheap low-pass).
 */
export class Downsampler {
  private pos = 0; // position in the input stream of the next output sample, relative to the current block
  constructor(private readonly inRate: number) {}

  process(input: Float32Array): Float32Array {
    const step = this.inRate / WALKIE_RATE;
    const out: number[] = [];
    let pos = this.pos;
    while (pos + step <= input.length) {
      // pos may start slightly before this block (the rest of the last output sample): use what this block has.
      const from = Math.max(0, Math.floor(pos));
      const to = Math.max(from + 1, Math.min(input.length, Math.floor(pos + step)));
      let sum = 0;
      for (let i = from; i < to; i++) sum += input[i];
      out.push(sum / (to - from));
      pos += step;
    }
    this.pos = pos - input.length;
    return Float32Array.from(out);
  }
}

export function encodeChunk(seq: number, samples: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER + samples.length);
  const view = new DataView(buf);
  view.setUint8(0, 1);
  view.setUint32(1, seq >>> 0);
  const bytes = new Uint8Array(buf, HEADER);
  for (let i = 0; i < samples.length; i++) bytes[i] = encodeSample(samples[i]);
  return buf;
}

export function decodeChunk(buf: ArrayBuffer): { seq: number; samples: Float32Array<ArrayBuffer> } | null {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength <= HEADER) return null;
  const view = new DataView(buf);
  if (view.getUint8(0) !== 1) return null;
  const bytes = new Uint8Array(buf, HEADER);
  const samples = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) samples[i] = DECODE[bytes[i]];
  return { seq: view.getUint32(1), samples };
}

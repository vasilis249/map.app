// The recorded Valhalla routes (src/lib/nav/fixtures) as [lat, lng] points, for flows that drive along them; and a
// recorder in place of the browser's voice / wake lock.
import fs from "node:fs";

const fx = (n) => JSON.parse(fs.readFileSync(new URL(`../../src/lib/nav/fixtures/${n}.json`, import.meta.url)));
/** Valhalla polyline6 → [lat, lng]. */
function decode(str) {
  const out = [];
  let i = 0, lat = 0, lng = 0;
  const next = () => {
    let r = 0, sh = 0, b;
    do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20);
    return r & 1 ? ~(r >> 1) : r >> 1;
  };
  while (i < str.length) { lat += next(); lng += next(); out.push([lat / 1e6, lng / 1e6]); }
  return out;
}
export const MAIN = decode(fx("valhalla-athens").trip.legs[0].shape);
export const REROUTE = decode(fx("valhalla-athens-reroute").trip.legs[0].shape);
export const dist = (a, b) => Math.hypot((a[0] - b[0]) * 111_320, (a[1] - b[1]) * 111_320 * Math.cos((a[0] * Math.PI) / 180));
/** Points every ~`step` m along a shape, from `fromM` to `toM` metres. */
export function along(shape, fromM, toM, step = 15) {
  const out = [];
  let d = 0;
  for (let i = 1; i < shape.length; i++) {
    const seg = dist(shape[i - 1], shape[i]);
    for (let x = 0; x < seg; x += step) {
      const at = d + x;
      if (at >= fromM && at <= toM) {
        const k = x / seg;
        out.push([shape[i - 1][0] + (shape[i][0] - shape[i - 1][0]) * k, shape[i - 1][1] + (shape[i][1] - shape[i - 1][1]) * k]);
      }
    }
    d += seg;
  }
  return out;
}
export const lengthOf = (shape) => shape.slice(1).reduce((d, p, i) => d + dist(shape[i], p), 0);

/** Replace the page's speechSynthesis (each sentence "takes" 1.2 s) and wake lock with recorders. */
export async function recordVoice(page) {
  await page.evaluate(() => {
    window.__spoken = [];
    window.__wake = [];
    let cur = null;
    const fake = {
      speak(u) {
        window.__spoken.push({ text: u.text, at: Date.now() });
        cur = u;
        setTimeout(() => { if (cur === u) { cur = null; u.onend?.(); } }, 1200);
      },
      cancel() { if (cur) { window.__spoken.push({ cancel: cur.text, at: Date.now() }); const u = cur; cur = null; u.onerror?.(); } },
      getVoices: () => [],
    };
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: fake });
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: async () => {
      window.__wake.push("on");
      const s = new EventTarget();
      s.release = async () => window.__wake.push("off");
      return s;
    } } });
  });
  return () => page.evaluate(() => window.__spoken.filter((s) => s.text && s.text.trim()).map((s) => s.text));
}

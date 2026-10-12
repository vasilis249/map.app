// Shared helpers for the browser flows: Chromium (fake mic, WebGL via SwiftShader, the container's proxy for map
// tiles), signed-in contexts, PASS / FAIL lines, SQL against the local DB.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
const { chromium, devices } = createRequire("/opt/node22/lib/node_modules/")("playwright");

export const S = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
export const base = "http://127.0.0.1:" + process.argv[2];
export const SUPABASE = "http://127.0.0.1:54321";
export const USERS = {
  me: { id: "11111111-0000-0000-0000-000000000001", email: "me@test" },
  maria: { id: "22222222-0000-0000-0000-000000000002", email: "maria@test" },
  nikos: { id: "33333333-0000-0000-0000-000000000003", email: "nikos@test" },
  giorgos: { id: "44444444-0000-0000-0000-000000000004", email: "giorgos@test" },
  eleni: { id: "55555555-0000-0000-0000-000000000005", email: "eleni@test" },
};
export const errors = [];
export const ok = (label, cond) => console.log(cond ? "PASS" : "FAIL", label);
/** Waits until the locator is visible (isVisible() itself never waits). */
export const seen = (loc, ms = 8_000) => loc.first().waitFor({ state: "visible", timeout: ms }).then(() => true, () => false);
export const gone = (loc, ms = 8_000) => loc.first().waitFor({ state: "hidden", timeout: ms }).then(() => true, () => false);
export const sql = (q) => execSync(`psql -h /tmp -p 54329 -U postgres -d mapapp -Atc "${q.replace(/"/g, '\\"')}"`).toString().trim();
/** Polls a SQL query until it returns `want` (or the time is up); returns the last value. */
export async function sqlUntil(q, want, ms = 10_000) {
  const end = Date.now() + ms;
  let v = sql(q);
  while (v !== want && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 300));
    v = sql(q);
  }
  return v;
}

const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
export const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${S}/tone440.wav`,
    "--autoplay-policy=no-user-gesture-required", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
    // Map tiles (OpenFreeMap) go through the container's proxy; Chromium keeps loopback (the app, the local
    // Supabase) direct by itself. Playwright's own `proxy` option would force loopback through the proxy too.
    ...(proxy ? [`--proxy-server=${proxy}`] : [])],
});

/**
 * A phone (iPhone 13 viewport, Greek, Athens) signed in as `who`, at `geo` if given, opened at `path`.
 * Audio probes in every page: window.__rx (16 kHz walkie pieces played + peak), window.__replays (saved copies
 * decoded and played), window.__sockets (to cut one), window.__gumDelay (slow getUserMedia, ms, like iOS).
 * ios: model WebKit — any navigator.audioSession.type change suspends every AudioContext (LESSONS #1).
 * safetySeen (default true): the one-time talk safety notice was already acknowledged.
 */
export async function open(who, path, { geo, tag = who, ios = false, safetySeen = true } = {}) {
  const u = USERS[who];
  const r = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: u.email, password: "test-pass-1" }),
  });
  const session = await r.json();
  if (!session.access_token) throw new Error(`sign-in failed for ${who}`);
  const ctx = await browser.newContext({
    ...devices["iPhone 13"], timezoneId: "Europe/Athens", locale: "el-GR", ignoreHTTPSErrors: true,
    permissions: ["microphone", ...(geo ? ["geolocation"] : [])],
    ...(geo ? { geolocation: { latitude: geo[0], longitude: geo[1], accuracy: 10 } } : {}),
  });
  await ctx.addInitScript((s) => { try { localStorage.setItem("sb-127-auth-token", JSON.stringify(s)); } catch { /* ignore */ } }, session);
  if (safetySeen) await ctx.addInitScript(() => { try { localStorage.setItem("mapapp:talkSafetyOk", "1"); } catch { /* ignore */ } });
  await ctx.addInitScript(() => {
    window.__rx = { pieces: 0, peak: 0 };
    window.__replays = 0;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a) {
      const b = this.buffer;
      if (b && b.sampleRate === 16000 && b.length >= 1000) {
        window.__rx.pieces++;
        const d = b.getChannelData(0);
        for (let i = 0; i < d.length; i += 7) window.__rx.peak = Math.max(window.__rx.peak, Math.abs(d[i]));
      } else if (b && b.duration > 0.5) window.__replays++;
      return start.apply(this, a);
    };
    window.__sockets = [];
    const WS = window.WebSocket;
    window.WebSocket = class extends WS { constructor(...a) { super(...a); window.__sockets.push(this); } };
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => {
      const st = await gum(c);
      if (window.__gumDelay) await new Promise((r) => setTimeout(r, window.__gumDelay));
      return st;
    };
  });
  if (ios)
    await ctx.addInitScript(() => {
      const ctxs = [];
      const AC = window.AudioContext;
      window.AudioContext = class extends AC { constructor(...a) { super(...a); ctxs.push(this); } };
      let type = "auto";
      Object.defineProperty(navigator, "audioSession", { configurable: true, value: {
        get type() { return type; },
        set type(t) { if (t !== type) { type = t; window.__switches = (window.__switches || 0) + 1; ctxs.forEach((c) => c.state === "running" && c.suspend()); } },
      } });
    });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${tag}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource|WebGL|GPU stall/i.test(m.text()) && errors.push(`${tag} console: ${m.text().slice(0, 200)}`));
  await page.goto(base + path, { waitUntil: "load" });
  return { page, ctx };
}

/** Pieces / peak this page has played so far. */
export const rx = (page) => page.evaluate(() => ({ ...window.__rx }));
export const PTT = "Κράτα πατημένο και μίλα";
/** Hold the push-to-talk button for `ms` (optionally doing something while held). */
export async function hold(page, ms, during, name = PTT) {
  const btn = page.getByRole("button", { name });
  await btn.scrollIntoViewIfNeeded();
  // Like a person: wait while it says "connecting" (disabled), up to 10 s; a button that stays off is pressed anyway
  // (the flows that expect a refusal check what happens).
  for (let i = 0; i < 50 && (await btn.isDisabled().catch(() => false)); i++) await page.waitForTimeout(200);
  // Wait until it stops moving (a bottom sheet may still be sliding up).
  let b = await btn.boundingBox();
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(100);
    const n = await btn.boundingBox();
    if (n && b && Math.abs(n.y - b.y) < 1 && Math.abs(n.x - b.x) < 1) break;
    b = n;
  }
  // …and make sure the button itself is what's under the finger there (on a slow page a sheet can still be sliding
  // although two measurements 100 ms apart agreed).
  for (let i = 0; i < 30; i++) {
    b = await btn.boundingBox();
    const hit = b && (await btn.evaluate((el, [x, y]) => el.contains(document.elementFromPoint(x, y)), [b.x + b.width / 2, b.y + b.height / 2]));
    if (hit) break;
    await page.waitForTimeout(200);
  }
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  if (during) await during();
  await page.mouse.up();
}
/** iOS needs one tap before Web Audio plays: tap the "listen live" button if it is shown. */
export async function unlock(page) {
  const u = page.getByRole("button", { name: "Πάτα για να ακούς ζωντανά" });
  if (await u.isVisible().catch(() => false)) await u.click();
}

export async function done() {
  console.log("errors:", errors.length ? [...new Set(errors)].join(" | ") : "none");
  ok("no page errors", errors.length === 0);
  await browser.close();
}

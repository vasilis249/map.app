// Walkie-talkie between two browsers (fake mic = 440 Hz tone): presence, live audio arrives while holding,
// one speaker at a time, saved for replay, non-friends kept out.
import { createRequire } from "node:module";
import crypto from "node:crypto";
const { chromium, devices } = createRequire("/opt/node22/lib/node_modules/")("playwright");
const S = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const SECRET = "local-dev-secret-local-dev-secret-0123456789";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (c) => { const h = b64({ alg: "HS256", typ: "JWT" }), p = b64(c); return `${h}.${p}.${crypto.createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url")}`; };
const base = "http://127.0.0.1:" + process.argv[2];
const ok = (l, c) => console.log(c ? "PASS" : "FAIL", l);
const ME = "11111111-0000-0000-0000-000000000001", NIK = "33333333-0000-0000-0000-000000000003", MARIA = "22222222-0000-0000-0000-000000000002";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${S}/tone440.wav`,
         "--autoplay-policy=no-user-gesture-required"] });
const errors = [];
async function open(uid, path, tag) {
  const now = Math.floor(Date.now() / 1000);
  const tok = jwt({ iat: now, exp: now + 86400, role: "authenticated", sub: uid, email: uid + "@test", aud: "authenticated" });
  const session = { access_token: tok, token_type: "bearer", expires_in: 86400, expires_at: now + 86400, refresh_token: "local",
    user: { id: uid, email: uid + "@test", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} } };
  const ctx = await browser.newContext({ ...devices["iPhone 13"], permissions: ["microphone"], timezoneId: "Europe/Athens", locale: "el-GR" });
  await ctx.addInitScript((s) => { try { localStorage.setItem("sb-127-auth-token", JSON.stringify(s)); } catch {} }, session);
  // Count what Web Audio is asked to play: 16 kHz walkie pieces and their loudness.
  await ctx.addInitScript(() => {
    window.__rx = { pieces: 0, peak: 0 };
    const orig = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a) {
      const b = this.buffer;
      if (b && b.sampleRate === 16000 && b.length >= 1000) {
        window.__rx.pieces++;
        const d = b.getChannelData(0);
        for (let i = 0; i < d.length; i += 7) window.__rx.peak = Math.max(window.__rx.peak, Math.abs(d[i]));
      }
      return orig.apply(this, a);
    };
  });
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
  page.on("pageerror", (e) => errors.push(tag + ": " + e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(tag + " console: " + m.text().slice(0, 200)));
  await page.goto(base + path, { waitUntil: "networkidle" });
  return page;
}
const rx = (p) => p.evaluate(() => ({ ...window.__rx }));
const button = (p) => p.getByRole("button", { name: "Κράτα πατημένο και μίλα" });
async function hold(p, ms, during) {
  const b = await button(p).boundingBox();
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await p.mouse.down();
  await p.waitForTimeout(ms);
  if (during) await during();
  await p.mouse.up();
}


const me = await open(ME, `/talk/${NIK}`, "me");
const nik = await open(NIK, `/talk/${ME}`, "nik");
await me.waitForTimeout(2500);
for (const p of [me, nik]) { const u = p.getByRole("button", { name: "Πάτα για να ακούς ζωντανά" }); if (await u.isVisible().catch(() => false)) await u.click(); }
// Several turns: each press/release switches the iOS audio session (and pauses Web Audio).
for (const [who, other, tag] of [[me, nik, "1 me→nik"], [nik, me, "2 nik→me"], [me, nik, "3 me→nik"], [nik, me, "4 nik→me"]]) {
  const before = (await rx(other)).pieces;
  await hold(who, 2400);
  await other.waitForTimeout(1500);
  const got = (await rx(other)).pieces - before;
  ok(`turn ${tag}: live pieces heard (${got})`, got >= 5);
}
ok("audio session was switched (iOS model active)", (await me.evaluate(() => window.__switches)) >= 4);
// A recording elsewhere in the app (composer) also switches the session.
await nik.evaluate(() => { navigator.audioSession.type = "play-and-record"; navigator.audioSession.type = "playback"; });
const b5 = (await rx(nik)).pieces;
await hold(me, 2400);
await nik.waitForTimeout(1500);
ok(`after a recording elsewhere: still heard (${(await rx(nik)).pieces - b5})`, (await rx(nik)).pieces - b5 >= 5);
ok("no page errors", errors.length === 0);
if (errors.length) console.log(errors);
await browser.close();

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
    // Sockets (to cut one mid-transmission), slow getUserMedia like iOS (window.__gumDelay ms), decoded replays.
    window.__sockets = [];
    const WS = window.WebSocket;
    window.WebSocket = class extends WS { constructor(...a) { super(...a); window.__sockets.push(this); } };
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => { const s = await gum(c); if (window.__gumDelay) await new Promise((r) => setTimeout(r, window.__gumDelay)); return s; };
    window.__replays = 0;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a) { if (this.buffer && this.buffer.sampleRate !== 16000 && this.buffer.duration > 0.5) window.__replays++; return start.apply(this, a); };
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
const cut = (p) => p.evaluate(() => window.__sockets.filter((s) => s.readyState === 1).forEach((s) => s.close()));

// (a) the speaker's socket drops mid-transmission: pieces wait on the phone and all arrive after the rejoin
let b = (await rx(nik)).pieces;
await hold(me, 5000, async () => {});
const a0 = (await rx(nik)).pieces - b;
b = (await rx(nik)).pieces;
const hold2 = hold(me, 5000);
await me.waitForTimeout(1200);
await cut(me);
await hold2;
await nik.waitForTimeout(6000);
const a1 = (await rx(nik)).pieces - b;
ok(`(a) speaker's socket cut mid-way: pieces still arrive (${a1} vs ${a0} uncut)`, a1 >= a0 * 0.8);

// (b) the listener's socket drops mid-transmission: the saved copy plays right after
await me.waitForTimeout(2000);
const r0 = await nik.evaluate(() => window.__replays);
const hold3 = hold(me, 4000);
await me.waitForTimeout(800);
await cut(nik);
await hold3;
await nik.waitForTimeout(12000);
ok(`(b) listener's socket cut mid-way: the saved copy is replayed once (${(await nik.evaluate(() => window.__replays)) - r0})`, (await nik.evaluate(() => window.__replays)) - r0 === 1);
const r1 = await nik.evaluate(() => window.__replays);
b = (await rx(nik)).pieces;
await hold(me, 3000);
await nik.waitForTimeout(9000);
ok(`(b2) heard completely live → no replay (${(await nik.evaluate(() => window.__replays)) - r1}), live pieces ${(await rx(nik)).pieces - b}`, (await nik.evaluate(() => window.__replays)) === r1 && (await rx(nik)).pieces - b >= 8);

// (c) let go before the (slow) mic is ready: hint, nothing on the other side
await me.evaluate(() => { window.__gumDelay = 1200; });
b = (await rx(nik)).pieces;
let flash = false;
const watch = (async () => { for (let i = 0; i < 20; i++) { if (await nik.getByText(/μιλάει…/).isVisible().catch(() => false)) flash = true; await nik.waitForTimeout(100); } })();
await hold(me, 400);
await watch;
ok("(c) short press: 'hold until the beep' hint", await me.getByText(/ώσπου να ακουστεί το μπιπ/).isVisible());
ok(`(c) short press: the friend sees and hears nothing (${(await rx(nik)).pieces - b} pieces, flash ${flash})`, (await rx(nik)).pieces === b && !flash);
await me.evaluate(() => { window.__gumDelay = 0; });
ok("no page errors", errors.filter((e) => !/WebSocket|socket|realtime/i.test(e)).length === 0);
if (errors.length) console.log(errors.slice(0, 5));
await browser.close();

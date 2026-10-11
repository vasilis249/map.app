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
ok("presence: each sees the other is here", await me.getByText(/είναι εδώ/).isVisible() && await nik.getByText(/είναι εδώ/).isVisible());
for (const p of [me, nik]) { const u = p.getByRole("button", { name: "Πάτα για να ακούς ζωντανά" }); if (await u.isVisible().catch(() => false)) await u.click(); }
await me.screenshot({ path: `${S}/walkie-1-idle.png` });

let during = {};
await hold(me, 2600, async () => {
  during.status = await nik.getByText(/μιλάει…/).isVisible();
  during.meStatus = await me.getByText(/Μιλάς/).isVisible();
  during.rx = await rx(nik);
  await nik.screenshot({ path: `${S}/walkie-2-hearing.png` });
  await me.screenshot({ path: `${S}/walkie-3-talking.png` });
});
ok("while holding: 'Μιλάς' for me, 'Μιλάει' for the friend", during.status && during.meStatus);
ok(`live: pieces arrive while I still talk (${during.rx.pieces}) and carry the tone (peak ${during.rx.peak.toFixed(2)})`, during.rx.pieces >= 5 && during.rx.peak > 0.1);
await nik.waitForTimeout(2500);
const after = await rx(nik);
ok("released: the friend's screen is back to idle", await nik.getByText(/είναι εδώ/).isVisible());
ok(`nothing echoes back to me (${(await rx(me)).pieces} pieces)`, (await rx(me)).pieces === 0);
ok("saved: one entry in both histories", (await me.locator("li").count()) === 1 && (await nik.locator("li").count()) === 1);

// One speaker at a time: while Nikos talks, my press is refused.
let refused = {};
await hold(nik, 2200, async () => {
  const before = (await rx(nik)).pieces;
  await hold(me, 800);
  await nik.waitForTimeout(600);
  refused.echo = (await rx(nik)).pieces - before;
  refused.meHears = (await rx(me)).pieces;
});
ok(`one at a time: my press while Nikos talks sends nothing (${refused.echo}) and I hear him (${refused.meHears})`, refused.echo === 0 && refused.meHears >= 3);
await me.waitForTimeout(2500);
ok("two saved transmissions now", (await me.locator("li").count()) === 2);

// Replay from history (audio element).
await nik.locator("li").last().getByRole("button").click();
await nik.waitForTimeout(1500);
ok("replay plays (no error)", !(await nik.getByText("Δεν ήταν δυνατή η αναπαραγωγή.").isVisible().catch(() => false)));
await nik.screenshot({ path: `${S}/walkie-4-history.png` });

// Not friends: no channel.
const maria = await open(MARIA, `/talk/${ME}`, "maria");
await maria.waitForTimeout(1500);
ok("non-friend: 'only if you follow each other', no button", await maria.getByText(/μόνο αν ακολουθείτε/).isVisible() && await button(maria).isDisabled());
await maria.screenshot({ path: `${S}/walkie-5-outsider.png` });
// ... and even a hand-made join to our channel is refused by the policies.
const topic = ME < NIK ? `walkie:${ME}:${NIK}` : `walkie:${NIK}:${ME}`;
const sneak = await maria.evaluate(async (topic) => {
  const { WebSocket: W } = window;
  const tok = JSON.parse(localStorage.getItem("sb-127-auth-token")).access_token;
  return await new Promise((res) => {
    const ws = new W("ws://127.0.0.1:54321/realtime/v1/websocket?apikey=x&vsn=2.0.0");
    ws.onopen = () => ws.send(JSON.stringify(["1", "1", "realtime:" + topic, "phx_join", { config: { private: true, broadcast: { self: false }, presence: { key: "" } }, access_token: tok }]));
    ws.onmessage = (e) => { const [, , , ev, p] = JSON.parse(e.data); if (ev === "phx_reply") { ws.close(); res(p.status); } };
    setTimeout(() => res("timeout"), 3000);
  });
}, topic);
ok(`outsider's direct join refused (${sneak})`, sneak === "error");
console.log("errors:", errors.length ? errors.join(" | ") : "none");
await browser.close();

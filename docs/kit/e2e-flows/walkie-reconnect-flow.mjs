// Walkie W3: an open channel comes back after the network drops; unheard badge on the Messages walkie button.
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



const me = await open(ME, "/talk", "me");
await me.waitForTimeout(1200);
const row = me.locator("li", { hasText: "Νίκος" }).first();
await row.getByRole("switch").click();
await me.waitForTimeout(1200);
await me.goto(base + "/", { waitUntil: "networkidle" });
await me.waitForTimeout(1500);
await me.mouse.click(200, 300);
const nik = await open(NIK, `/talk/${ME}`, "nik");
await nik.waitForTimeout(2500);
ok("before: Νίκος sees me here", await nik.getByText(/είναι εδώ/).isVisible());
await me.context().setOffline(true);
await me.waitForTimeout(6000);
console.log("info: offline emulation keeps open WebSockets; away shown =", await nik.getByText(/λείπει/).isVisible());
await me.context().setOffline(false);
await me.waitForTimeout(9000);
ok("back online: Νίκος sees me here again", await nik.getByText(/είναι εδώ/).isVisible());
const u = nik.getByRole("button", { name: "Πάτα για να ακούς ζωντανά" }); if (await u.isVisible().catch(() => false)) await u.click();
const before = await rx(me);
let banner = false;
await hold(nik, 2000, async () => { banner = await me.getByText("Νίκος σου μιλάει").isVisible().catch(() => false); });
await me.waitForTimeout(800);
const after = await rx(me);
ok(`after reconnect: banner + live pieces (${after.pieces - before.pieces})`, banner && after.pieces - before.pieces >= 4);
await me.waitForTimeout(2500);
await me.goto(base + "/messages", { waitUntil: "networkidle" });
await me.waitForTimeout(1500);
const badge = (await me.locator('a[href="/talk"]').innerText().catch(() => "")).replace("Walkie-talkie", "");
ok(`Messages: walkie button shows 1 unheard ("${badge.trim()}")`, badge.trim() === "1");
await me.screenshot({ path: `${S}/walkie3-messages.png` });
console.log("errors:", errors.length ? errors.join(" | ") : "none");
await browser.close();

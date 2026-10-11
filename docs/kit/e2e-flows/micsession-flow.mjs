import { createRequire } from "node:module";
import crypto from "node:crypto";
const { chromium, devices } = createRequire("/opt/node22/lib/node_modules/")("playwright");
const S = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const SECRET = "local-dev-secret-local-dev-secret-0123456789";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (c) => { const h = b64({ alg: "HS256", typ: "JWT" }), p = b64(c); return `${h}.${p}.${crypto.createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url")}`; };
const base = "http://127.0.0.1:" + process.argv[2], RID = process.argv[3];
const ok = (l, c) => console.log(c ? "PASS" : "FAIL", l);
const ME = "11111111-0000-0000-0000-000000000001";
const now = Math.floor(Date.now() / 1000);
const tok = jwt({ iat: now, exp: now + 86400, role: "authenticated", sub: ME, email: "me@test", aud: "authenticated" });
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
const errors = [];
const session = { access_token: tok, token_type: "bearer", expires_in: 86400, expires_at: now + 86400, refresh_token: "local",
  user: { id: ME, email: "me@test", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} } };
const ctx = await browser.newContext({ ...devices["iPhone 13"], permissions: ["microphone"], timezoneId: "Europe/Athens", locale: "el-GR" });
await ctx.addInitScript((s) => { try { localStorage.setItem("sb-127-auth-token", JSON.stringify(s)); } catch {} }, session);
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(e.message));
const shot = async (n) => { await page.waitForTimeout(700); await page.screenshot({ path: `${S}/micsession-${n}.png` }); };
async function hold(loc, ms, during) {
  const b = await loc.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  if (during) await during();
  await page.mouse.up();
  await page.waitForTimeout(700);
}
// 1. composer
// iOS WebKit: an open walkie channel leaves navigator.audioSession = 'playback', where getUserMedia is refused.
await ctx.addInitScript(() => {
  const s = { type: "playback" };
  Object.defineProperty(navigator, "audioSession", { value: s, configurable: true });
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.__micLog = [];
  navigator.mediaDevices.getUserMedia = (c) => {
    window.__micLog.push(s.type);
    if (s.type === "playback") return Promise.reject(new DOMException("capture not allowed", "NotAllowedError"));
    if (window.__busy) return Promise.reject(new DOMException("in use", "NotReadableError"));
    return real(c);
  };
});
await page.goto(base + "/record", { waitUntil: "networkidle" });
await page.waitForTimeout(600);
await hold(page.getByRole("button", { name: "Κράτα πατημένο και μίλα" }), 1500);
ok("composer records under a 'playback' session", await page.getByText("Ξανά").isVisible() && !(await page.getByText("Δώσε πρόσβαση στο μικρόφωνο").isVisible().catch(() => false)));
ok("asked the mic in play-and-record, session back to playback after", await page.evaluate(() => window.__micLog.at(-1) === "play-and-record" && navigator.audioSession.type === "playback"));
await page.getByText("Ξανά").click();
await page.evaluate(() => { window.__busy = true; });
await hold(page.getByRole("button", { name: "Κράτα πατημένο και μίλα" }), 1200);
ok("mic in use → 'busy' toast, not 'go to Settings'", await page.getByText("Το μικρόφωνο χρησιμοποιείται αλλού").isVisible() && !(await page.getByText("Δώσε πρόσβαση στο μικρόφωνο").isVisible()));
ok("session restored after a failure too", await page.evaluate(() => navigator.audioSession.type === "playback"));
await shot("busy");
ok("no page errors", errors.length === 0);
if (errors.length) console.log(errors);
await browser.close();

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
const shot = async (n) => { await page.waitForTimeout(700); await page.screenshot({ path: `${S}/ptt-${n}.png` }); };
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
await page.goto(base + "/record", { waitUntil: "networkidle" });
await page.waitForTimeout(600);
const ptt = page.getByRole("button", { name: "Κράτα πατημένο και μίλα" });
await shot("1-idle");
await hold(ptt, 200);
ok("quick tap: hint, nothing recorded", await page.getByText("Κράτα πατημένο και μίλα").first().isVisible() && !(await page.getByRole("button", { name: /Αναπαραγωγή|Play/ }).isVisible().catch(() => false))
  && await page.getByRole("button", { name: "Δημοσίευση" }).isDisabled());
await hold(ptt, 2200, async () => {
  ok("while holding: coral, live timer, 'let go' hint", await page.getByText("Άφησε για να σταματήσεις").isVisible());
  await shot("2-holding");
});
ok("released: recorded, play + again", await page.getByText("Ξανά").isVisible() && await page.getByRole("button", { name: "Δημοσίευση" }).isEnabled());
await shot("3-recorded");
await page.getByRole("button", { name: "Δημοσίευση" }).click();
await page.waitForURL(/\/p\//);
ok("published", true);

// 2. nav: tap from News · Tech → composer with Tech chosen
await page.goto(base + "/?s=career", { waitUntil: "networkidle" });
await page.waitForTimeout(700);
const nav = page.getByRole("button", { name: "Νέα φωνή (κράτα πατημένο για να μιλήσεις)" });
await hold(nav, 150);
await page.waitForTimeout(500);
ok("nav tap → composer, Καριέρα preselected", /\/record/.test(page.url()) && (await page.getByRole("button", { name: "Καριέρα" }).getAttribute("aria-pressed")) === "true");

// 3. nav: hold from Following → composer with the voice ready, Personal
await page.goto(base + "/?tab=following", { waitUntil: "networkidle" });
await page.waitForTimeout(700);
await hold(page.getByRole("button", { name: "Νέα φωνή (κράτα πατημένο για να μιλήσεις)" }), 2000, async () => {
  ok("nav hold: floating timer over the nav", await page.getByText("άφησε για συνέχεια").isVisible());
  await shot("4-nav-holding");
});
await page.waitForTimeout(600);
ok("let go → composer with the voice ready, Personal", /\/record/.test(page.url()) && await page.getByText("Ξανά").isVisible()
  && (await page.getByRole("button", { name: "Προσωπική" }).getAttribute("aria-pressed")) === "true");
await shot("5-nav-handoff");
await page.getByRole("button", { name: "Δημοσίευση" }).click();
await page.waitForURL(/\/p\//);
await page.goto(base + "/?tab=following", { waitUntil: "networkidle" });
await page.waitForTimeout(800);
ok("the nav voice is under Following", (await page.locator("article").count()) >= 2);

// 4. DMs
await page.goto(base + "/messages/33333333-0000-0000-0000-000000000003", { waitUntil: "networkidle" });
await page.waitForTimeout(800);
const dm = page.getByRole("button", { name: "Κράτα πατημένο και μίλα" });
await hold(dm, 1500, async () => ok("DM: holding shows the timer", await page.getByText("/ 2:00").isVisible() || await page.getByText(/\/ 1:00/).isVisible()));
await shot("6-dm-recorded");
await page.getByRole("button", { name: "Αποστολή" }).click();
await page.waitForTimeout(1200);
ok("DM sent", !(await page.getByRole("button", { name: "Αποστολή" }).isVisible()));
await shot("7-dm-sent");
console.log("errors:", errors.length ? [...new Set(errors)] : "none");
await browser.close();

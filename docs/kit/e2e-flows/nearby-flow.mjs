// Push to talk on the map between two strangers ~100 m apart (fake mic = 440 Hz): knock → the other phone joins and
// hears it live anywhere in the app (banner), answer from the banner, saved + notice, "nobody" setting, server refusal.
import { createRequire } from "node:module";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
const { chromium, devices } = createRequire("/opt/node22/lib/node_modules/")("playwright");
const S = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const SECRET = "local-dev-secret-local-dev-secret-0123456789";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (c) => { const h = b64({ alg: "HS256", typ: "JWT" }), p = b64(c); return `${h}.${p}.${crypto.createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url")}`; };
const base = "http://127.0.0.1:" + process.argv[2];
const ok = (l, c) => console.log(c ? "PASS" : "FAIL", l);
const sql = (q) => execSync(`psql -h /tmp -p 54329 -U postgres -d courtsie -Atc "${q.replace(/"/g, '\\"')}"`).toString().trim();
const ME = "11111111-0000-0000-0000-000000000001", GIO = "44444444-0000-0000-0000-000000000004", ELENI = "55555555-0000-0000-0000-000000000005";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${S}/tone440.wav`,
         "--autoplay-policy=no-user-gesture-required", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const errors = [];
async function open(uid, path, tag, lat) {
  const now = Math.floor(Date.now() / 1000);
  const tok = jwt({ iat: now, exp: now + 86400, role: "authenticated", sub: uid, email: uid + "@test", aud: "authenticated" });
  const session = { access_token: tok, token_type: "bearer", expires_in: 86400, expires_at: now + 86400, refresh_token: "local",
    user: { id: uid, email: uid + "@test", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} } };
  const ctx = await browser.newContext({ ...devices["iPhone 13"], permissions: ["microphone", "geolocation"], timezoneId: "Europe/Athens", locale: "el-GR",
    geolocation: { latitude: lat, longitude: 23.7348, accuracy: 10 } });
  await ctx.addInitScript((s) => { try { localStorage.setItem("sb-127-auth-token", JSON.stringify(s)); } catch {} }, session);
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
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource|tiles\.openfreemap|WebGL|maplibre/i.test(m.text()) && errors.push(tag + " console: " + m.text().slice(0, 200)));
  await page.goto(base + path, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  return page;
}
const rx = (p) => p.evaluate(() => ({ ...window.__rx }));
const hold = async (p, ms) => {
  const b = await p.getByRole("button", { name: "Κράτα πατημένο και μίλα" }).boundingBox();
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await p.mouse.down();
  await p.waitForTimeout(ms);
  await p.mouse.up();
};

// Clean slate; everyone shares with everyone; Eleni (110 m south) takes voices from nobody.
sql(`delete from public.nearby_messages; delete from private.nearby_knocks; delete from public.notifications where kind = 'nearby'; delete from private.rate_events`);
sql(`insert into public.location_sharing (user_id, mode, talk_from) values ('${ME}', 'everyone', 'everyone'), ('${GIO}', 'everyone', 'everyone'), ('${ELENI}', 'everyone', 'nobody')
     on conflict (user_id) do update set mode = excluded.mode, talk_from = excluded.talk_from`);
sql(`insert into private.user_locations (user_id, lat, lng) values ('${ELENI}', 37.9745, 23.7348) on conflict (user_id) do update set lat = excluded.lat, updated_at = now()`);

const gio = await open(GIO, "/", "gio", 37.9764);
const me = await open(ME, "/map", "me", 37.9755);
await me.waitForTimeout(6000);
await gio.mouse.click(200, 400); // a tap anywhere: iOS-style sound unlock
ok("both positions stored (tracker)", sql(`select count(*) from private.user_locations where user_id in ('${ME}','${GIO}')`) === "2");

// Me → Giorgos (strangers are on the "Κοντά μου" view)
await me.getByRole("tab", { name: "Κοντά μου" }).click();
await me.waitForTimeout(1000);
await me.getByRole("button", { name: "Γιώργος Κ." }).click();
await me.waitForTimeout(1500);
ok("his card has the push-to-talk button", await me.getByRole("button", { name: "Κράτα πατημένο και μίλα" }).isEnabled());
await me.screenshot({ path: `${S}/nearby-1-card.png` });
const before = await rx(gio);
const b = await me.getByRole("button", { name: "Κράτα πατημένο και μίλα" }).boundingBox();
await me.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
await me.mouse.down();
await me.waitForTimeout(3500);
const banner = await gio.getByText("Βασίλης σου μιλάει").isVisible().catch(() => false);
await gio.screenshot({ path: `${S}/nearby-2-banner.png` });
await me.screenshot({ path: `${S}/nearby-3-talking.png` });
await me.mouse.up();
await me.waitForTimeout(2500);
const after = await rx(gio);
ok("the knock opened Giorgos's side while he is on Home: banner 'Βασίλης σου μιλάει'", banner);
ok(`he heard it live (pieces ${after.pieces - before.pieces}, peak ${after.peak.toFixed(2)})`, after.pieces - before.pieces >= 6 && after.peak > 0.1);
ok("saved for 24 h + a 'nearby' notice for him", sql(`select count(*) from public.nearby_messages where sender_id='${ME}' and recipient_id='${GIO}'`) === "1"
  && sql(`select count(*) from public.notifications where user_id='${GIO}' and kind='nearby'`) === "1");

// Giorgos answers from his side (banner is gone; open the map card via ?u=)
await gio.goto(base + `/map?u=${ME}`, { waitUntil: "load" }); // tiles never load here: no networkidle
await gio.waitForTimeout(5000);
ok("his map card for me shows the saved transmission", await gio.getByText("Τελευταίες 24 ώρες").isVisible());
const meBefore = await rx(me);
await hold(gio, 3000);
await gio.waitForTimeout(2500);
const meAfter = await rx(me);
ok(`my phone heard his answer live (pieces ${meAfter.pieces - meBefore.pieces})`, meAfter.pieces - meBefore.pieces >= 6);
ok("my card lists both transmissions", (await me.getByText(/^(Εσύ|Γιώργος)$/).count()) >= 2);
await me.screenshot({ path: `${S}/nearby-4-history.png` });

// Eleni takes voices from nobody → disabled with a reason
await me.keyboard.press("Escape");
await me.waitForTimeout(600);
await me.getByRole("button", { name: "Ελένη Μ." }).click();
await me.waitForTimeout(1000);
ok("Eleni ('nobody'): button disabled, 'δεν δέχεται φωνές'", await me.getByRole("button", { name: "Κράτα πατημένο και μίλα" }).isDisabled()
  && await me.getByText(/δεν δέχεται φωνές/).isVisible());
await me.screenshot({ path: `${S}/nearby-5-nobody.png` });

// Server refusal: Giorgos switches to "nobody" and the answer window is closed; my open card still has the button
await me.keyboard.press("Escape");
await me.waitForTimeout(600);
await me.getByRole("button", { name: "Γιώργος Κ." }).click();
await me.waitForTimeout(1500);
sql(`update public.location_sharing set talk_from='nobody' where user_id='${GIO}'`);
sql(`delete from private.nearby_knocks`);
const g2 = await rx(gio);
await hold(me, 1500);
const toastSeen = await me.getByText(/Δεν μπορείς να μιλήσεις/).isVisible().catch(() => false);
await me.screenshot({ path: `${S}/nearby-6-refused.png` });
await me.waitForTimeout(2500);
const g3 = await rx(gio);
ok("refused by the server: toast, nothing heard, nothing saved, button off after the refresh", toastSeen
  && g3.pieces === g2.pieces && sql(`select count(*) from public.nearby_messages where sender_id='${ME}'`) === "1"
  && await me.getByRole("button", { name: "Κράτα πατημένο και μίλα" }).isDisabled());

console.log("errors:", errors.length ? errors.join(" | ") : "none");
await browser.close();

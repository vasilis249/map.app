// Phase 0: sign up with email + password, the profile, a photo, sign out / in, search + follow, security headers.
// Real RLS (PostgREST on the local Postgres), the local GoTrue in local-supabase.mjs.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import zlib from "node:zlib";
const { chromium, devices } = createRequire("/opt/node22/lib/node_modules/")("playwright");
const S = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const base = "http://127.0.0.1:" + process.argv[2];
const ok = (l, c) => console.log(c ? "PASS" : "FAIL", l);
/** Waits until the locator is visible (isVisible() itself never waits). */
const seen = (loc, ms = 8_000) => loc.first().waitFor({ state: "visible", timeout: ms }).then(() => true, () => false);
const sql = (q) => execSync(`psql -h /tmp -p 54329 -U postgres -d mapapp -Atc "${q.replace(/"/g, '\\"')}"`).toString().trim();

// A real 64×64 PNG (red square) for the photo upload.
function png() {
  const w = 64, h = 64;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([220, 40, 40, 255], y * (w * 4 + 1) + 1 + x * 4);
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const errors = [];
const ctx = await browser.newContext({ ...devices["iPhone 13"], timezoneId: "Europe/Athens", locale: "el-GR" });
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource|tiles\.openfreemap|WebGL|maplibre/i.test(m.text()) && errors.push("console: " + m.text().slice(0, 200)));

// 1. Signed out → sign-in screen; headers
const resp = await page.goto(base + "/", { waitUntil: "load" });
await page.waitForURL(/\/login$/, { timeout: 10_000 });
const h = resp.headers();
ok("signed out: / sends you to the sign-in screen", /\/login$/.test(page.url()));
ok("security headers: CSP frame-ancestors none, geolocation + microphone allowed for self", /frame-ancestors 'none'/.test(h["content-security-policy"] ?? "")
  && /geolocation=\(self\)/.test(h["permissions-policy"] ?? "") && /microphone=\(self\)/.test(h["permissions-policy"] ?? ""));

// 2. Wrong password → a translated message, not the raw server text
await page.getByLabel("Email").fill("me@test");
await page.getByLabel("Κωδικός").fill("wrong-password");
await page.getByRole("button", { name: "Σύνδεση" }).last().click();
ok("wrong password: 'Λάθος email ή κωδικός.'", await seen(page.getByText("Λάθος email ή κωδικός.")));

// 3. Sign up
await page.getByRole("link", { name: "Δημιουργία λογαριασμού" }).click();
await page.getByLabel("Όνομα", { exact: true }).fill("Κατερίνα Δήμου");
await page.getByLabel("Όνομα χρήστη").fill("Kat Dimou"); // typed with capitals / a space: normalised
await page.getByLabel("Email").fill("kat@test.gr");
await page.getByLabel("Κωδικός").fill("short");
ok("signup: a 5-character password keeps the button off", await page.getByRole("button", { name: "Δημιουργία λογαριασμού" }).isDisabled());
await page.getByLabel("Κωδικός").fill("kat-secret-9");
ok("signup: without the 18+ declaration the button stays off", await page.getByRole("button", { name: "Δημιουργία λογαριασμού" }).isDisabled());
await page.getByRole("checkbox", { name: /Είμαι 18 ετών/ }).check();
await page.getByRole("button", { name: "Δημιουργία λογαριασμού" }).click();
await page.waitForURL(/\/map/, { timeout: 15_000 });
ok("signed up → on the map", /\/map/.test(page.url()));
ok("profile created with the chosen username and name, 18+ declaration stored",
  sql("select username || '|' || full_name || '|' || (age_confirmed_at is not null) from public.profiles p join auth.users u on u.id = p.id where u.email = 'kat@test.gr'") === "katdimou|Κατερίνα Δήμου|true");
ok("location sharing is OFF by default (map says so)", await seen(page.getByText("Η θέση σου δεν φαίνεται"))
  && sql("select count(*) from public.location_sharing ls join auth.users u on u.id = ls.user_id where u.email = 'kat@test.gr'") === "0");
await page.screenshot({ path: `${S}/auth-1-map.png` });

// 4. Profile: edit bio, photo
await page.getByRole("link", { name: "Προφίλ" }).click();
await page.waitForURL(/\/profile$/);
await page.getByLabel("Λίγα λόγια").fill("Οδηγώ στην Αθήνα 🚕");
await page.getByRole("button", { name: "Αποθήκευση" }).click();
await page.waitForTimeout(800);
ok("bio saved", sql("select bio from public.profiles where username = 'katdimou'") === "Οδηγώ στην Αθήνα 🚕");
await page.locator('input[type="file"]').setInputFiles({ name: "me.png", mimeType: "image/png", buffer: png() });
await page.waitForTimeout(2000);
const avatar = sql("select coalesce(avatar_path, '') from public.profiles where username = 'katdimou'");
const uid = sql("select id from public.profiles where username = 'katdimou'");
ok(`photo uploaded into your own folder as JPEG (${avatar})`, avatar.startsWith(uid + "/") && avatar.endsWith(".jpg")
  && sql(`select count(*) from storage.objects where bucket_id = 'avatars' and name = '${avatar}'`) === "1");
ok("the new photo shows (a decoded image, not a broken icon)", await seen(page.locator(`img[src*="${avatar}"]`))
  && await page.locator(`img[src*="${avatar}"]`).first().evaluate((img) => img.complete && img.naturalWidth > 0));
await page.screenshot({ path: `${S}/auth-2-profile.png` });

// 5. Username taken → translated error
await page.getByLabel("Όνομα χρήστη").fill("vasilis");
await page.getByRole("button", { name: "Αποθήκευση" }).click();
ok("username taken: 'Αυτό το όνομα χρήστη υπάρχει ήδη.'", await seen(page.getByText("Αυτό το όνομα χρήστη υπάρχει ήδη.")));

// 6. Sign out, sign in again (session survives a reload)
await page.getByRole("button", { name: "Αποσύνδεση" }).click();
await page.waitForURL(/\/login$/);
await page.goto(base + "/map", { waitUntil: "load" });
await page.waitForURL(/\/login$/, { timeout: 10_000 });
ok("signed out: the map redirects to sign-in", /\/login$/.test(page.url()));
await page.getByLabel("Email").fill("kat@test.gr");
await page.getByLabel("Κωδικός").fill("kat-secret-9");
await page.getByRole("button", { name: "Σύνδεση" }).last().click();
await page.waitForURL(/\/map/, { timeout: 10_000 });
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(1000);
ok("signed in again, still in after a reload", /\/map/.test(page.url()));

// 7. Search (Greek name → Latin username), profile, follow
await page.getByRole("link", { name: "Αναζήτηση" }).click();
await page.getByRole("searchbox").fill("Νίκος");
await page.getByText("@nikos.georgiou").click();
await page.waitForURL(/\/u\/nikos\.georgiou$/);
await page.getByRole("button", { name: "Ακολούθησε" }).click();
await page.waitForTimeout(800);
ok("follow from the profile (stored, button turns to 'Ακολουθείς')",
  sql(`select count(*) from public.follows where follower_id = '${uid}' and followee_id = '33333333-0000-0000-0000-000000000003'`) === "1"
  && await page.getByRole("button", { name: "Ακολουθείς" }).isVisible());
ok("Nikos got a follow notification", sql(`select count(*) from public.notifications where user_id = '33333333-0000-0000-0000-000000000003' and actor_id = '${uid}' and kind = 'follow'`) === "1");
await page.screenshot({ path: `${S}/auth-3-profile-other.png` });

// 8. Every screen opens (ported kit screens included) without page errors
for (const [path, text] of [["/talk", "Κανένας φίλος ακόμα"], ["/location", "Κανείς (αόρατος)"], ["/notifications", "Ειδοποιήσεις"], ["/talk/33333333-0000-0000-0000-000000000003", "μόνο αν ακολουθείτε"]]) {
  await page.goto(base + path, { waitUntil: "load" });
  ok(`${path} opens ("${text}")`, await seen(page.getByText(text)));
}
await page.screenshot({ path: `${S}/auth-4-walkie-outsider.png` });

// 9. An account without the 18+ declaration (e.g. a future Sign in with Apple): the age gate, then the app
sql(`insert into auth.users (email, raw_user_meta_data, local_password) values ('noage@test', '{"full_name":"Χωρίς Ηλικία"}', encode(sha256('noage-pass-1'), 'hex'))`);
await page.goto(base + "/profile", { waitUntil: "load" });
await page.getByRole("button", { name: "Αποσύνδεση" }).click();
await page.waitForURL(/\/login$/);
await page.getByLabel("Email").fill("noage@test");
await page.getByLabel("Κωδικός").fill("noage-pass-1");
await page.getByRole("button", { name: "Σύνδεση" }).last().click();
ok("no declaration: the age gate instead of the app", await seen(page.getByText("Μόνο για ενήλικες"))
  && !(await page.getByRole("link", { name: "Χάρτης" }).isVisible()));
await page.screenshot({ path: `${S}/auth-5-age-gate.png` });
await page.getByRole("button", { name: "Είμαι 18+" }).click();
ok("confirmed → the app opens, declaration stored", await seen(page.getByRole("link", { name: "Χάρτης" }))
  && sql("select (age_confirmed_at is not null)::text from public.profiles p join auth.users u on u.id = p.id where u.email = 'noage@test'") === "true");

console.log("errors:", errors.length ? [...new Set(errors)].join(" | ") : "none");
ok("no page errors", errors.length === 0);
await browser.close();

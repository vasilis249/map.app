// Phase 6: release requirements. Privacy policy + terms readable without an account (from sign-up); old profile photos
// removed when you change it; nothing polls while the app is in the background; delete your account (App Store
// 5.1.1(v)) → every trace gone, signing in fails.
import fs from "node:fs";
import { base, browser, done, errors, ok, open, png, S, seen, sql, sqlUntil, SUPABASE, USERS } from "./lib.mjs";

const ME = USERS.me.id;
const FILES = `${S}/storage-files/avatars/${ME}`;

// 1. Legal pages, signed out
const anon = await browser.newContext({ locale: "el-GR" });
const pub = await anon.newPage();
pub.on("pageerror", (e) => errors.push(`anon: ${e.message}`));
await pub.goto(base + "/signup", { waitUntil: "load" });
ok("sign-up links the terms and the privacy policy", await seen(pub.getByRole("link", { name: "Όρους χρήσης" }))
  && await seen(pub.getByRole("link", { name: "Πολιτική απορρήτου" })));
await pub.getByRole("link", { name: "Πολιτική απορρήτου" }).click();
ok("privacy policy readable without an account (location, voice, retention, providers, deletion)",
  await seen(pub.getByRole("heading", { name: "Πολιτική απορρήτου" }))
  && await seen(pub.getByText(/μετά από 1 ώρα χωρίς ενημέρωση/)) && await seen(pub.getByText(/αποθηκεύεται για 24 ώρες/))
  && await seen(pub.getByText(/Stadia Maps/).first()) && await seen(pub.getByText(/Διαγραφή λογαριασμού/).first()));
await pub.screenshot({ path: `${S}/release-1-privacy.png`, fullPage: false });
await pub.goto(base + "/terms", { waitUntil: "load" });
ok("terms readable without an account (road safety first)", await seen(pub.getByRole("heading", { name: "Όροι χρήσης" }))
  && await seen(pub.getByText(/Η οδήγηση έχει πάντα προτεραιότητα/)));
await anon.close();

// 2. Profile photo twice: the old one is removed (it would stay public by URL)
const { page, ctx } = await open("me", "/profile", { geo: [37.9755, 23.7348] });
for (const n of [1, 2]) {
  await page.locator('input[type="file"]').setInputFiles({ name: `me${n}.png`, mimeType: "image/png", buffer: png() });
  // (each upload: the new file, the profile pointing at it, then the old one removed)
  await sqlUntil(`select count(*) from storage.objects where bucket_id = 'avatars' and name like '${ME}/%' and name = (select avatar_path from public.profiles where id = '${ME}')`, "1", 10_000);
  await page.waitForTimeout(2000);
}
const objs = sql(`select count(*) from storage.objects where bucket_id = 'avatars' and name like '${ME}/%'`);
const files = fs.existsSync(FILES) ? fs.readdirSync(FILES).filter((f) => !f.endsWith(".type")).length : 0;
const path = sql(`select coalesce(avatar_path, '') from public.profiles where id = '${ME}'`);
const rowName = sql(`select string_agg(name, ',') from storage.objects where name like '${ME}/%'`);
ok(`a new photo replaces the old one: one stored (${objs} row ${rowName.slice(37)}, ${files} file, profile → ${path.slice(37)})`, objs === "1" && files === 1
  && path.startsWith(`${ME}/`) && sql(`select name from storage.objects where name like '${ME}/%'`) === path);

// 3. Battery: nothing polls while the app is in the background, it resumes when back
sql(`insert into public.location_sharing (user_id, mode) values ('${ME}', 'everyone')`);
await page.goto(base + "/map", { waitUntil: "load" });
await page.waitForTimeout(6000);
const calls = [];
page.on("request", (r) => { if (r.url().includes("/rest/v1/")) calls.push(Date.now()); });
await page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
  document.dispatchEvent(new Event("visibilitychange"));
});
const t0 = Date.now();
await page.waitForTimeout(16_000);
const hiddenCalls = calls.filter((t) => t > t0 + 1000).length;
ok(`app in the background: no polling for 15 s (${hiddenCalls} requests; the map polls every 5 s when open)`, hiddenCalls === 0);
await page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  document.dispatchEvent(new Event("visibilitychange"));
});
const t1 = Date.now();
await page.waitForTimeout(7000);
ok("… and back in front: it refreshes again", calls.filter((t) => t > t1).length > 0);

// 4. Delete my account
await page.goto(base + "/profile", { waitUntil: "load" });
await page.getByRole("button", { name: "Διαγραφή λογαριασμού" }).click();
ok("the sheet says what goes, and asks once more", await seen(page.getByText(/Δεν γίνεται αναίρεση/))
  && await seen(page.getByRole("button", { name: "Διαγραφή για πάντα" })));
await page.screenshot({ path: `${S}/release-2-delete.png` });
await page.getByRole("button", { name: "Διαγραφή για πάντα" }).click();
ok("deleted → back at sign-in, told so", await seen(page.getByText("Ο λογαριασμός σου διαγράφηκε."), 10_000)
  && /\/login$/.test(new URL(page.url()).pathname));
ok("nothing of mine left: account, profile, follows, sharing, position, photos (rows and files)",
  sql(`select count(*) from auth.users where id = '${ME}'`) === "0"
  && sql(`select count(*) from public.profiles where id = '${ME}'`) === "0"
  && sql(`select count(*) from public.follows where '${ME}' in (follower_id, followee_id)`) === "0"
  && sql(`select count(*) from public.location_sharing where user_id = '${ME}'`) === "0"
  && sql(`select count(*) from private.user_locations where user_id = '${ME}'`) === "0"
  && sql(`select count(*) from storage.objects where name like '${ME}/%'`) === "0"
  && (!fs.existsSync(FILES) || fs.readdirSync(FILES).filter((f) => !f.endsWith(".type")).length === 0));
const r = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: USERS.me.email, password: "test-pass-1" }) });
ok("signing in with the old password fails", r.status >= 400);
ok("the others are untouched (Nikos, my former friend, still here)", sql(`select count(*) from public.profiles where id = '${USERS.nikos.id}'`) === "1");
void ctx;
await done();

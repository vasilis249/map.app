// Phase 4: navigation in the browser, against the provider mock (recorded Valhalla answers, tests/e2e/routing-mock.mjs).
// Search a place → two route choices → start → heading-up guidance along the recorded route (positions moved by
// Playwright), Greek voice (the browser's speechSynthesis is replaced by a recorder), push to talk with someone 100 m
// away while navigating (guidance waits until the talk ends), leaving the route → automatic new route, arrival, end.
// Also: the provider key never reaches the browser; /api/nav refuses calls without a session.
import fs from "node:fs";
import { base, done, hold, ok, open, S, seen, sql, sqlUntil, SUPABASE, USERS } from "./lib.mjs";

const fx = (n) => JSON.parse(fs.readFileSync(new URL(`../../src/lib/nav/fixtures/${n}.json`, import.meta.url)));
/** The recorded routes' shapes (Valhalla polyline6 → [lat, lng]). */
function decode(str) {
  const out = [];
  let i = 0, lat = 0, lng = 0;
  const next = () => {
    let r = 0, sh = 0, b;
    do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20);
    return r & 1 ? ~(r >> 1) : r >> 1;
  };
  while (i < str.length) { lat += next(); lng += next(); out.push([lat / 1e6, lng / 1e6]); }
  return out;
}
const MAIN = decode(fx("valhalla-athens").trip.legs[0].shape);
const REROUTE = decode(fx("valhalla-athens-reroute").trip.legs[0].shape);
const m = (a, b) => Math.hypot((a[0] - b[0]) * 111_320, (a[1] - b[1]) * 111_320 * Math.cos((a[0] * Math.PI) / 180));
/** Points every ~`step` m along a shape, from `fromM` to `toM` metres. */
function along(shape, fromM, toM, step = 15) {
  const out = [];
  let d = 0;
  for (let i = 1; i < shape.length; i++) {
    const seg = m(shape[i - 1], shape[i]);
    for (let x = 0; x < seg; x += step) {
      const at = d + x;
      if (at >= fromM && at <= toM) {
        const k = x / seg;
        out.push([shape[i - 1][0] + (shape[i][0] - shape[i - 1][0]) * k, shape[i - 1][1] + (shape[i][1] - shape[i - 1][1]) * k]);
      }
    }
    d += seg;
  }
  return out;
}

const ME = USERS.me.id, GIO = USERS.giorgos.id;
await fetch(`${SUPABASE}/routing/_reset`);
const SYNTAGMA = [37.9755, 23.7348];
// Me and Giorgos share with everyone; he stands 100 m south of the route's first stretch.
sql(`insert into public.location_sharing (user_id, mode, talk_from) values ('${ME}', 'everyone', 'everyone'), ('${GIO}', 'everyone', 'everyone')`);

const { page: gio } = await open("giorgos", "/profile", { geo: [37.9746, 23.7356] });
await gio.mouse.click(200, 400); // sound unlock (iOS-style)
const { page: me, ctx } = await open("me", "/map", { geo: SYNTAGMA });
const browserRequests = [];
me.on("request", (r) => browserRequests.push(r.url()));
// The browser's voice → a recorder (each sentence "takes" 1.2 s), and the wake lock → a recorder.
await me.evaluate(() => {
  window.__spoken = [];
  window.__wake = [];
  let cur = null;
  const fake = {
    speak(u) {
      window.__spoken.push({ text: u.text, at: Date.now() });
      cur = u;
      setTimeout(() => { if (cur === u) { cur = null; u.onend?.(); } }, 1200);
    },
    cancel() { if (cur) { window.__spoken.push({ cancel: cur.text, at: Date.now() }); const u = cur; cur = null; u.onerror?.(); } },
    getVoices: () => [],
  };
  Object.defineProperty(window, "speechSynthesis", { configurable: true, value: fake });
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: async () => {
    window.__wake.push("on");
    const s = new EventTarget();
    s.release = async () => window.__wake.push("off");
    return s;
  } } });
});
const spoken = () => me.evaluate(() => window.__spoken.filter((s) => s.text && s.text.trim()).map((s) => s.text));
const goTo = async (p) => ctx.setGeolocation({ latitude: p[0], longitude: p[1], accuracy: 8 });
const camera = () => me.evaluate(() => { const b = document.querySelector("[data-bearing]"); return b ? { bearing: +b.dataset.bearing, pitch: +b.dataset.pitch } : null; });
async function driveAlong(points, ms = 250) {
  for (const p of points) {
    await goTo(p);
    await me.waitForTimeout(ms);
  }
}

// 1. Search
ok("both positions stored", (await sqlUntil(`select count(*) from private.user_locations where user_id in ('${ME}','${GIO}')`, "2")) === "2");
await me.getByRole("button", { name: "Πού πας;" }).click();
await me.getByRole("textbox", { name: "Διεύθυνση ή μέρος" }).fill("κουκ");
ok("search: places as you type (Greek, accents ignored)", await seen(me.getByRole("button", { name: /Κουκάκι.*Αθήνα/ }), 10_000));
await me.screenshot({ path: `${S}/nav-1-search.png` });
await me.getByRole("button", { name: /^Κουκάκι Αθήνα/ }).click();

// 2. Route choices
const preview = me.getByTestId("route-preview");
ok("two routes: time, distance, main road; the fastest marked", await seen(preview.getByRole("button", { name: /10 λ.*2,7 χλμ.*μέσω Χατζηχρήστου.*Ταχύτερη/ }), 10_000)
  && await seen(preview.getByRole("button", { name: /11 λ.*1,9 χλμ.*μέσω Μητροπόλεως/ })));
await preview.getByRole("button", { name: /11 λ/ }).click();
ok("pick the other route", (await preview.getByRole("button", { name: /11 λ/ }).getAttribute("aria-pressed")) === "true");
await preview.getByRole("button", { name: /10 λ/ }).click();
await me.waitForTimeout(800);
await me.screenshot({ path: `${S}/nav-2-routes.png` });

// 3. Start: banner with the first turn, the first sentence, screen kept on
await me.getByRole("button", { name: "Έναρξη" }).click();
ok("navigating: the banner shows the first turn (Amalias)", await seen(me.getByTestId("nav-instruction").filter({ hasText: "Βασιλίσσης Αμαλίας" }), 8_000));
ok("first words: the depart instruction, which names the first turn", await me.waitForFunction(
  () => window.__spoken.some((s) => s.text?.startsWith("Οδηγήστε ανατολή στη Όθωνος. Στη συνέχεια Στρίψτε αριστερά")), null, { timeout: 5_000 }).then(() => true, () => false));
ok("screen kept on (wake lock)", (await me.evaluate(() => window.__wake)).includes("on"));
ok("arrival time and what's left at the bottom", await seen(me.getByTestId("nav-eta").filter({ hasText: /^Άφιξη \d\d:\d\d$/ })) && await seen(me.getByText(/10 λ · 2,7 χλμ/)));
ok("people within 200 m still on the map (Giorgos)", await seen(me.getByRole("button", { name: "Γιώργος Κ." }), 12_000));
await me.screenshot({ path: `${S}/nav-3-start.png` });

// 4. Drive from Syntagma onto the route and along it past two turns (≈ 15 m every 250 ms)
await driveAlong([[37.97535, 23.73425], ...along(MAIN, 0, 330)]);
await me.waitForTimeout(2000);
const said = await spoken();
ok("the turns are announced in order: Vas. Georgiou, then Syntagma square",
  said.indexOf("Στρίψτε αριστερά στη Βασιλέως Γεωργίου Α', ΕΟ54.") > 0
  && said.indexOf("Στρίψτε αριστερά στη Πλατεία Συντάγματος, ΕΟ1.") > said.indexOf("Στρίψτε αριστερά στη Βασιλέως Γεωργίου Α', ΕΟ54."));
ok("the banner moved on (next: Filellinon), with the distance to it", await seen(me.getByTestId("nav-instruction").filter({ hasText: "Φιλελλήνων" }), 5_000)
  && /^\d+ μ$/.test((await me.getByTestId("nav-distance").textContent()) ?? ""));
const cam1 = await camera();
ok(`heading-up, tilted camera (bearing ${cam1?.bearing}°, pitch ${cam1?.pitch}°)`, cam1?.pitch === 50 && cam1.bearing !== 0);
await me.screenshot({ path: `${S}/nav-4-driving.png` });

// 5. Push to talk while navigating: Giorgos waits on the square a little ahead of me; his card from his marker; while I
// hold, the next announcement waits
const ahead = along(MAIN, 380, 400)[0];
await gio.context().setGeolocation({ latitude: ahead[0], longitude: ahead[1], accuracy: 8 });
ok("Giorgos moved a little ahead on my route (his position stored)", (await sqlUntil(
  `select (abs(lat - ${ahead[0]}) < 0.0001 and abs(lng - ${ahead[1]}) < 0.0001)::text from private.user_locations where user_id = '${GIO}'`, "true", 15_000)) === "true");
await me.waitForTimeout(6000); // the map's 5 s refresh
await me.screenshot({ path: `${S}/nav-4a-gio.png` });
await me.getByRole("button", { name: "Γιώργος Κ." }).click({ timeout: 10_000 });
ok("his card opens during navigation, with the push-to-talk button", await seen(me.getByRole("button", { name: "Κράτα πατημένο και μίλα" })));
const before = (await spoken()).length;
let releasedAt = 0;
let heldFrom = 0;
await hold(me, 300, async () => {
  heldFrom = Date.now();
  await me.screenshot({ path: `${S}/nav-4b-talking.png` });
  // Drive on while talking: the "In 400 m, turn left onto Filellinon" alert falls due now.
  for (const p of along(MAIN, 330, 450)) { await goTo(p); await me.waitForTimeout(200); }
  await me.waitForTimeout(800);
});
releasedAt = Date.now();
await me.waitForTimeout(3000);
const log = await me.evaluate(() => window.__spoken);
const alert = log.filter((s) => /^Σε \d+ μέτρα, στρίψτε αριστερά στη Φιλελλήνων\.$/.test(s.text ?? ""));
const duringTalk = log.filter((s) => s.text?.trim() && s.at > heldFrom && s.at < releasedAt - 300);
if (alert.length !== 1 || duringTalk.length) console.log("spoken:", JSON.stringify(log.map((s) => ({ ...s, at: s.at - releasedAt }))));
ok(`guidance waited for the talk: nothing said while I held, the Filellinon alert said after I let go (${alert.length ? alert[0].at - releasedAt : "never"} ms)`,
  duringTalk.length === 0 && alert.length === 1 && alert[0].at >= releasedAt - 300);
ok("… and Giorgos's phone got my voice", (await sqlUntil(`select count(*) from public.nearby_messages where sender_id='${ME}' and recipient_id='${GIO}'`, "1")) === "1");
ok("… nothing was said twice", (await spoken()).length - before === new Set((await spoken()).slice(before)).size);
await me.keyboard.press("Escape");
await me.waitForTimeout(600);

// 6. Leave the route: straight on east into the garden instead of following it → new route, said and drawn
const routeCalls = async () => (await (await fetch(`${SUPABASE}/routing/_log`)).json()).filter((e) => e.path === "/route/v1").length;
const callsBefore = await routeCalls();
// From just before the turn, head east (the turn is to the left, i.e. south-east here… we go the other way).
const here = along(MAIN, 660, 700)[0];
let offShown = false;
for (let i = 1; i <= 16; i++) {
  await goTo([here[0] + i * 0.0001, here[1] + i * 0.00035]);
  await me.waitForTimeout(500);
  offShown ||= await me.getByTestId("nav-banner").filter({ hasText: /Εκτός διαδρομής|Νέα διαδρομή…/ }).isVisible().catch(() => false);
}
ok("off the route → the banner says so / asks for a new route", offShown);
ok("one new route request", (await routeCalls()) === callsBefore + 1);
await driveAlong(along(REROUTE, 0, 30), 300);
ok("'Νέα διαδρομή.' said", await me.waitForFunction(() => window.__spoken.some((s) => s.text === "Νέα διαδρομή."), null, { timeout: 8_000 }).then(() => true, () => false));
ok("the banner follows the new route (next: Vasilissis Sofias)", await seen(me.getByTestId("nav-instruction").filter({ hasText: "Βασιλίσσης Σοφίας" }), 8_000));
await me.screenshot({ path: `${S}/nav-5-rerouted.png` });

// 7. Arrival (jump ahead along the new route, as if after a few minutes)
const total = (() => { let d = 0; for (let i = 1; i < REROUTE.length; i++) d += m(REROUTE[i - 1], REROUTE[i]); return d; })();
await driveAlong(along(REROUTE, total - 400, total, 20), 250);
await goTo(REROUTE.at(-1));
ok("arrived: banner 'Έφτασες' + the destination", await seen(me.getByTestId("nav-banner").or(me.getByRole("status")).filter({ hasText: "Έφτασες" }), 8_000));
ok("… and the voice says so", (await spoken()).includes("Ο προορισμός σας βρίσκεται δεξιά."));
await me.screenshot({ path: `${S}/nav-6-arrived.png` });
await me.getByRole("button", { name: "Τέλος" }).click();
await me.waitForTimeout(1000);
ok("end: back to the map (search shown, flat north-up camera), screen may sleep again", await seen(me.getByRole("button", { name: "Πού πας;" }))
  && (await me.evaluate(() => window.__wake)).at(-1) === "off" && (await camera())?.pitch === 0 && (await camera())?.bearing === 0);

// 8. Privacy / security
const provider = (await (await fetch(`${SUPABASE}/routing/_log`)).json());
// (answers cached at the edge by an earlier run don't reach the provider again)
ok(`the provider was called only by our server, with the key (${provider.length} calls)`, provider.length >= 1 && provider.every((e) => e.key === "local-routing-key"));
ok("the browser never talked to the provider, only to /api/nav", !browserRequests.some((u) => /routing|stadiamaps|valhalla/i.test(u)) && browserRequests.some((u) => u.includes("/api/nav/route")));
const js = await me.evaluate(async () => {
  const urls = performance.getEntriesByType("resource").map((e) => e.name).filter((u) => u.endsWith(".js"));
  const texts = await Promise.all(urls.map((u) => fetch(u).then((r) => r.text())));
  return texts.some((t) => t.includes("local-routing-key"));
});
ok("the key is not in the app's code", js === false);
const anon = await me.evaluate(() => fetch("/api/nav/route", { method: "POST", body: "{}" }).then((r) => r.status));
ok("/api/nav without a session: 401", anon === 401);
ok("route / search requests counted per person (limits)", Number(sql(`select count(*) from private.rate_events where user_id='${ME}' and action in ('nav_route','nav_search')`)) >= 3);
void base;
await done();

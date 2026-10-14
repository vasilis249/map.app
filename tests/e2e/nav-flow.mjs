// Phase 4: navigation in the browser, against the provider mock (recorded Valhalla answers, tests/e2e/routing-mock.mjs).
// Search a place → two route choices → start → heading-up guidance along the recorded route (positions moved by
// Playwright), Greek voice (the browser's speechSynthesis is replaced by a recorder), push to talk with someone 100 m
// away while navigating (guidance waits until the talk ends), leaving the route → automatic new route, arrival, end.
// Also: the provider key never reaches the browser; /api/nav refuses calls without a session.
import { MAIN, REROUTE, along, dist } from "./route-helpers.mjs";
import { base, done, hold, ok, open, S, seen, sql, sqlUntil, SUPABASE, USERS } from "./lib.mjs";

const m = dist;
const ME = USERS.me.id, GIO = USERS.giorgos.id;
await fetch(`${SUPABASE}/routing/_reset`);
const SYNTAGMA = [37.9755, 23.7348];
// Me and Giorgos share with everyone; he stands 100 m south of the route's first stretch.
sql(`insert into public.location_sharing (user_id, mode, talk_from) values ('${ME}', 'everyone', 'everyone'), ('${GIO}', 'everyone', 'everyone')`);

const { page: gio } = await open("giorgos", "/profile", { geo: [37.9746, 23.7356] });
await gio.mouse.click(200, 400); // sound unlock (iOS-style)
const { page: me, ctx } = await open("me", "/map", { geo: SYNTAGMA });
const browserRequests = [], routeBodies = [];
me.on("request", (r) => {
  browserRequests.push(r.url());
  if (r.url().includes("/api/nav/route")) routeBodies.push(r.postDataJSON());
});
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
// Home / Work shortcuts (kept on the device): set Home to Koukaki
ok("search opens with Home / Work shortcuts", await seen(me.getByRole("button", { name: "Ορισμός: Σπίτι" })) && await me.getByRole("button", { name: "Ορισμός: Δουλειά" }).isVisible());
await me.getByRole("button", { name: "Ορισμός: Σπίτι" }).click();
await me.getByRole("textbox", { name: "Βρες τη διεύθυνση του σπιτιού σου" }).fill("κουκ");
await me.getByRole("button", { name: /^Κουκάκι Αθήνα/ }).click({ timeout: 10_000 });
ok("Home set (on the device only)", await seen(me.getByRole("button", { name: "Σπίτι: Κουκάκι" }))
  && (await me.evaluate(() => JSON.parse(localStorage.getItem("mapapp:places")).home.name)) === "Κουκάκι");
await me.getByRole("textbox", { name: "Διεύθυνση ή μέρος" }).fill("κουκ");
ok("search: places as you type (Greek, accents ignored)", await seen(me.getByRole("button", { name: /Κουκάκι.*Αθήνα/ }), 10_000));
await me.screenshot({ path: `${S}/nav-1-search.png` });
await me.getByRole("button", { name: /^Κουκάκι Αθήνα/ }).click();

// 2. Route choices
const preview = me.getByTestId("route-preview");
ok("two routes: time, distance, main road; the fastest marked", await seen(preview.getByRole("button", { name: /10 λ.*2,7 χλμ.*μέσω Χατζηχρήστου.*Ταχύτερη/ }), 10_000)
  && await seen(preview.getByRole("button", { name: /11 λ.*1,9 χλμ.*μέσω Μητροπόλεως/ })));
// avoid tolls: the routes are asked again with the provider's toll option; and back
await preview.getByRole("button", { name: "Χωρίς διόδια" }).click();
// (the provider sees it as Valhalla's use_tolls = 0 — unless an earlier run left that answer in the edge cache)
const tollAsked = async () => routeBodies.some((b) => b?.options?.avoidTolls === true)
  || (await (await fetch(`${SUPABASE}/routing/_log`)).json()).some((e) => e.path === "/route/v1" && e.body?.costing_options?.auto?.use_tolls === 0);
let asked = false;
for (let i = 0; i < 20 && !asked; i++) { await me.waitForTimeout(300); asked = await tollAsked(); }
ok("'Χωρίς διόδια': routes asked again avoiding tolls (remembered on the device)", asked
  && (await preview.getByRole("button", { name: "Χωρίς διόδια" }).getAttribute("aria-pressed")) === "true");
await preview.getByRole("button", { name: "Χωρίς διόδια" }).click();
await me.waitForTimeout(1500);
await preview.getByRole("button", { name: /11 λ/ }).click({ timeout: 10_000 });
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

// 4. Drive from Syntagma onto the route and along it past two turns at city speed (14 m a second ≈ 50 km/h)
// (speed limits from the provider's map matching: 30 km/h on Amalias / Vas. Georgiou in the recorded answer)
const limitsSeen = new Set(), overSeen = [];
for (const p of [[37.97535, 23.73425], ...along(MAIN, 0, 330, 14)]) {
  await goTo(p);
  await me.waitForTimeout(1000);
  const l = await me.getByTestId("nav-limit").textContent({ timeout: 150 }).catch(() => null);
  if (l) limitsSeen.add(l.trim());
  overSeen.push(await me.getByTestId("nav-speed").getAttribute("data-over", { timeout: 150 }).catch(() => null));
}
// (read at once: 3 s without a fix and the speedometer rightly drops to 0)
const kmhMoving = Number(await me.getByTestId("nav-speed").innerText().then((t) => t.replace(/\D/g, "")));
ok(`speed limit sign where the map knows it (${[...limitsSeen].join(",")})`, limitsSeen.has("30"));
ok("over it (≈ 50 in a 30): the speedometer turns red", overSeen.includes("1"));
const limitSaid = (await spoken()).filter((x) => x.startsWith("Όριο ταχύτητας"));
ok(`… and the limit is said once (${limitSaid.join(" | ")})`, limitSaid.length === 1 && limitSaid[0] === "Όριο ταχύτητας 30.");
await me.screenshot({ path: `${S}/nav-4b-limit.png` });
// (≈ 50 km/h in theory; the test browser's slow software rendering stretches the 1 s steps, so less is measured)
ok(`live speed while driving (${kmhMoving} km/h)`, kmhMoving >= 20 && kmhMoving <= 70);
const cam1 = await camera();
ok(`heading-up, tilted camera (bearing ${cam1?.bearing}°, pitch ${cam1?.pitch}°)`, cam1?.pitch >= 45 && cam1.pitch <= 58 && cam1.bearing !== 0);
await me.waitForTimeout(2000);
const said = await spoken();
ok("the turns are announced in order: Vas. Georgiou, then Syntagma square",
  said.indexOf("Στρίψτε αριστερά στη Βασιλέως Γεωργίου Α', ΕΟ54.") > 0
  && said.indexOf("Στρίψτε αριστερά στη Πλατεία Συντάγματος, ΕΟ1.") > said.indexOf("Στρίψτε αριστερά στη Βασιλέως Γεωργίου Α', ΕΟ54."));
ok("the banner moved on (next: Filellinon), with the distance to it", await seen(me.getByTestId("nav-instruction").filter({ hasText: "Φιλελλήνων" }), 5_000)
  && /^\d+ μ$/.test((await me.getByTestId("nav-distance").textContent()) ?? ""));
ok("you are the navigation arrow (not your photo) while navigating", (await me.locator("[data-puck]").count()) === 1);
await me.screenshot({ path: `${S}/nav-4-driving.png` });

// 5. Push to talk while navigating: Giorgos waits on the square a little ahead of me; his card from his marker; while I
// hold, the next announcement waits
// (20–40 m ahead: at a light the camera is so close that a car much further on is off the top of the screen)
const ahead = along(MAIN, 355, 375)[0];
// (his page sits in the background: the browser may hold a position change back, so it is set again if needed)
let gioMoved = "false";
for (let i = 0; i < 3 && gioMoved !== "true"; i++) {
  await gio.context().setGeolocation({ latitude: ahead[0] + i * 1e-6, longitude: ahead[1], accuracy: 8 });
  gioMoved = await sqlUntil(`select (abs(lat - ${ahead[0]}) < 0.0001 and abs(lng - ${ahead[1]}) < 0.0001)::text from private.user_locations where user_id = '${GIO}'`, "true", 6_000);
}
ok("Giorgos moved a little ahead on my route (his position stored)", gioMoved === "true");
// He is in a car (moved at vehicle speed a moment ago).
sql(`update private.user_locations set vehicle_at = now() where user_id = '${GIO}'`);
await me.waitForTimeout(6000); // the map's refresh; and me standing still at the light all this time (no new fixes)
const still = await me.evaluate(() => { const b = document.querySelector("[data-frames]")?.dataset ?? {}; return { zoom: +b.zoom, pitch: +b.pitch, figures: +b.figures }; });
ok(`stopped at the light: close, tilted 3D view (zoom ${still.zoom}, pitch ${still.pitch})`, still.zoom >= 19 && still.pitch >= 63);
ok("… the speedometer reads 0", (await me.getByTestId("nav-speed").innerText()).replace(/\s/g, "").startsWith("0"));
ok(`… people around me in 3D (${still.figures} figure: Giorgos's car)`, still.figures === 1);
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
  for (const p of along(MAIN, 330, 450, 14)) { await goTo(p); await me.waitForTimeout(1000); }
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
await me.waitForTimeout(1500);
ok("end: back to the map (search shown)", await seen(me.getByRole("button", { name: "Πού πας;" })));
ok("… the screen may sleep again (wake lock released)", (await me.evaluate(() => window.__wake)).at(-1) === "off");
ok("… and your photo again instead of the arrow", (await me.locator("[data-puck]").count()) === 0 && (await me.locator('[aria-label="me"]').count()) === 1);
const cam2 = await camera();
ok(`… flat, north-up camera (bearing ${cam2?.bearing}°, pitch ${cam2?.pitch}°)`, cam2?.pitch === 0 && cam2.bearing === 0);

// 7b. Shortcuts after the trip: Koukaki is in "Recent"; Home is one tap to the route choices
await me.getByRole("button", { name: "Πού πας;" }).click();
ok("recent destinations: Koukaki", await seen(me.getByRole("list", { name: "Πρόσφατα" }).getByRole("button", { name: /Κουκάκι/ })));
await me.getByRole("button", { name: "Σπίτι: Κουκάκι" }).click();
ok("Home: one tap → routes home", await seen(me.getByTestId("route-preview"), 10_000));
await me.getByRole("button", { name: "Άκυρο" }).click();

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

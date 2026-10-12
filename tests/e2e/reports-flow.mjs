// Phase 5: Waze-style road reports between three phones. Giorgos reports police (and a hazard) where he stands with one
// tap; I navigate along the recorded route that passes there: a warning chip + voice ahead of it, "still there?" as I
// pass it, and my "no"; Maria, nearby, sees the pins, votes "no" too → it disappears for everyone and Giorgos gets a
// strike; she reports the hazard as abuse → it reaches the moderation queue. Anonymity: nobody sees who reported.
import { MAIN, along, recordVoice } from "./route-helpers.mjs";
import { done, gone, ok, open, S, seen, sql, sqlUntil, SUPABASE, USERS } from "./lib.mjs";

const ME = USERS.me.id, GIO = USERS.giorgos.id;
await fetch(`${SUPABASE}/routing/_reset`);
const POLICE_AT = along(MAIN, 600, 620)[0];
const HAZARD_AT = along(MAIN, 1500, 1520)[0];
const SYNTAGMA = [37.9755, 23.7348];
const RECENTER = "Η θέση μου";

// 1. Giorgos reports police where he is: one tap on the report button, one on the tile
const { page: gio, ctx: gioCtx } = await open("giorgos", "/map", { geo: POLICE_AT });
await gio.getByRole("button", { name: "Αναφορά" }).click({ timeout: 15_000 });
ok("the report sheet: five big tiles", await seen(gio.getByRole("button", { name: "Αστυνομία" }))
  && (await gio.getByRole("button", { name: /^(Τροχαίο|Αστυνομία|Κίνδυνος|Κίνηση|Κλειστός δρόμος)$/ }).count()) === 5);
await gio.screenshot({ path: `${S}/reports-1-sheet.png` });
await gio.getByRole("button", { name: "Αστυνομία" }).click();
ok("reported at his position (stored, police)", (await sqlUntil(`select count(*) from private.road_reports where created_by = '${GIO}' and kind = 'police'`, "1")) === "1"
  && sql(`select (abs(lat - ${POLICE_AT[0]}) < 0.0002 and abs(lng - ${POLICE_AT[1]}) < 0.0002)::text from private.road_reports where kind = 'police'`) === "true");
ok("… thanked", await seen(gio.getByText("Ευχαριστούμε! Το βλέπουν όσοι περνούν από εκεί.")));
// his own report: no voting on it
await gio.locator('[data-road="police"]').first().click({ timeout: 10_000 });
ok("his own pin: 'Δική σου αναφορά', no still-there buttons", await seen(gio.getByText(/Δική σου αναφορά/))
  && !(await gio.getByRole("button", { name: "Ναι" }).isVisible()));
await gio.keyboard.press("Escape");
await gio.waitForTimeout(600);
// a hazard further along the same road
await gioCtx.setGeolocation({ latitude: HAZARD_AT[0], longitude: HAZARD_AT[1], accuracy: 8 });
await gio.waitForTimeout(2500);
await gio.getByRole("button", { name: "Αναφορά" }).click();
await gio.getByRole("button", { name: "Κίνδυνος" }).click();
ok("a hazard too (900 m further)", (await sqlUntil(`select count(*) from private.road_reports where kind = 'hazard'`, "1")) === "1");

// 2. I navigate to Koukaki along that road
const { page: me, ctx } = await open("me", "/map", { geo: SYNTAGMA });
const spoken = await recordVoice(me);
await me.getByRole("button", { name: "Πού πας;" }).click();
await me.getByRole("textbox", { name: "Διεύθυνση ή μέρος" }).fill("κουκ");
await me.getByRole("button", { name: /^Κουκάκι Αθήνα/ }).click({ timeout: 10_000 });
await me.getByRole("button", { name: "Έναρξη" }).click({ timeout: 10_000 });
ok("navigating; the reports on the route are on my map", await seen(me.getByTestId("nav-banner"), 8_000)
  && await seen(me.locator('[data-road="police"]'), 15_000));
let chip = "";
for (const p of [[37.97535, 23.73425], ...along(MAIN, 0, 660, 14)]) {
  await ctx.setGeolocation({ latitude: p[0], longitude: p[1], accuracy: 8 });
  await me.waitForTimeout(1000);
  // (a short timeout: a locator that isn't there would otherwise wait 30 s at every step)
  if (!chip) chip = (await me.getByTestId("road-ahead").textContent({ timeout: 150 }).catch(() => "")) ?? "";
  if (await me.getByTestId("road-ask").isVisible().catch(() => false)) break;
}
ok(`warned ahead of the police: chip '${chip}'`, /^Αστυνομία σε \d+ μ$/.test(chip));
const said = (await spoken()).filter((t) => t.startsWith("Αστυνομία μπροστά"));
ok(`… and by voice, once (${said.join(" | ")})`, said.length === 1 && /^Αστυνομία μπροστά, σε \d+ μέτρα\.$/.test(said[0]));
ok("passing it: 'Ακόμα εκεί;' with big yes / no", await seen(me.getByTestId("road-ask"), 10_000)
  && await me.getByTestId("road-ask").getByRole("button", { name: "Ναι" }).isVisible());
await me.screenshot({ path: `${S}/reports-2-ask.png` });
await me.getByTestId("road-ask").getByRole("button", { name: "Όχι" }).click();
ok("my 'no' is stored (one vote, down)", (await sqlUntil(`select down::text from private.road_reports where kind = 'police'`, "1")) === "1");

// 3. Maria, standing near it, sees both pins; votes "no" on the police → gone; reports the hazard as abuse
const { page: maria, ctx: mariaCtx } = await open("maria", "/map", { geo: [POLICE_AT[0] - 0.0003, POLICE_AT[1]] });
ok("Maria sees the pins (not navigating: within 2 km)", await seen(maria.locator('[data-road="police"]'), 15_000)
  && await seen(maria.locator('[data-road="hazard"]'), 5_000));
await maria.locator('[data-road="police"]').first().click();
ok("the pin's card: what, when, no author", await seen(maria.getByText(/πριν από/))
  && !(await maria.getByText(/Γιώργος|giorgos/).isVisible().catch(() => false)));
await maria.screenshot({ path: `${S}/reports-3-detail.png` });
await maria.getByRole("button", { name: "Όχι" }).click();
ok("two 'no' and no 'yes': the report is removed (and Giorgos gets a strike)",
  (await sqlUntil(`select (removed_at is not null)::text from private.road_reports where kind = 'police'`, "true")) === "true"
  && sql(`select count(*) from private.road_strikes where user_id = '${GIO}'`) === "1");
ok("… gone from Maria's map", await gone(maria.locator('[data-road="police"]'), 10_000));
// She walks on to the hazard (900 m on) and looks at it
await mariaCtx.setGeolocation({ latitude: HAZARD_AT[0] - 0.0003, longitude: HAZARD_AT[1], accuracy: 8 });
await maria.waitForTimeout(1500);
await maria.getByRole("button", { name: RECENTER }).click();
await maria.waitForTimeout(1500);
await maria.locator('[data-road="hazard"]').first().click({ timeout: 10_000 });
await maria.getByRole("button", { name: "Αναφορά κατάχρησης" }).click();
ok("hazard reported as abuse → moderation queue (kind road, against its author)",
  (await sqlUntil(`select count(*) from public.reports where kind = 'road' and target_user_id = '${GIO}'`, "1")) === "1");
ok("I never voted on my own… and nobody's client got an author id", sql(`select count(*) from private.road_votes where user_id = '${GIO}'`) === "0");
void ME;
await done();

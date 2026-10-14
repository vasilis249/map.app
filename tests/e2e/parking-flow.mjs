// P7 parking between three phones: Maria parks near Koukaki (red), drives off and is asked whether she freed her spot
// (green, where her car was); I navigate to Koukaki and near the end get "free spot … from your destination" → a route
// to it; Giorgos sees the green spot, says it got taken → red. Anonymity: nobody's client gets who marked a spot.
import { MAIN, along } from "./route-helpers.mjs";
import { done, ok, open, S, seen, sql, sqlUntil, SUPABASE, USERS } from "./lib.mjs";

const MARIA = USERS.maria.id;
await fetch(`${SUPABASE}/routing/_reset`);
// ≈ 40 m from the Koukaki destination of the recorded route
const SPOT = [37.9712, 23.727];
const SYNTAGMA = [37.9755, 23.7348];

// 1. Maria parks: report button → Parking → "I parked here"
const { page: maria, ctx: mariaCtx } = await open("maria", "/map", { geo: SPOT });
await maria.getByRole("button", { name: "Αναφορά" }).click({ timeout: 15_000 });
ok("the report sheet has an eighth tile: Πάρκινγκ", await seen(maria.getByRole("button", { name: "Πάρκινγκ" })));
await maria.getByRole("button", { name: "Πάρκινγκ" }).click();
ok("parking: two big choices (leaving / parked)", await seen(maria.getByRole("button", { name: /Φεύγω — ελευθερώνω θέση/ }))
  && await maria.getByRole("button", { name: /Πάρκαρα εδώ/ }).isVisible());
await maria.screenshot({ path: `${S}/parking-1-sheet.png` });
await maria.getByRole("button", { name: /Πάρκαρα εδώ/ }).click();
ok("parked: a red spot where she is; her car's place kept on her phone only",
  (await sqlUntil(`select count(*) from private.parking_spots where created_by = '${MARIA}' and state = 'taken'`, "1")) === "1"
  && (await maria.evaluate(() => !!JSON.parse(localStorage.getItem("mapapp:myCar") ?? "null"))));

// 2. Giorgos nearby sees it red
const { page: gio } = await open("giorgos", "/map", { geo: [SPOT[0] + 0.002, SPOT[1]] });
ok("Giorgos sees the red P", await seen(gio.locator('[data-parking="taken"]'), 25_000));

// 3. Maria drives off (≈ 12 m a second): "Did you free your spot?" → yes → green where her car was
for (let i = 1; i <= 12; i++) {
  await mariaCtx.setGeolocation({ latitude: SPOT[0], longitude: SPOT[1] + i * 0.00014, accuracy: 8 });
  await maria.waitForTimeout(1000);
  if (await maria.getByTestId("ask-freed").isVisible().catch(() => false)) break;
}
ok("driving off from where she parked: 'Ελευθέρωσες τη θέση σου;'", await seen(maria.getByTestId("ask-freed"), 5_000));
await maria.screenshot({ path: `${S}/parking-2-ask.png` });
await maria.getByTestId("ask-freed").getByRole("button", { name: "Ναι, είναι ελεύθερη" }).click();
ok("… yes: her red spot is gone, a green one where the car was (not where she is now)",
  (await sqlUntil(`select count(*) from private.parking_spots where created_by = '${MARIA}' and state = 'free'`, "1")) === "1"
  && sql(`select count(*) from private.parking_spots where created_by = '${MARIA}' and state = 'taken'`) === "0"
  && sql(`select (abs(lat - ${SPOT[0]}) < 0.0002 and abs(lng - ${SPOT[1]}) < 0.0002)::text from private.parking_spots where created_by = '${MARIA}'`) === "true"
  && (await maria.evaluate(() => localStorage.getItem("mapapp:myCar"))) === null);
ok("Giorgos now sees it green", await seen(gio.locator('[data-parking="free"]'), 25_000));

// 4. I drive to Koukaki; close to it the free spot is offered → a route to the spot
const { page: me, ctx } = await open("me", "/map", { geo: SYNTAGMA });
await me.getByRole("button", { name: "Πού πας;" }).click();
await me.getByRole("textbox", { name: "Διεύθυνση ή μέρος" }).fill("κουκ");
await me.getByRole("button", { name: /^Κουκάκι Αθήνα/ }).click({ timeout: 10_000 });
await me.getByRole("button", { name: "Έναρξη" }).click({ timeout: 10_000 });
await seen(me.getByTestId("nav-banner"), 8_000);
for (const p of [[37.97535, 23.73425], ...along(MAIN, 0, 1600, 100)]) {
  await ctx.setGeolocation({ latitude: p[0], longitude: p[1], accuracy: 8 });
  await me.waitForTimeout(700);
}
ok("near the destination: 'Ελεύθερη θέση … από τον προορισμό'",
  /Ελεύθερη θέση \d+ μ από τον προορισμό$/.test((await me.getByTestId("dest-parking").textContent({ timeout: 15_000 }).catch(() => "")) ?? ""));
await me.screenshot({ path: `${S}/parking-3-dest.png` });
await me.getByTestId("dest-parking").click();
ok("one tap: routes to the free spot", await seen(me.getByTestId("route-preview").filter({ hasText: "Ελεύθερη θέση" }), 10_000));
await me.getByRole("button", { name: "Άκυρο" }).click();

// 5. Giorgos: the green spot got taken → red for everyone; no author anywhere
await gio.locator('[data-parking="free"]').first().click({ timeout: 10_000 });
ok("the spot's card: free, how long ago, Go / Taken; no author",
  await seen(gio.getByText("Ελεύθερη θέση")) && await gio.getByRole("button", { name: "Πιάστηκε" }).isVisible()
  && !(await gio.getByText(/Μαρία|maria/).isVisible().catch(() => false)));
await gio.getByRole("button", { name: "Πιάστηκε" }).click();
ok("taken: red for everyone", (await sqlUntil(`select state from private.parking_spots where created_by = '${MARIA}'`, "taken")) === "taken"
  && await seen(me.locator('[data-parking="taken"]'), 25_000));
ok("the spots' answer never carries who marked them",
  !(await me.evaluate(async () => JSON.stringify(performance.getEntriesByType("resource").map((e) => e.name)).includes("created_by"))));
await done();

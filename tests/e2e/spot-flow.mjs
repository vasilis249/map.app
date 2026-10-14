// P8 spot exchange (SpotSmiley logic) between two phones: Maria enters her car (plate), offers her spot leaving in 2′;
// I see it, claim it with my one starter credit; we're spot mates: each sees the other's name, car and plate, my live
// position on her map, quick messages (heard), push-to-talk at any distance; I arrive → "arrived" for her; I park → she
// gets +1 credit / +10, I +5; the plates disappear when it ends; the leaderboard; nobody else ever sees a plate.
import { recordVoice } from "./route-helpers.mjs";
import { done, hold, ok, open, S, seen, sql, sqlUntil, SUPABASE, USERS } from "./lib.mjs";

const ME = USERS.me.id, MARIA = USERS.maria.id;
await fetch(`${SUPABASE}/routing/_reset`);
const SPOT = [37.9712, 23.727];
const START = [37.9730, 23.7290]; // ≈ 270 m from the spot (beyond the 200 m of "nearby" talk)

// 1. Maria enters her vehicle (Profile → My vehicle & exchanges)
const { page: maria, ctx: mariaCtx } = await open("maria", "/exchange", { geo: SPOT });
ok("the exchange page: 1 starter credit, how it works", await seen(maria.getByTestId("wallet").filter({ hasText: "1 credit" }), 10_000)
  && await maria.getByText(/Ξεκινάς με 1 credit δώρο/).isVisible());
await maria.getByPlaceholder("π.χ. ΙΚΑ-1234").fill("ικα 1234");
await maria.getByPlaceholder("π.χ. Toyota Yaris").fill("Toyota Yaris");
await maria.getByRole("radio", { name: "Λευκό" }).click();
ok("save stays off until the lawful-use declaration is ticked", await maria.getByRole("button", { name: "Αποθήκευση" }).isDisabled());
await maria.getByRole("checkbox").check();
await maria.getByRole("button", { name: "Αποθήκευση" }).click();
ok("vehicle saved, plate normalized", (await sqlUntil(`select plate || '/' || colour || '/' || make from private.vehicles where user_id = '${MARIA}'`, "IKA1234/white/Toyota Yaris")) === "IKA1234/white/Toyota Yaris");
await maria.screenshot({ path: `${S}/spot-1-vehicle.png` });
// my car (set up directly)
sql(`insert into private.vehicles (user_id, plate, make, colour) values ('${ME}', 'ZKP4521', 'Fiat Panda', 'red')`);

// 2. Maria offers her spot, leaving in 2 minutes
await maria.goto(maria.url().replace("/exchange", "/map"));
const mariaVoice = await recordVoice(maria);
await maria.getByRole("button", { name: "Αναφορά" }).click({ timeout: 15_000 });
await maria.getByRole("button", { name: "Πάρκινγκ" }).click();
ok("parking sheet: 'Δίνω τη θέση μου' with now / 2′ / 5′ / 10′", await seen(maria.getByTestId("give-spot")) && await maria.getByRole("button", { name: "σε 2′" }).isVisible());
await maria.getByRole("button", { name: "σε 2′" }).click();
ok("offered: waiting card, 'keep the app open'", await seen(maria.getByTestId("offer-waiting"), 8_000)
  && (await sqlUntil(`select state from private.spot_offers where user_id = '${MARIA}'`, "open")) === "open");

// 3. I see it and claim it
const { page: me, ctx } = await open("me", "/map", { geo: START });
const myVoice = await recordVoice(me);
ok("I see the offered spot on the map (green P, minutes left)", await seen(me.locator('[data-parking="offer"]'), 15_000));
await me.locator('[data-parking="offer"]').first().click();
ok("its card: freed in 2′, distance; 'Τη θέλω · 1 credit'", await seen(me.getByTestId("offer-sheet").filter({ hasText: /φεύγει σε \d′/ }))
  && await me.getByRole("button", { name: "Τη θέλω · 1 credit" }).isVisible());
await me.screenshot({ path: `${S}/spot-2-offer.png` });
await me.getByRole("button", { name: "Τη θέλω · 1 credit" }).click();
ok("claimed: matched, my credit spent", (await sqlUntil(`select state from private.spot_matches where taker = '${ME}'`, "active")) === "active"
  && sql(`select credits from private.spot_wallets where user_id = '${ME}'`) === "0");
ok("… and the route choices to the spot come up", await seen(me.getByTestId("route-preview"), 10_000));
await me.getByRole("button", { name: "Άκυρο" }).click();

// 4. Both see each other: name, car, plate
ok("my panel: Maria, her white Toyota Yaris, plate ΙΚΑ-1234", await seen(me.getByTestId("match-panel").filter({ hasText: "Μαρία" }), 8_000)
  && (await me.getByTestId("match-panel").getByTestId("plate").textContent()) === "GRΙΚΑ-1234"
  && await me.getByTestId("match-panel").getByText("Λευκό Toyota Yaris").isVisible());
ok("Maria's panel: me coming, my red Fiat Panda, ΖΚΡ-4521", await seen(maria.getByTestId("match-panel").filter({ hasText: "έρχεται για τη θέση σου" }), 8_000)
  && (await maria.getByTestId("match-panel").getByTestId("plate").textContent()) === "GRΖΚΡ-4521");
ok("Maria is told by voice", (await mariaVoice()).some((x) => /έρχεται για τη θέση σου\.$/.test(x)));
ok("my live position on her map (my car)", await seen(maria.locator('[data-parking="mate"]'), 10_000));
await maria.screenshot({ path: `${S}/spot-3-giver.png` });

// 5. Quick messages
await maria.getByRole("button", { name: "Σε περιμένω" }).click();
ok("her 'Σε περιμένω' reaches me (shown and said)", await seen(me.getByTestId("mate-msg").filter({ hasText: "Μαρία: Σε περιμένω" }), 8_000)
  && (await myVoice()).includes("Μαρία: Σε περιμένω"));

// 6. Push-to-talk between us, ≈ 270 m apart
await maria.getByRole("button", { name: "Μίλα" }).click();
await hold(maria, 1500);
ok("she can talk to me although we're 270 m apart (exchange mates)",
  (await sqlUntil(`select count(*) from private.nearby_knocks where sender_id = '${MARIA}' and recipient_id = '${ME}'`, "1")) === "1");
await maria.keyboard.press("Escape");
await maria.waitForTimeout(600);

// 7. I drive there: arrived
for (let i = 1; i <= 8; i++) {
  const k = i / 8;
  await ctx.setGeolocation({ latitude: START[0] + (SPOT[0] - START[0]) * k, longitude: START[1] + (SPOT[1] - START[1]) * k, accuracy: 8 });
  await me.waitForTimeout(1200);
}
ok("within 60 m: 'Έφτασε!' on her side, said", await seen(maria.getByTestId("match-status").filter({ hasText: "Έφτασε" }), 10_000)
  && (await mariaVoice()).some((x) => /έφτασε\.$/.test(x)));
ok("… 'Έφτασες στη θέση' on mine", await seen(me.getByTestId("match-status").filter({ hasText: "Έφτασες στη θέση" }), 6_000));
await me.screenshot({ path: `${S}/spot-4-taker.png` });

// 8. I park: done
await me.getByRole("button", { name: "Πάρκαρα ✓" }).click();
ok("done: Maria +1 credit (2) and +10, me +5",
  (await sqlUntil(`select state from private.spot_matches where taker = '${ME}'`, "done")) === "done"
  && sql(`select credits || '/' || points from private.spot_wallets where user_id = '${MARIA}'`) === "2/10"
  && sql(`select credits || '/' || points from private.spot_wallets where user_id = '${ME}'`) === "0/5");
ok("both told", await seen(me.getByText("Καλή στάθμευση! +5 πόντοι.")) && await seen(maria.getByText("Έγινε! +1 credit, +10 πόντοι."), 8_000));
ok("the panels (and plates) are gone; positions wiped", await me.getByTestId("match-panel").isHidden() && await maria.getByTestId("match-panel").isHidden()
  && sql(`select (giver_lat is null and taker_lat is null)::text from private.spot_matches where taker = '${ME}'`) === "true");

// 9. Leaderboard; a third person never sees a plate
await me.goto(me.url().replace(/\/map.*/, "/exchange"));
ok("the week's leaderboard: Maria 10, me 5", await seen(me.getByRole("list", { name: "Κατάταξη εβδομάδας" }).filter({ hasText: /Μαρία.*10 πόντοι/s }), 10_000)
  && await me.getByRole("list", { name: "Κατάταξη εβδομάδας" }).getByText("5 πόντοι").isVisible());
const { page: gio } = await open("giorgos", "/map", { geo: SPOT });
await gio.waitForTimeout(4000);
ok("someone else: no plate anywhere", (await gio.getByTestId("plate").count()) === 0);
void mariaCtx;
await done();

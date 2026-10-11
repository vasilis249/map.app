// Phase 1: the live map with two phones (Playwright geolocation). Opt-in sharing from the settings screen, a stranger
// 100 m away appears (and disappears past 200 m), a friend 3 km away shows on the friends layer, the person card
// (name, @username, distance, Follow), ghost mode both ways, reciprocity, block.
import { base, done, gone, ok, open, S, seen, sql, sqlUntil, USERS } from "./lib.mjs";

const HERE = [37.9755, 23.7348];
const NORTH_100 = [37.9764, 23.7348]; // ≈ 100 m
const NORTH_300 = [37.9782, 23.7348]; // ≈ 300 m
const posOf = (u) => `select count(*) from private.user_locations where user_id = '${USERS[u].id}'`;

// Nikos (my friend) shares with friends, 3 km away; Giorgos shares with everyone (set up like after his own opt-in).
sql(`insert into public.location_sharing (user_id, mode) values ('${USERS.nikos.id}', 'friends'), ('${USERS.giorgos.id}', 'everyone')`);
sql(`insert into private.user_locations (user_id, lat, lng, accuracy_m) values ('${USERS.nikos.id}', 38.0025, 23.7348, 12)`);

// 1. Me: sharing is off by default → the map says so; opt in from the settings screen ("everyone" asks to confirm)
const me = await open("me", "/map", { geo: HERE });
ok("off by default: the map explains and offers to turn it on", await seen(me.page.getByText("Η θέση σου δεν φαίνεται")));
ok("nothing about me on the server yet", sql(posOf("me")) === "0");
await me.page.getByRole("link", { name: "Ενεργοποίηση" }).click();
await me.page.getByRole("radio", { name: /Φίλοι και όσοι είναι κοντά/ }).click();
ok("'everyone' shows the strangers-within-200 m warning first", await seen(me.page.getByText(/Άγνωστοι που είναι έως 200 μ/)));
ok("… and nothing is saved before confirming", sql(`select count(*) from public.location_sharing where user_id = '${USERS.me.id}'`) === "0");
await me.page.getByRole("button", { name: "Το καταλαβαίνω" }).click();
ok("confirmed → mode everyone, and the tracker sends my position", (await sqlUntil(posOf("me"), "1")) === "1"
  && sql(`select mode from public.location_sharing where user_id = '${USERS.me.id}'`) === "everyone");

// 2. Giorgos opens the app 100 m north: his tracker sends his position
const gio = await open("giorgos", "/map", { geo: NORTH_100 });
ok("Giorgos's position is stored (≈100 m from me)", (await sqlUntil(posOf("giorgos"), "1")) === "1");

// 3. My map: friends layer (Nikos, 3 km) and nearby (Giorgos)
await me.page.goto(base + "/map", { waitUntil: "load" });
ok("friends layer: Nikos 3 km away is in the strip", await seen(me.page.getByRole("button", { name: /Νίκος/ }), 12_000));
await me.page.getByRole("tab", { name: "Κοντά μου" }).click();
ok("nearby: Giorgos's marker", await seen(me.page.getByRole("button", { name: "Γιώργος Κ." }), 12_000));
ok("nearby: the strip says 1 near you", await seen(me.page.getByText("1 κοντά σου")));
await me.page.waitForTimeout(2500); // tiles, if the network lets them in
await me.page.screenshot({ path: `${S}/map-1-nearby.png` });

// 4. The person card
await me.page.getByRole("button", { name: "Γιώργος Κ." }).click();
ok("card: name, @username, distance ≈100 m", await seen(me.page.getByText("@giorgos.k"))
  && await seen(me.page.getByText(/^(90|100|110) μ μακριά/)));
ok("card: push to talk, Profile, ⋯", await seen(me.page.getByRole("button", { name: "Κράτα πατημένο και μίλα" }))
  && await seen(me.page.getByRole("link", { name: "Προφίλ" })) && await seen(me.page.getByRole("button", { name: "Επιλογές" })));
await me.page.getByRole("button", { name: "Ακολούθησε" }).click();
ok("card: Follow works (stored, button turns to 'Ακολουθείς')", await seen(me.page.getByRole("button", { name: "Ακολουθείς" }))
  && sql(`select count(*) from public.follows where follower_id = '${USERS.me.id}' and followee_id = '${USERS.giorgos.id}'`) === "1");
await me.page.screenshot({ path: `${S}/map-2-card.png` });
await me.page.keyboard.press("Escape");
await me.page.waitForTimeout(500);

// 5. Giorgos walks to 300 m: he leaves my map (radius enforced by the server), comes back at 100 m
await gio.ctx.setGeolocation({ latitude: NORTH_300[0], longitude: NORTH_300[1], accuracy: 10 });
ok("Giorgos's new position (≈300 m) reaches the server", (await sqlUntil(
  `select (lat > 37.978)::text from private.user_locations where user_id = '${USERS.giorgos.id}'`, "true", 12_000)) === "true");
ok("… and he is gone from my map", await gone(me.page.getByRole("button", { name: "Γιώργος Κ." }), 12_000));
await gio.ctx.setGeolocation({ latitude: NORTH_100[0], longitude: NORTH_100[1], accuracy: 10 });
ok("back at 100 m: on my map again", await seen(me.page.getByRole("button", { name: "Γιώργος Κ." }), 15_000));

// 6. Ghost mode (Giorgos): one tap → position deleted, gone from my map; another tap → back
await gio.page.getByRole("button", { name: "Αόρατος" }).click();
ok("ghost: his stored position is deleted at once", (await sqlUntil(posOf("giorgos"), "0")) === "0");
ok("ghost: gone from my map", await gone(me.page.getByRole("button", { name: "Γιώργος Κ." }), 12_000));
ok("ghost: he sees the off card", await seen(gio.page.getByText("Η θέση σου δεν φαίνεται")));
await gio.page.screenshot({ path: `${S}/map-3-ghost.png` });
await gio.page.getByRole("button", { name: "Ορατός ξανά" }).click();
ok("visible again: mode restored to everyone, position sent again", (await sqlUntil(posOf("giorgos"), "1")) === "1"
  && sql(`select mode from public.location_sharing where user_id = '${USERS.giorgos.id}'`) === "everyone");
ok("… and back on my map", await seen(me.page.getByRole("button", { name: "Γιώργος Κ." }), 15_000));

// 7. Reciprocity: I go ghost → I see nobody, and Giorgos no longer sees me
await me.page.getByRole("button", { name: "Αόρατος" }).click();
ok("reciprocity: in ghost mode my map shows nobody", await gone(me.page.getByRole("button", { name: "Γιώργος Κ." }), 10_000)
  && await seen(me.page.getByText("Η θέση σου δεν φαίνεται")));
await gio.page.getByRole("tab", { name: "Κοντά μου" }).click();
ok("… and Giorgos doesn't see me", await gone(gio.page.getByRole("button", { name: "Βασίλης Χαρ" }), 10_000));
await me.page.getByRole("button", { name: "Ορατός ξανά" }).click();
ok("I'm back: Giorgos sees me", await seen(gio.page.getByRole("button", { name: "Βασίλης Χαρ" }), 15_000));

// 8. Block (Giorgos blocks me from my card on his map): we vanish from each other's maps, my follow ends
await gio.page.getByRole("button", { name: "Βασίλης Χαρ" }).click();
await gio.page.getByRole("button", { name: "Επιλογές" }).click();
await gio.page.getByRole("button", { name: "Αποκλεισμός" }).click();
await gio.page.getByRole("button", { name: "Αποκλεισμός" }).last().click();
ok("block stored, my follow of him removed", (await sqlUntil(`select count(*) from public.blocks where blocker_id = '${USERS.giorgos.id}'`, "1")) === "1"
  && sql(`select count(*) from public.follows where follower_id = '${USERS.me.id}' and followee_id = '${USERS.giorgos.id}'`) === "0");
await me.page.getByRole("tab", { name: "Κοντά μου" }).click();
ok("blocked: he is gone from my map", await gone(me.page.getByRole("button", { name: "Γιώργος Κ." }), 12_000));
ok("blocked: I am gone from his", await gone(gio.page.getByRole("button", { name: "Βασίλης Χαρ" }), 12_000));
await me.page.screenshot({ path: `${S}/map-4-after-block.png` });

await done();

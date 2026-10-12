// Push to talk on the map between two strangers ~100 m apart (kit flow + this app's additions): the one-time safety
// notice, knock → the other phone joins and hears it live anywhere in the app (banner), answer from his card, saved +
// notice, report one transmission, "nobody" setting, server refusal.
import { base, done, hold, ok, open, rx, S, seen, sql, sqlUntil, USERS } from "./lib.mjs";

const ME = USERS.me.id, GIO = USERS.giorgos.id, ELENI = USERS.eleni.id;
// Everyone shares with everyone; Eleni (110 m south) takes voices from nobody.
sql(`insert into public.location_sharing (user_id, mode, talk_from) values ('${ME}', 'everyone', 'everyone'), ('${GIO}', 'everyone', 'everyone'), ('${ELENI}', 'everyone', 'nobody')`);
sql(`insert into private.user_locations (user_id, lat, lng) values ('${ELENI}', 37.9745, 23.7348)`);

const { page: gio } = await open("giorgos", "/profile", { geo: [37.9764, 23.7348] });
const { page: me } = await open("me", "/map", { geo: [37.9755, 23.7348], safetySeen: false });
await gio.mouse.click(200, 400); // a tap anywhere: iOS-style sound unlock
ok("both positions stored (tracker)", (await sqlUntil(`select count(*) from private.user_locations where user_id in ('${ME}','${GIO}')`, "2")) === "2");

// Me → Giorgos (strangers are on the "Κοντά μου" view)
await me.getByRole("tab", { name: "Κοντά μου" }).click();
await me.getByRole("button", { name: "Γιώργος Κ." }).click({ timeout: 15_000 });
ok("first time: the safety notice instead of the talk button", await seen(me.getByRole("alertdialog"))
  && !(await me.getByRole("button", { name: "Κράτα πατημένο και μίλα" }).isVisible()));
await me.screenshot({ path: `${S}/nearby-0-safety.png` });
await me.getByRole("button", { name: "Κατάλαβα" }).click();
ok("acknowledged → his card has the push-to-talk button", await seen(me.getByRole("button", { name: "Κράτα πατημένο και μίλα" }))
  && await me.getByRole("button", { name: "Κράτα πατημένο και μίλα" }).isEnabled());
await me.screenshot({ path: `${S}/nearby-1-card.png` });
const before = await rx(gio);
let banner = false;
await hold(me, 3500, async () => {
  banner = await gio.getByText("Βασίλης σου μιλάει").isVisible().catch(() => false);
  await gio.screenshot({ path: `${S}/nearby-2-banner.png` });
  await me.screenshot({ path: `${S}/nearby-3-talking.png` });
});
await me.waitForTimeout(2500);
const after = await rx(gio);
ok("the knock opened Giorgos's side while he is on another screen: banner 'Βασίλης σου μιλάει'", banner);
ok(`he heard it live (pieces ${after.pieces - before.pieces}, peak ${after.peak.toFixed(2)})`, after.pieces - before.pieces >= 6 && after.peak > 0.1);
ok("saved for 24 h + a 'nearby' notice for him", (await sqlUntil(`select count(*) from public.nearby_messages where sender_id='${ME}' and recipient_id='${GIO}'`, "1")) === "1"
  && sql(`select count(*) from public.notifications where user_id='${GIO}' and kind='nearby'`) === "1");

// Giorgos answers from his side (the banner is gone; open the map card via ?u=)
await gio.goto(base + `/map?u=${ME}`, { waitUntil: "load" });
ok("his map card for me shows the saved transmission", await seen(gio.getByText("Τελευταίες 24 ώρες"), 10_000));
await gio.screenshot({ path: `${S}/nearby-3b-his-card.png` });
const meBefore = await rx(me);
await hold(gio, 3000);
await gio.waitForTimeout(2500);
const meAfter = await rx(me);
ok(`my phone heard his answer live (pieces ${meAfter.pieces - meBefore.pieces})`, meAfter.pieces - meBefore.pieces >= 6);
ok("my card lists both transmissions", await seen(me.getByText(/^Γιώργος$/)) && await seen(me.getByText(/^Εσύ$/)));
await me.screenshot({ path: `${S}/nearby-4-history.png` });

// Giorgos reports my transmission (the flag on my row in his card)
await gio.getByRole("button", { name: "Αναφορά αυτής της εκπομπής" }).first().click();
await gio.getByRole("button", { name: "Αναφορά αυτής της εκπομπής" }).last().click(); // the sheet's menu row
await gio.getByRole("button", { name: "Παρενόχληση" }).click();
ok("report of that one transmission stored (kind nearby, its id)", await seen(gio.getByText("Ευχαριστούμε για την αναφορά."))
  && sql(`select count(*) from public.reports r join public.nearby_messages m on m.id = r.target_id where r.kind = 'nearby' and r.reporter_id = '${GIO}' and m.sender_id = '${ME}'`) === "1");
await gio.getByRole("button", { name: "Τέλος" }).click();

// Eleni takes voices from nobody → disabled with a reason
await me.keyboard.press("Escape");
await me.waitForTimeout(600);
// (her marker sits under the map attribution in this viewport: open her card from the nearby list instead)
await me.getByRole("button", { name: /κοντά σου/ }).click();
await me.getByRole("button", { name: /Ελένη Μ\./ }).last().click();
ok("Eleni ('nobody'): button disabled, 'δεν δέχεται φωνές'", await seen(me.getByText(/δεν δέχεται φωνές/))
  && await me.getByRole("button", { name: "Κράτα πατημένο και μίλα" }).isDisabled());
await me.screenshot({ path: `${S}/nearby-5-nobody.png` });

// Server refusal: Giorgos switches to "nobody" and the answer window is closed; my open card still has the button
await me.keyboard.press("Escape");
await me.waitForTimeout(600);
await me.getByRole("button", { name: /κοντά σου/ }).click();
await me.getByRole("button", { name: /Γιώργος Κ\./ }).last().click();
await me.waitForTimeout(1500);
sql(`update public.location_sharing set talk_from='nobody' where user_id='${GIO}'`);
sql(`delete from private.nearby_knocks`);
const g2 = await rx(gio);
// The map refresh (every 5 s) may turn the button off before the press — the server refused through map_people then.
const offAlready = await me.getByRole("button", { name: "Κράτα πατημένο και μίλα" }).isDisabled();
let offDuring = false;
if (!offAlready)
  await hold(me, 1500, async () => {
    offDuring = await me.getByRole("button", { name: "Κράτα πατημένο και μίλα" }).isDisabled();
  });
const toastSeen = await seen(me.getByText(/Δεν μπορείς να μιλήσεις/), 4000);
await me.screenshot({ path: `${S}/nearby-6-refused.png` });
await me.waitForTimeout(2500);
const g3 = await rx(gio);
ok(`refused by the server: the toast${offAlready || offDuring ? " (or the map refresh turned the button off first)" : ""}`, toastSeen || offAlready || offDuring);
ok(`… nothing heard on his side (${g3.pieces - g2.pieces} pieces)`, g3.pieces === g2.pieces);
ok("… nothing saved", sql(`select count(*) from public.nearby_messages where sender_id='${ME}'`) === "1");
ok("… the button turns off after the map refresh", await me.getByRole("button", { name: "Κράτα πατημένο και μίλα" }).isDisabled()
  || await me.getByRole("button", { name: "Κράτα πατημένο και μίλα" }).waitFor({ state: "attached" }).then(async () => {
    for (let i = 0; i < 20; i++) { if (await me.getByRole("button", { name: "Κράτα πατημένο και μίλα" }).isDisabled()) return true; await me.waitForTimeout(500); }
    return false;
  }));
await done();

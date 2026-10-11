// Phase 2: the social layer. Follow back from a notice, follower / following lists (paged, remove a follower),
// suggestions, block → blocked list → unblock, report, report/block on the walkie screen, the admin queue
// (disable an account → that person is suspended and hidden; enable again).
import { base, done, gone, ok, open, S, seen, sql, sqlUntil, USERS } from "./lib.mjs";

const follows = (a, b) => sql(`select count(*) from public.follows where follower_id = '${USERS[a].id}' and followee_id = '${USERS[b].id}'`);

// 1. Notices: Maria follows me (seed) → "Follow back" right in the notice; opening the screen reads them
const me = await open("me", "/notifications");
ok("follow notice from Maria with a 'Follow back' button", await seen(me.page.getByText("Μαρία Παπαδοπούλου σε ακολουθεί"))
  && await seen(me.page.getByRole("button", { name: "Ακολούθησε κι εσύ" })));
await me.page.getByRole("button", { name: "Ακολούθησε κι εσύ" }).click();
ok("follow back → stored, button turns to 'Ακολουθείς'", await seen(me.page.getByRole("button", { name: "Ακολουθείς" })) && follows("me", "maria") === "1");
ok("opening the screen marks the notices read", (await sqlUntil(`select count(*) from public.notifications where user_id = '${USERS.me.id}' and read_at is null`, "0")) === "0");
await me.page.screenshot({ path: `${S}/social-1-notices.png` });

// 2. My lists: followers (Maria, Nikos) with Remove; following (Nikos, Eleni, Maria)
await me.page.goto(base + "/profile", { waitUntil: "load" });
await me.page.getByRole("link", { name: /Ακόλουθοι/ }).click();
await me.page.waitForURL(/\/people\/.+\/followers$/);
ok("followers list: Maria and Nikos", await seen(me.page.getByText("@maria.papadopoulou")) && await seen(me.page.getByText(/@nikos\.georgiou/)));
await me.page.getByRole("listitem").filter({ hasText: "@nikos.georgiou" }).getByRole("button", { name: "Αφαίρεση" }).click();
ok("remove a follower: Nikos no longer follows me", await gone(me.page.getByText(/@nikos\.georgiou/)) && follows("nikos", "me") === "0");
await me.page.goto(base + `/people/${USERS.me.id}/following`, { waitUntil: "load" });
ok("following list: 3 people", await seen(me.page.getByText("@eleni.m")) && (await me.page.getByRole("listitem").count()) === 3);

// 3. Suggestions with an empty search box (Giorgos: not followed yet)
await me.page.goto(base + "/search", { waitUntil: "load" });
ok("suggestions: 'Ίσως γνωρίζεις' with Giorgos", await seen(me.page.getByText("Ίσως γνωρίζεις")) && await seen(me.page.getByText("@giorgos.k")));

// 4. Paging: Giorgos has 60 followers → 50, then "More" → 60
sql(`insert into auth.users (id, email, raw_user_meta_data) select ('00000000-0000-0000-0001-' || lpad(g::text, 12, '0'))::uuid, 'p' || g || '@x', ('{"age_confirmed":true,"full_name":"Πέτρος ' || g || '"}')::jsonb from generate_series(1, 60) g`);
sql(`insert into public.follows (follower_id, followee_id, created_at) select ('00000000-0000-0000-0001-' || lpad(g::text, 12, '0'))::uuid, '${USERS.giorgos.id}', now() - make_interval(secs => g) from generate_series(1, 60) g`);
await me.page.goto(base + `/people/${USERS.giorgos.id}/followers`, { waitUntil: "load" });
await seen(me.page.getByText("Πέτρος 1", { exact: true }));
ok("paged list: 50 first", (await me.page.getByRole("listitem").count()) === 50);
await me.page.getByRole("button", { name: "Περισσότεροι" }).click();
ok("… 'Περισσότεροι' loads the rest (60), then the button goes", await seen(me.page.getByText("Πέτρος 60", { exact: true }))
  && (await me.page.getByRole("listitem").count()) === 60 && await gone(me.page.getByRole("button", { name: "Περισσότεροι" })));

// 5. Block Maria from her profile → blocked list → unblock (follows not restored)
await me.page.goto(base + "/u/maria.papadopoulou", { waitUntil: "load" });
await me.page.getByRole("button", { name: "Επιλογές" }).click();
await me.page.getByRole("button", { name: "Αποκλεισμός" }).click();
await me.page.getByRole("button", { name: "Αποκλεισμός" }).last().click();
ok("blocked: follows both ways ended", (await sqlUntil(`select count(*) from public.blocks where blocker_id = '${USERS.me.id}'`, "1")) === "1"
  && follows("me", "maria") === "0" && follows("maria", "me") === "0");
await me.page.goto(base + "/profile", { waitUntil: "load" });
await me.page.getByRole("link", { name: "Αποκλεισμένοι" }).click();
ok("blocked list shows Maria", await seen(me.page.getByText("@maria.papadopoulou")));
await me.page.screenshot({ path: `${S}/social-2-blocked.png` });
await me.page.getByRole("button", { name: "Άρση" }).click();
ok("unblock: gone from the list, no block row, follows not restored", await gone(me.page.getByText("@maria.papadopoulou"))
  && sql(`select count(*) from public.blocks where blocker_id = '${USERS.me.id}'`) === "0" && follows("maria", "me") === "0");

// 6. Report Giorgos from his profile
await me.page.goto(base + "/u/giorgos.k", { waitUntil: "load" });
await me.page.getByRole("button", { name: "Επιλογές" }).click();
await me.page.getByRole("button", { name: "Αναφορά" }).click();
await me.page.getByRole("button", { name: "Spam" }).click();
ok("report sent: thanks + offer to block", await seen(me.page.getByText("Ευχαριστούμε για την αναφορά.")) && await seen(me.page.getByRole("button", { name: "Αποκλεισμός επίσης" })));
ok("report stored", sql(`select count(*) from public.reports where reporter_id = '${USERS.me.id}' and target_user_id = '${USERS.giorgos.id}' and reason = 'spam'`) === "1");
await me.page.getByRole("button", { name: "Τέλος" }).click();

// 7. Report / block on the walkie screen too
await me.page.goto(base + `/talk/${USERS.nikos.id}`, { waitUntil: "load" });
await me.page.getByRole("button", { name: "Επιλογές" }).click();
ok("walkie screen: ⋯ opens report / block", await seen(me.page.getByRole("button", { name: "Αναφορά" })) && await seen(me.page.getByRole("button", { name: "Αποκλεισμός" })));
await me.page.keyboard.press("Escape");

// 8. Not an admin: no moderation link, the screen shows nothing
await me.page.goto(base + "/profile", { waitUntil: "load" });
await seen(me.page.getByRole("link", { name: "Αποκλεισμένοι" }));
ok("non-admin: no moderation link", !(await me.page.getByRole("link", { name: /moderation/ }).isVisible()));
await me.page.goto(base + "/admin", { waitUntil: "load" });
await me.page.waitForTimeout(1500);
ok("non-admin: /admin shows no queue", (await me.page.getByRole("listitem").count()) === 0);

// 9. Eleni is an admin: queue → disable Giorgos
sql(`insert into private.admins (user_id) values ('${USERS.eleni.id}')`);
const eleni = await open("eleni", "/profile");
await eleni.page.getByRole("link", { name: /moderation/ }).click();
const item = eleni.page.getByRole("listitem", { name: "report giorgos.k" });
ok("admin queue: the report on @giorgos.k, with its count", await seen(item) && await seen(item.getByText("1 ανοιχτή αναφορά")));
await eleni.page.screenshot({ path: `${S}/social-3-admin.png` });
await item.getByRole("button", { name: "Απενεργοποίηση λογαριασμού" }).click();
ok("disabled: stored, report closed as disabled", (await sqlUntil(`select disabled::text from public.profiles where id = '${USERS.giorgos.id}'`, "true")) === "true"
  && sql(`select resolution from public.reports where target_user_id = '${USERS.giorgos.id}'`) === "disabled");
ok("… queue empty now", await seen(eleni.page.getByText("Καμία αναφορά.")));

// 10. Giorgos: suspended screen; others can't find him
const gio = await open("giorgos", "/map");
ok("the disabled account sees the suspension screen", await seen(gio.page.getByText("Ο λογαριασμός σου είναι σε αναστολή")));
await gio.page.screenshot({ path: `${S}/social-4-suspended.png` });
await me.page.goto(base + "/u/giorgos.k", { waitUntil: "load" });
ok("others: his profile is gone", await seen(me.page.getByText("Αυτός ο λογαριασμός δεν υπάρχει.")));

// 11. Enable again from the resolved tab
await eleni.page.getByRole("tab", { name: "Κλεισμένες" }).click();
await eleni.page.getByRole("button", { name: "Επανενεργοποίηση" }).click();
ok("enabled again", (await sqlUntil(`select disabled::text from public.profiles where id = '${USERS.giorgos.id}'`, "false")) === "false");
await gio.page.reload({ waitUntil: "load" });
ok("… and Giorgos is back in the app", await seen(gio.page.getByRole("link", { name: "Χάρτης" })));

await done();

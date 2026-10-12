// Hear friends anywhere in the app (kit): channel on → the friend's voice plays on another screen with the banner;
// unheard count + notice; opening the notice reads it; channel off → no banner, the friend sees you away.
import { base, done, hold, ok, open, rx, S, unlock, USERS } from "./lib.mjs";

const { page: me } = await open("me", "/talk");
await me.waitForTimeout(1500);
ok("walkie list: Νίκος with a channel switch", await me.getByText("Νίκος", { exact: false }).first().isVisible() && (await me.getByRole("switch").count()) >= 1);
await me.screenshot({ path: `${S}/walkie2-1-list.png` });
const row = me.locator("li", { hasText: "Νίκος" }).first();
await row.getByRole("switch").click();
await me.waitForTimeout(1500);
ok("channel on for Νίκος", (await row.getByRole("switch").getAttribute("aria-checked")) === "true");
await me.goto(base + "/profile", { waitUntil: "load" });
await me.waitForTimeout(2000);
await me.mouse.click(200, 300); // a tap anywhere unlocks sound
await me.waitForTimeout(300);
const { page: nik } = await open("nikos", `/talk/${USERS.me.id}`);
await nik.waitForTimeout(3000);
ok("Νίκος sees me here while I'm on my profile", await nik.getByText(/είναι εδώ/).isVisible());
await unlock(nik);
const before = await rx(me);
let banner = false;
await hold(nik, 2500, async () => {
  banner = await me.getByText("Νίκος σου μιλάει").isVisible().catch(() => false);
  await me.screenshot({ path: `${S}/walkie2-2-banner.png` });
});
await me.waitForTimeout(800);
const after = await rx(me);
ok("banner 'Νίκος σου μιλάει' on another screen", banner);
ok(`live pieces played there (${after.pieces - before.pieces}, peak ${after.peak.toFixed(2)})`, after.pieces - before.pieces >= 6 && after.peak > 0.1);
await me.waitForTimeout(2500);
ok("banner gone after he stops", !(await me.getByText("Νίκος σου μιλάει").isVisible().catch(() => false)));
await me.goto(base + "/talk", { waitUntil: "load" });
await me.waitForTimeout(1500);
ok("list: 1 new transmission from Νίκος", await me.getByText("1 νέα εκπομπή").isVisible());
await me.goto(base + "/notifications", { waitUntil: "load" });
await me.waitForTimeout(1500);
ok("notice 'σου μίλησε στο walkie-talkie'", await me.getByText(/σου μίλησε στο walkie-talkie/).isVisible());
await me.screenshot({ path: `${S}/walkie2-3-notice.png` });
await me.getByText(/σου μίλησε στο walkie-talkie/).click();
await me.waitForTimeout(2000);
ok("the notice opens Νίκος's walkie, channel switch on", me.url().includes(`/talk/${USERS.nikos.id}`) && (await me.getByRole("switch").getAttribute("aria-checked")) === "true");
await me.goto(base + "/talk", { waitUntil: "load" });
await me.waitForTimeout(1500);
ok("after opening it: nothing unheard", !(await me.getByText("1 νέα εκπομπή").isVisible().catch(() => false)));
// Channel off → no banner elsewhere.
await me.locator("li", { hasText: "Νίκος" }).first().getByRole("switch").click();
await me.waitForTimeout(1200);
await me.goto(base + "/profile", { waitUntil: "load" });
await me.waitForTimeout(3000);
ok("channel off: Νίκος sees me away", await nik.getByText(/λείπει/).isVisible());
let banner2 = false;
await hold(nik, 1500, async () => { banner2 = await me.getByText("Νίκος σου μιλάει").isVisible().catch(() => false); });
ok("channel off: no banner", !banner2);
await done();

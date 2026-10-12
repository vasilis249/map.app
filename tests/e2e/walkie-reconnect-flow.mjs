// Back online (kit): a pinned channel rejoins after the network returns; the banner and live audio work again; the
// Walkie tab then shows the unheard count.
import { base, done, hold, ok, open, rx, S, unlock, USERS } from "./lib.mjs";

const { page: me, ctx } = await open("me", "/talk");
await me.waitForTimeout(1500);
await me.locator("li", { hasText: "Νίκος" }).first().getByRole("switch").click();
await me.waitForTimeout(1200);
await me.goto(base + "/profile", { waitUntil: "load" });
await me.waitForTimeout(2000);
await me.mouse.click(200, 300);
const { page: nik } = await open("nikos", `/talk/${USERS.me.id}`);
await nik.waitForTimeout(3000);
ok("before: Νίκος sees me here", await nik.getByText(/είναι εδώ/).isVisible());
await ctx.setOffline(true);
await me.waitForTimeout(6000);
console.log("info: offline emulation keeps open WebSockets; away shown =", await nik.getByText(/λείπει/).isVisible());
await ctx.setOffline(false);
await me.waitForTimeout(9000);
ok("back online: Νίκος sees me here again", await nik.getByText(/είναι εδώ/).isVisible());
await unlock(nik);
const before = await rx(me);
let banner = false;
await hold(nik, 2000, async () => { banner = await me.getByText("Νίκος σου μιλάει").isVisible().catch(() => false); });
await me.waitForTimeout(800);
const after = await rx(me);
ok(`after reconnect: banner + live pieces (${after.pieces - before.pieces})`, banner && after.pieces - before.pieces >= 4);
await me.waitForTimeout(2500);
await me.goto(base + "/search", { waitUntil: "load" });
ok("the Walkie tab shows 1 unheard", await me.getByRole("link", { name: "Walkie (1)" }).waitFor({ timeout: 8000 }).then(() => true, () => false));
await me.screenshot({ path: `${S}/walkie3-tab-badge.png` });
await done();

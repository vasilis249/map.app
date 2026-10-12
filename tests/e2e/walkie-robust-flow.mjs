// Robustness (kit): a socket cut mid-transmission on either side, a press shorter than the (slow, iOS-like) mic start.
import { done, errors, hold, ok, open, rx, unlock, USERS } from "./lib.mjs";

const { page: me } = await open("me", `/talk/${USERS.nikos.id}`);
const { page: nik } = await open("nikos", `/talk/${USERS.me.id}`);
await me.waitForTimeout(3000);
for (const p of [me, nik]) await unlock(p);
const cut = (p) => p.evaluate(() => window.__sockets.filter((s) => s.readyState === 1).forEach((s) => s.close()));

// (a) the speaker's socket drops mid-transmission: pieces wait on the phone and all arrive after the rejoin
let b = (await rx(nik)).pieces;
await hold(me, 5000);
const a0 = (await rx(nik)).pieces - b;
await me.waitForTimeout(1500);
b = (await rx(nik)).pieces;
const hold2 = hold(me, 5000);
await me.waitForTimeout(1200);
await cut(me);
await hold2;
await nik.waitForTimeout(6000);
const a1 = (await rx(nik)).pieces - b;
ok(`(a) speaker's socket cut mid-way: pieces still arrive (${a1} vs ${a0} uncut)`, a1 >= a0 * 0.8);

// (b) the listener's socket drops mid-transmission: the saved copy plays right after
await me.waitForTimeout(2000);
const r0 = await nik.evaluate(() => window.__replays);
const hold3 = hold(me, 4000);
await me.waitForTimeout(800);
await cut(nik);
await hold3;
await nik.waitForTimeout(12000);
const replays = (await nik.evaluate(() => window.__replays)) - r0;
ok(`(b) listener's socket cut mid-way: the saved copy is replayed once (${replays})`, replays === 1);
const r1 = await nik.evaluate(() => window.__replays);
b = (await rx(nik)).pieces;
await hold(me, 3000);
await nik.waitForTimeout(9000);
ok(`(b2) heard completely live → no replay (${(await nik.evaluate(() => window.__replays)) - r1}), live pieces ${(await rx(nik)).pieces - b}`,
  (await nik.evaluate(() => window.__replays)) === r1 && (await rx(nik)).pieces - b >= 8);

// (c) let go before the (slow) mic is ready: hint, nothing on the other side
await me.evaluate(() => { window.__gumDelay = 1200; });
b = (await rx(nik)).pieces;
let flash = false;
const watch = (async () => { for (let i = 0; i < 20; i++) { if (await nik.getByText(/μιλάει…/).isVisible().catch(() => false)) flash = true; await nik.waitForTimeout(100); } })();
await hold(me, 400);
await watch;
ok("(c) short press: 'hold until the beep' hint", await me.getByText(/ώσπου να ακουστεί το μπιπ/).isVisible());
ok(`(c) short press: the friend sees and hears nothing (${(await rx(nik)).pieces - b} pieces, flash ${flash})`, (await rx(nik)).pieces === b && !flash);
await me.evaluate(() => { window.__gumDelay = 0; });
// Socket cuts log connection errors on purpose; only other errors count.
errors.splice(0, errors.length, ...errors.filter((e) => !/WebSocket|socket|realtime/i.test(e)));
await done();

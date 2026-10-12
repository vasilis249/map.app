// Walkie-talkie between two friends (fake mic = 440 Hz tone), ported from the Speak kit: presence, live audio
// arrives while holding, one speaker at a time, saved for replay, non-friends kept out (screen and a hand-made join).
import { done, hold, ok, open, rx, S, unlock, USERS } from "./lib.mjs";

const ME = USERS.me.id, NIK = USERS.nikos.id;
const { page: me } = await open("me", `/talk/${NIK}`);
const { page: nik } = await open("nikos", `/talk/${ME}`);
await me.waitForTimeout(3000);
ok("presence: each sees the other is here", await me.getByText(/είναι εδώ/).isVisible() && await nik.getByText(/είναι εδώ/).isVisible());
for (const p of [me, nik]) await unlock(p);
await me.screenshot({ path: `${S}/walkie-1-idle.png` });

const during = {};
await hold(me, 2600, async () => {
  during.status = await nik.getByText(/μιλάει…/).isVisible();
  during.meStatus = await me.getByText(/Μιλάς/).isVisible();
  during.rx = await rx(nik);
  await nik.screenshot({ path: `${S}/walkie-2-hearing.png` });
  await me.screenshot({ path: `${S}/walkie-3-talking.png` });
});
ok("while holding: 'Μιλάς' for me, 'μιλάει…' for the friend", during.status && during.meStatus);
ok(`live: pieces arrive while I still talk (${during.rx.pieces}) and carry the tone (peak ${during.rx.peak.toFixed(2)})`, during.rx.pieces >= 5 && during.rx.peak > 0.1);
await nik.waitForTimeout(2500);
ok("released: the friend's screen is back to idle", await nik.getByText(/είναι εδώ/).isVisible());
ok(`nothing echoes back to me (${(await rx(me)).pieces} pieces)`, (await rx(me)).pieces === 0);
ok("saved: one entry in both histories", (await me.locator("li").count()) === 1 && (await nik.locator("li").count()) === 1);

// One speaker at a time: while Nikos talks, my press is refused.
const refused = {};
await hold(nik, 2200, async () => {
  const before = (await rx(nik)).pieces;
  await hold(me, 800);
  await nik.waitForTimeout(600);
  refused.echo = (await rx(nik)).pieces - before;
  refused.meHears = (await rx(me)).pieces;
});
ok(`one at a time: my press while Nikos talks sends nothing (${refused.echo}) and I hear him (${refused.meHears})`, refused.echo === 0 && refused.meHears >= 3);
await me.waitForTimeout(2500);
ok("two saved transmissions now", (await me.locator("li").count()) === 2);

// Replay from history (audio element).
await nik.locator("li").last().getByRole("button").first().click();
await nik.waitForTimeout(1500);
ok("replay plays (no error)", !(await nik.getByText("Δεν ήταν δυνατή η αναπαραγωγή.").isVisible().catch(() => false)));
await nik.screenshot({ path: `${S}/walkie-4-history.png` });

// Not friends: no channel.
const { page: maria } = await open("maria", `/talk/${ME}`);
await maria.waitForTimeout(1500);
ok("non-friend: 'only if you follow each other', no button", await maria.getByText(/μόνο αν ακολουθείτε/).isVisible()
  && await maria.getByRole("button", { name: "Κράτα πατημένο και μίλα" }).isDisabled());
// … and even a hand-made join to our channel is refused by the policies.
const topic = ME < NIK ? `walkie:${ME}:${NIK}` : `walkie:${NIK}:${ME}`;
const sneak = await maria.evaluate(async (topic) => {
  const tok = JSON.parse(localStorage.getItem("sb-127-auth-token")).access_token;
  return await new Promise((res) => {
    const ws = new WebSocket("ws://127.0.0.1:54321/realtime/v1/websocket?apikey=x&vsn=2.0.0");
    ws.onopen = () => ws.send(JSON.stringify(["1", "1", "realtime:" + topic, "phx_join", { config: { private: true, broadcast: { self: false }, presence: { key: "" } }, access_token: tok }]));
    ws.onmessage = (e) => { const [, , , ev, p] = JSON.parse(e.data); if (ev === "phx_reply") { ws.close(); res(p.status); } };
    setTimeout(() => res("timeout"), 3000);
  });
}, topic);
ok(`outsider's direct join refused (${sneak})`, sneak === "error");
await done();

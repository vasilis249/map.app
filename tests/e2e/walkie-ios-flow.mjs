// iOS model (kit): every audio-session switch (press → play-and-record, release → playback, a recording elsewhere)
// suspends every AudioContext. The engine's wakeAudio() must keep live pieces flowing turn after turn (LESSONS #1).
import { done, hold, ok, open, rx, unlock, USERS } from "./lib.mjs";

const { page: me } = await open("me", `/talk/${USERS.nikos.id}`, { ios: true });
const { page: nik } = await open("nikos", `/talk/${USERS.me.id}`, { ios: true });
await me.waitForTimeout(3000);
for (const p of [me, nik]) await unlock(p);
for (const [who, other, tag] of [[me, nik, "1 me→nik"], [nik, me, "2 nik→me"], [me, nik, "3 me→nik"], [nik, me, "4 nik→me"]]) {
  const before = (await rx(other)).pieces;
  await hold(who, 2400);
  await other.waitForTimeout(1500);
  const got = (await rx(other)).pieces - before;
  ok(`turn ${tag}: live pieces heard (${got})`, got >= 5);
}
ok("audio session was switched (iOS model active)", (await me.evaluate(() => window.__switches)) >= 4);
// A recording elsewhere in the app also switches the session.
await nik.evaluate(() => { navigator.audioSession.type = "play-and-record"; navigator.audioSession.type = "playback"; });
const b5 = (await rx(nik)).pieces;
await hold(me, 2400);
await nik.waitForTimeout(1500);
ok(`after a session switch elsewhere: still heard (${(await rx(nik)).pieces - b5})`, (await rx(nik)).pieces - b5 >= 5);
await done();

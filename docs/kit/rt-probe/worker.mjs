// Probe of the REAL Supabase Realtime path for the walkie (2026-10-03): two signed-in users join the private
// walkie channel, A sends start + 6 binary pieces + end, the reply says what B received. Deploy temporarily
// (`npx wrangler deploy` here), POST {url, anon, tokA, tokB, a, b} with two temporary verified-student friends,
// then `npx wrangler delete --name speak-rtprobe` and delete the users. The container cannot open WebSockets;
// a Worker can.
import { createClient } from "@supabase/supabase-js";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export default {
  async fetch(req) {
    if (req.method !== "POST") return new Response("no", { status: 405 });
    const { url, anon, tokA, tokB, a, b, kind = "walkie", vsn } = await req.json();
    const topic = a < b ? `${kind}:${a}:${b}` : `${kind}:${b}:${a}`;
    const log = [];
    const mk = (tok) => {
      const c = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${tok}` } }, realtime: vsn ? { vsn } : {} });
      c.realtime.setAuth(tok);
      return c;
    };
    const A = mk(tokA), B = mk(tokB);
    const got = { start: 0, audio: 0, audioTypes: [], audioBytes: [], end: 0, presenceA: 0 };
    const sub = (cli, me, tag, wire) => new Promise((res) => {
      const ch = cli.channel(topic, { config: { private: true, broadcast: { self: false }, presence: { key: me } } });
      wire?.(ch);
      ch.subscribe((s, err) => { log.push(`${tag}:${s}${err ? " " + err.message : ""}`); if (s !== "CLOSED") res([ch, s]); });
      setTimeout(() => res([ch, "timeout"]), 8000);
    });
    const [chB, sB] = await sub(B, b, "B", (ch) => ch
      .on("broadcast", { event: "start" }, () => got.start++)
      .on("broadcast", { event: "audio" }, ({ payload }) => { got.audio++; got.audioTypes.push(Object.prototype.toString.call(payload)); got.audioBytes.push(payload?.byteLength ?? JSON.stringify(payload).length); })
      .on("broadcast", { event: "end" }, () => got.end++)
      .on("presence", { event: "sync" }, () => { got.presenceA = (ch.presenceState()[a]?.length ?? 0); }));
    const [chA, sA] = await sub(A, a, "A");
    if (sB === "SUBSCRIBED") await chB.track({ at: Date.now() });
    if (sA === "SUBSCRIBED") await chA.track({ at: Date.now() });
    await wait(800);
    const sends = [];
    sends.push(await chA.send({ type: "broadcast", event: "start", payload: { sid: "x", at: Date.now() } }));
    for (let i = 0; i < 6; i++) {
      const buf = new ArrayBuffer(4005); new Uint8Array(buf)[0] = 1; new DataView(buf).setUint32(1, i);
      sends.push(await chA.send({ type: "broadcast", event: "audio", payload: buf }));
      await wait(250);
    }
    sends.push(await chA.send({ type: "broadcast", event: "end", payload: { sid: "x", ms: 1500 } }));
    await wait(2500);
    await A.removeAllChannels(); await B.removeAllChannels();
    return Response.json({ topic, log, sends, got });
  },
};

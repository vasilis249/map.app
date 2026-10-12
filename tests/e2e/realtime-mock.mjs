// Minimal Supabase Realtime for local UI tests: Phoenix protocol vsn 2.0.0 (JSON arrays + binary user broadcasts),
// broadcast relay, presence, and private-channel authorization evaluated by the real RLS policies through
// PostgREST (public.rt_authorize, tests/e2e/rt_mock.sql), broadcasts from the database (realtime.send, polled via
// public.rt_poll). No postgres_changes events (joins are accepted).
import http from "node:http";
import { createRequire } from "node:module";
const { WebSocketServer } = createRequire(new URL("../../node_modules/", import.meta.url).pathname)("ws");

function authorize(token, topic) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ p_topic: topic });
    const r = http.request({ host: "127.0.0.1", port: 3001, path: "/rpc/rt_authorize", method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" } }, (up) => {
      let d = ""; up.on("data", (c) => (d += c));
      up.on("end", () => { try { resolve(up.statusCode === 200 ? JSON.parse(d) : { read: false, write: false }); } catch { resolve({ read: false, write: false }); } });
    });
    r.on("error", () => resolve({ read: false, write: false }));
    r.end(body);
  });
}

export function attachRealtime(server) {
  const wss = new WebSocketServer({ noServer: true });
  const topics = new Map(); // topic -> Map(ws -> member)
  let refN = 0;
  // Broadcast from the database (realtime.send → realtime.messages rows with an event): relay to the topic. The
  // poll carries the database it last saw: after a reset (a new database) it starts again from its first row.
  let after = 0;
  let db = null;
  const poll = () => new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port: 3001, path: "/rpc/rt_poll", method: "POST", headers: { "content-type": "application/json" } }, (up) => {
      let d = ""; up.on("data", (c) => (d += c));
      up.on("end", () => { try { resolve(up.statusCode === 200 ? JSON.parse(d) : null); } catch { resolve(null); } });
    });
    r.on("error", () => resolve(null));
    r.end(JSON.stringify({ p_after: after, p_db: db }));
  });
  (async () => {
    for (;;) {
      const res = await poll();
      if (res && typeof res === "object" && "db" in res) {
        const first = db === null;
        db = res.db;
        after = res.after;
        if (!first)
          for (const m of res.rows) {
            const t = "realtime:" + m.topic;
            for (const [w] of topics.get(t) ?? []) send(w, [null, null, t, "broadcast", { type: "broadcast", event: m.event, payload: m.payload }]);
          }
        if (res.rows.length === 100) continue; // more waiting
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  })();
  server.on("upgrade", (req, socket, head) => {
    if (!req.url.startsWith("/realtime/v1/websocket")) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  const send = (ws, arr) => ws.readyState === 1 && ws.send(JSON.stringify(arr));
  const stateOf = (topic) => {
    const out = {};
    for (const m of topics.get(topic)?.values() ?? []) if (m.presence) (out[m.key] ??= { metas: [] }).metas.push(m.presence);
    return out;
  };
  const toMembers = (topic, fn) => { for (const [w, m] of topics.get(topic) ?? []) fn(w, m); };
  function leave(ws, topic) {
    const members = topics.get(topic);
    const m = members?.get(ws);
    if (!m) return;
    members.delete(ws);
    if (m.presence) toMembers(topic, (w, o) => o.presenceOn && send(w, [o.joinRef, null, topic, "presence_diff", { joins: {}, leaves: { [m.key]: { metas: [m.presence] } } }]));
  }
  wss.on("connection", (ws) => {
    const mine = new Set();
    ws.on("message", async (data, isBinary) => {
      if (isBinary) {
        const buf = new Uint8Array(data);
        if (buf[0] !== 3) return;
        const [jl, rl, tl, el, ml, enc] = buf.slice(1, 7);
        let o = 7;
        const dec = (n) => { const s = Buffer.from(buf.slice(o, o + n)).toString(); o += n; return s; };
        const joinRef = dec(jl), ref = dec(rl), topic = dec(tl), event = dec(el), meta = dec(ml);
        const payload = buf.slice(o);
        const me = topics.get(topic)?.get(ws);
        if (!me || (me.private && !me.write)) return;
        const te = new TextEncoder();
        const t = te.encode(topic), e = te.encode(event), md = te.encode(meta);
        const out = new Uint8Array(5 + t.length + e.length + md.length + payload.length);
        out.set([4, t.length, e.length, md.length, enc]);
        let p = 5; out.set(t, p); p += t.length; out.set(e, p); p += e.length; out.set(md, p); p += md.length; out.set(payload, p);
        toMembers(topic, (w) => { if (w !== ws || me.self) w.readyState === 1 && w.send(out); });
        if (ref && me.ack) send(ws, [joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]);
        return;
      }
      const [joinRef, ref, topic, event, payload] = JSON.parse(data.toString());
      if (topic === "phoenix" && event === "heartbeat") return send(ws, [null, ref, "phoenix", "phx_reply", { status: "ok", response: {} }]);
      if (event === "phx_join") {
        const cfg = payload.config ?? {};
        let rights = { read: true, write: true };
        if (cfg.private) rights = await authorize(payload.access_token, topic.replace(/^realtime:/, ""));
        if (!rights.read) return send(ws, [joinRef, ref, topic, "phx_reply", { status: "error", response: { reason: "Unauthorized: You do not have permissions to read from this Channel topic: " + topic } }]);
        const pc = (cfg.postgres_changes ?? []).map((b, i) => ({ ...b, id: i + 1 }));
        if (!topics.has(topic)) topics.set(topic, new Map());
        topics.get(topic).set(ws, { joinRef, key: cfg.presence?.key || crypto.randomUUID(), presence: null, presenceOn: !!cfg.presence,
          self: !!cfg.broadcast?.self, ack: !!cfg.broadcast?.ack, private: !!cfg.private, write: rights.write });
        mine.add(topic);
        send(ws, [joinRef, ref, topic, "phx_reply", { status: "ok", response: { postgres_changes: pc } }]);
        send(ws, [joinRef, null, topic, "presence_state", stateOf(topic)]);
        return;
      }
      const me = topics.get(topic)?.get(ws);
      if (event === "phx_leave") { leave(ws, topic); mine.delete(topic); return send(ws, [joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]); }
      if (!me) return send(ws, [joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]);
      if (event === "presence") {
        if (me.private && !me.write) return send(ws, [joinRef, ref, topic, "phx_reply", { status: "error", response: { reason: "Unauthorized" } }]);
        const old = me.presence;
        if (payload.event === "track") me.presence = { phx_ref: String(++refN), ...payload.payload };
        else me.presence = null;
        const joins = me.presence ? { [me.key]: { metas: [me.presence] } } : {};
        const leaves = old ? { [me.key]: { metas: [old] } } : {};
        toMembers(topic, (w, o) => o.presenceOn && send(w, [o.joinRef, null, topic, "presence_diff", { joins, leaves }]));
        return send(ws, [joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]);
      }
      if (event === "broadcast") {
        if (!(me.private && !me.write)) toMembers(topic, (w) => { if (w !== ws || me.self) send(w, [null, null, topic, "broadcast", payload]); });
        return ref && send(ws, [joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]);
      }
      return send(ws, [joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]);
    });
    ws.on("close", () => { for (const t of mine) leave(ws, t); });
  });
}

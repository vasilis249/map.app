// Local stand-in for the routing / search provider (Stadia Maps' API shape), served by local-supabase.mjs under
// /routing. Answers come from the real Valhalla responses recorded for the unit tests: the Syntagma → Koukaki trip
// when asked from near Syntagma, else the recorded reroute. Every call is logged (GET /routing/_log) so flows can
// check what the Worker sent (and that the key never reached the browser).
import fs from "node:fs";

export const ROUTING_KEY = "local-routing-key"; // a test value for the local stack, not a credential
const fx = (n) => JSON.parse(fs.readFileSync(new URL(`../../src/lib/nav/fixtures/${n}.json`, import.meta.url)));
const MAIN = fx("valhalla-athens"), REROUTE = fx("valhalla-athens-reroute");
const PLACES = [
  ["Κουκάκι", "Αθήνα, Ελλάδα", 37.9715, 23.7267],
  ["Κουκάκι Πλατεία", "Αθήνα, Ελλάδα", 37.9668, 23.7266],
  ["Πλατεία Συντάγματος", "Αθήνα, Ελλάδα", 37.9755, 23.7348],
  ["Ακρόπολη", "Αθήνα, Ελλάδα", 37.9715, 23.7257],
];
const fold = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const log = [];

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

export function routing(req, res, url) {
  const path = url.pathname.replace(/^\/routing/, "");
  if (path === "/_log") return send(res, 200, log);
  if (path === "/_reset") return (log.length = 0), send(res, 200, {});
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const entry = { at: Date.now(), path, key: url.searchParams.get("api_key"), query: Object.fromEntries(url.searchParams), body: raw ? JSON.parse(raw) : null };
    log.push(entry);
    if (entry.key !== ROUTING_KEY) return send(res, 401, { error: "bad key" });
    if (path === "/route/v1" && req.method === "POST") {
      const from = entry.body.locations[0];
      // ≈ 150 m around the recorded trip's start (Syntagma) → that trip; anywhere else → the recorded reroute.
      const nearStart = Math.abs(from.lat - 37.9755) < 0.0014 && Math.abs(from.lon - 23.7348) < 0.0018;
      return send(res, 200, nearStart ? MAIN : REROUTE);
    }
    if (path === "/geocoding/v1/autocomplete") {
      const q = fold(url.searchParams.get("text") || "");
      const features = PLACES.filter(([n]) => fold(n).includes(q)).map(([name, area, lat, lng], i) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lng, lat] },
        properties: { gid: `mock:${i}`, name, label: `${name}, ${area}` },
      }));
      return send(res, 200, { type: "FeatureCollection", features });
    }
    send(res, 404, { error: "not found" });
  });
}

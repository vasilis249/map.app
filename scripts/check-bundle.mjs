// Deploy guard: refuses a build that would not work or would leak a secret.
//   - the client bundle must contain the Supabase URL and the publishable (anon) key it was built with;
//   - no file in dist/ (client or server) may contain a service-role key: a JWT whose role is service_role,
//     an `sb_secret_…` key, or the value of SUPABASE_SERVICE_ROLE_KEY when it is set in the environment;
//   - no file in dist/ may contain the routing provider key (ROUTING_API_KEY, when set): it lives only in the Worker's
//     secrets and is read at run time, never built in;
//   - first load stays light (performance / battery): the JavaScript the app needs before any screen (the client entry
//     and its static imports) ≤ 300 KB gzipped, and never the map (MapLibre) or the 3D layer (three.js) — those are
//     loaded when a screen needs them.
// Usage: node scripts/check-bundle.mjs   (after `vite build`, with VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY set)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const DIST = new URL("../dist", import.meta.url).pathname;
const url = process.env.VITE_SUPABASE_URL ?? "";
const anon = process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const routingKey = process.env.ROUTING_API_KEY ?? "";
const problems = [];

function files(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}
function jwtRole(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).role ?? null;
  } catch {
    return null;
  }
}

if (!url) problems.push("VITE_SUPABASE_URL is not set");
if (!anon) problems.push("VITE_SUPABASE_PUBLISHABLE_KEY is not set");
// Anything named VITE_* is built into the client: a secret must never be named so.
for (const k of Object.keys(process.env)) if (/^VITE_.*(ROUTING|STADIA|SERVICE|SECRET)/.test(k)) problems.push(`${k}: a VITE_ variable is public (built into the app)`);
if (anon.startsWith("sb_secret_") || jwtRole(anon) === "service_role") problems.push("VITE_SUPABASE_PUBLISHABLE_KEY is a SERVICE key");

let all;
try {
  all = files(DIST).filter((f) => /\.(m?js|html|css|json|map)$/.test(f));
} catch {
  problems.push("no dist/ — run `vite build` first");
  all = [];
}
const client = all.filter((f) => f.includes("/client/"));
const clientText = client.map((f) => readFileSync(f, "utf8")).join("\n");
if (client.length && url && !clientText.includes(url)) problems.push(`the client bundle doesn't contain the Supabase URL (${url})`);
if (client.length && anon && !clientText.includes(anon)) problems.push("the client bundle doesn't contain the publishable key it was built with");

const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
for (const f of all) {
  const text = readFileSync(f, "utf8");
  for (const t of text.match(JWT) ?? []) if (jwtRole(t) === "service_role") problems.push(`service_role JWT in ${f}`);
  if (/sb_secret_[A-Za-z0-9_-]{8,}/.test(text)) problems.push(`sb_secret_ key in ${f}`);
  if (serviceKey && text.includes(serviceKey)) problems.push(`SUPABASE_SERVICE_ROLE_KEY value in ${f}`);
  if (routingKey.length >= 8 && text.includes(routingKey)) problems.push(`ROUTING_API_KEY value in ${f}`);
}

// First-load budget: walk the client entry's static imports.
const assets = join(DIST, "client", "assets");
let entry = null;
try {
  entry = readdirSync(assets).find((f) => /^client-.*\.js$/.test(f)) ?? null;
} catch {
  entry = null;
}
if (entry) {
  const seen = new Set();
  const walk = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    const text = readFileSync(join(assets, f), "utf8");
    for (const m of text.matchAll(/(?:^|[;\n}])\s*import\s*(?:[^"(]*?from\s*)?"\.\/([^"]+\.js)"/g)) walk(m[1]);
  };
  walk(entry);
  const gz = [...seen].reduce((n, f) => n + gzipSync(readFileSync(join(assets, f))).length, 0);
  if (gz > 300 * 1024) problems.push(`first-load JavaScript is ${Math.round(gz / 1024)} KB gzipped (budget 300 KB)`);
  for (const f of seen) if (/^(maplibre-gl|three\.module)/.test(f)) problems.push(`${f} is loaded up front (should be lazy)`);
  console.log(`first load: ${seen.size} files, ${Math.round(gz / 1024)} KB gzipped`);
}

if (problems.length) {
  console.error("Deploy refused:\n  - " + [...new Set(problems)].join("\n  - "));
  process.exit(1);
}
console.log(`bundle ok: ${all.length} files checked, Supabase URL + publishable key present, no service key`);

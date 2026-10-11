// Deploy guard: refuses a build that would not work or would leak a secret.
//   - the client bundle must contain the Supabase URL and the publishable (anon) key it was built with;
//   - no file in dist/ (client or server) may contain a service-role key: a JWT whose role is service_role,
//     an `sb_secret_…` key, or the value of SUPABASE_SERVICE_ROLE_KEY when it is set in the environment.
// Usage: node scripts/check-bundle.mjs   (after `vite build`, with VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY set)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = new URL("../dist", import.meta.url).pathname;
const url = process.env.VITE_SUPABASE_URL ?? "";
const anon = process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
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
}

if (problems.length) {
  console.error("Deploy refused:\n  - " + [...new Set(problems)].join("\n  - "));
  process.exit(1);
}
console.log(`bundle ok: ${all.length} files checked, Supabase URL + publishable key present, no service key`);

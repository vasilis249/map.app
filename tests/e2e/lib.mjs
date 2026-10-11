// Shared helpers for the browser flows: Chromium (fake mic, WebGL via SwiftShader, the container's proxy for map
// tiles), signed-in contexts, PASS / FAIL lines, SQL against the local DB.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
const { chromium, devices } = createRequire("/opt/node22/lib/node_modules/")("playwright");

export const S = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
export const base = "http://127.0.0.1:" + process.argv[2];
export const SUPABASE = "http://127.0.0.1:54321";
export const USERS = {
  me: { id: "11111111-0000-0000-0000-000000000001", email: "me@test" },
  maria: { id: "22222222-0000-0000-0000-000000000002", email: "maria@test" },
  nikos: { id: "33333333-0000-0000-0000-000000000003", email: "nikos@test" },
  giorgos: { id: "44444444-0000-0000-0000-000000000004", email: "giorgos@test" },
  eleni: { id: "55555555-0000-0000-0000-000000000005", email: "eleni@test" },
};
export const errors = [];
export const ok = (label, cond) => console.log(cond ? "PASS" : "FAIL", label);
/** Waits until the locator is visible (isVisible() itself never waits). */
export const seen = (loc, ms = 8_000) => loc.first().waitFor({ state: "visible", timeout: ms }).then(() => true, () => false);
export const gone = (loc, ms = 8_000) => loc.first().waitFor({ state: "hidden", timeout: ms }).then(() => true, () => false);
export const sql = (q) => execSync(`psql -h /tmp -p 54329 -U postgres -d mapapp -Atc "${q.replace(/"/g, '\\"')}"`).toString().trim();
/** Polls a SQL query until it returns `want` (or the time is up); returns the last value. */
export async function sqlUntil(q, want, ms = 10_000) {
  const end = Date.now() + ms;
  let v = sql(q);
  while (v !== want && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 300));
    v = sql(q);
  }
  return v;
}

const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
export const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${S}/tone440.wav`,
    "--autoplay-policy=no-user-gesture-required", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
    // Map tiles (OpenFreeMap) go through the container's proxy; Chromium keeps loopback (the app, the local
    // Supabase) direct by itself. Playwright's own `proxy` option would force loopback through the proxy too.
    ...(proxy ? [`--proxy-server=${proxy}`] : [])],
});

/** A phone (iPhone 13 viewport, Greek, Athens) signed in as `who`, at `geo` if given, opened at `path`. */
export async function open(who, path, { geo, tag = who } = {}) {
  const u = USERS[who];
  const r = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: u.email, password: "test-pass-1" }),
  });
  const session = await r.json();
  if (!session.access_token) throw new Error(`sign-in failed for ${who}`);
  const ctx = await browser.newContext({
    ...devices["iPhone 13"], timezoneId: "Europe/Athens", locale: "el-GR", ignoreHTTPSErrors: true,
    permissions: ["microphone", ...(geo ? ["geolocation"] : [])],
    ...(geo ? { geolocation: { latitude: geo[0], longitude: geo[1], accuracy: 10 } } : {}),
  });
  await ctx.addInitScript((s) => { try { localStorage.setItem("sb-127-auth-token", JSON.stringify(s)); } catch { /* ignore */ } }, session);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${tag}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource|WebGL|GPU stall/i.test(m.text()) && errors.push(`${tag} console: ${m.text().slice(0, 200)}`));
  await page.goto(base + path, { waitUntil: "load" });
  return { page, ctx };
}

export async function done() {
  console.log("errors:", errors.length ? [...new Set(errors)].join(" | ") : "none");
  ok("no page errors", errors.length === 0);
  await browser.close();
}

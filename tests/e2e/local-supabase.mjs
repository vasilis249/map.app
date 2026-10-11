// Local "mini Supabase" for browser tests: proxies /rest/v1 to PostgREST (real RLS on the local Postgres), a small
// GoTrue for email + password (sign up, sign in, refresh, user, sign out — our own HS256 JWTs; accounts via the
// local-only SQL in local_auth.sql), Storage emulation (object rows in storage.objects with RLS through PostgREST,
// bytes on disk) and the Realtime mock (realtime-mock.mjs).
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { attachRealtime } from "./realtime-mock.mjs";

export const SECRET = "local-dev-secret-local-dev-secret-0123456789";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
export function jwt(claims, ttl = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ iat: now, exp: now + ttl, ...claims });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
function verify(token) {
  const [h, b, s] = (token || "").split(".");
  if (!s) return null;
  const sig = crypto.createHmac("sha256", SECRET).update(`${h}.${b}`).digest("base64url");
  if (sig !== s) return null;
  const c = JSON.parse(Buffer.from(b, "base64url").toString());
  return c.exp && c.exp < Date.now() / 1000 ? null : c;
}

const FILES = new URL("./storage-files", import.meta.url).pathname;
const ANON = jwt({ role: "anon" }, 365 * 86400);

/** POST to a PostgREST RPC (as anon unless a token is given). */
function rpc(fn, args, token = ANON) {
  return new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port: 3001, path: `/rpc/${fn}`, method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" } }, (up) => {
      let d = ""; up.on("data", (c) => (d += c));
      up.on("end", () => { try { resolve({ status: up.statusCode, body: d ? JSON.parse(d) : null }); } catch { resolve({ status: 500, body: null }); } });
    });
    r.on("error", () => resolve({ status: 502, body: null }));
    r.end(JSON.stringify(args));
  });
}

/** storage-js uploads a Blob as multipart/form-data (the file part + cacheControl): keep only the file part. */
function fileFromUpload(body, contentType = "application/octet-stream") {
  const m = /^multipart\/form-data;.*boundary=(.+)$/i.exec(contentType);
  if (!m) return { bytes: body, type: contentType };
  const sep = Buffer.from("--" + m[1].replace(/^"|"$/g, ""));
  let at = body.indexOf(sep);
  while (at !== -1) {
    const next = body.indexOf(sep, at + sep.length);
    if (next === -1) break;
    const part = body.subarray(at + sep.length + 2, next - 2); // skip CRLF after the boundary / before the next
    const headEnd = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, headEnd).toString();
    if (/filename=|content-type:/i.test(head) && !/name="cacheControl"/i.test(head)) {
      const type = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? "application/octet-stream";
      return { bytes: part.subarray(headEnd + 4), type };
    }
    at = next;
  }
  return { bytes: body, type: contentType };
}

const user = (id, email, meta) => ({ id, aud: "authenticated", role: "authenticated", email, user_metadata: meta ?? {}, app_metadata: { provider: "email" },
  created_at: new Date().toISOString(), email_confirmed_at: new Date().toISOString() });
function session(id, email, meta) {
  const ttl = 3600;
  return { access_token: jwt({ sub: id, email, role: "authenticated", aud: "authenticated" }, ttl), token_type: "bearer", expires_in: ttl,
    expires_at: Math.floor(Date.now() / 1000) + ttl, refresh_token: jwt({ sub: id, email, typ: "refresh", meta }, 30 * 86400), user: user(id, email, meta) };
}
const readBody = (req) => new Promise((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } }); });

/** The GoTrue endpoints supabase-js uses for email + password. Errors in GoTrue's shape (code = error code). */
async function auth(req, res, url, bearer) {
  const send = (status, obj) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.setHeader("x-supabase-api-version", "2024-01-01");
    res.end(obj === undefined ? "" : JSON.stringify(obj));
  };
  const fail = (status, code, msg) => send(status, { code, error_code: code, msg, message: msg });
  const path = url.pathname.replace(/^\/auth\/v1/, "");
  if (path === "/health") return send(200, { name: "local-gotrue" });
  if (path === "/user" && req.method === "GET") {
    const c = verify(bearer);
    if (!c || c.role !== "authenticated") return fail(401, "bad_jwt", "invalid JWT");
    return send(200, user(c.sub, c.email));
  }
  if (path === "/logout") { req.resume(); return send(204); }
  if (path === "/signup" && req.method === "POST") {
    const b = await readBody(req);
    if (!/.+@.+\..+/.test(b.email ?? "")) return fail(400, "email_address_invalid", "Email address is invalid");
    if ((b.password ?? "").length < 8) return fail(422, "weak_password", "Password should be at least 8 characters.");
    const r = await rpc("local_signup", { p_email: b.email, p_password: b.password, p_meta: b.data ?? {} });
    if (r.status !== 200) return r.body?.message?.includes("user_already_exists") ? fail(422, "user_already_exists", "User already registered") : fail(500, "unexpected_failure", "signup failed");
    return send(200, session(r.body, b.email.toLowerCase(), b.data));
  }
  if (path === "/token" && req.method === "POST") {
    const b = await readBody(req);
    const grant = url.searchParams.get("grant_type");
    if (grant === "password") {
      const r = await rpc("local_login", { p_email: b.email ?? "", p_password: b.password ?? "" });
      const row = r.status === 200 && Array.isArray(r.body) ? r.body[0] : null;
      if (!row) return fail(400, "invalid_credentials", "Invalid login credentials");
      return send(200, session(row.id, row.email, row.meta));
    }
    if (grant === "refresh_token") {
      const c = verify(b.refresh_token);
      if (!c || c.typ !== "refresh") return fail(400, "refresh_token_not_found", "Invalid Refresh Token");
      return send(200, session(c.sub, c.email, c.meta));
    }
    return fail(400, "validation_failed", "unsupported grant_type");
  }
  req.resume();
  return fail(404, "not_found", "not implemented locally");
}

if (process.argv[1].endsWith("local-supabase.mjs")) {
  attachRealtime(http
    .createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "*");
      res.setHeader("access-control-allow-methods", "*");
      res.setHeader("access-control-expose-headers", "*");
      if (req.method === "OPTIONS") return res.end();
      const bearer = (req.headers.authorization || "").replace("Bearer ", "");

      if (url.pathname.startsWith("/auth/v1/")) return void auth(req, res, url, bearer);
      // Storage emulation. Object rows live in storage.objects (RLS enforced through PostgREST
      // with the caller's JWT); file bytes in FILES.
      const rest = (method, path, body, profile = "storage", prefer = "return=representation") =>
        new Promise((resolve) => {
          const r = http.request({ host: "127.0.0.1", port: 3001, path, method, headers: {
            authorization: "Bearer " + bearer, "content-type": "application/json",
            "accept-profile": profile, "content-profile": profile, prefer } }, (up) => {
            let d = ""; up.on("data", (c) => (d += c)); up.on("end", () => resolve({ status: up.statusCode, body: d }));
          });
          if (body) r.write(JSON.stringify(body));
          r.end();
        });
      const json = (code, obj) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); };
      const m = url.pathname.match(/^\/storage\/v1\/object\/(sign\/|file\/|public\/)?([^/]+)\/?(.*)$/);
      if (m && m[1] === "sign/") {
        const bucket = m[2], name = decodeURIComponent(m[3]);
        req.resume();
        rest("GET", `/objects?select=name&bucket_id=eq.${bucket}&name=eq.${encodeURIComponent(name)}`).then((r) => {
          const rows = r.status === 200 ? JSON.parse(r.body) : [];
          if (!rows.length) return json(400, { statusCode: "404", error: "not_found", message: "Object not found" });
          json(200, { signedURL: `/object/file/${bucket}/${name}?token=local` });
        });
        return;
      }
      if (m && (m[1] === "file/" || m[1] === "public/")) {
        const f = `${FILES}/${m[2]}/${decodeURIComponent(m[3])}`;
        if (f.includes("..")) { res.statusCode = 400; return res.end(); }
        if (!fs.existsSync(f)) { res.statusCode = 404; return res.end(); }
        res.setHeader("content-type", fs.readFileSync(f + ".type", "utf8"));
        return fs.createReadStream(f).pipe(res);
      }
      if (m && !m[1] && req.method === "POST" && m[3]) {
        const bucket = m[2], name = decodeURIComponent(m[3]);
        if (name.includes("..") || bucket.includes("..")) { req.resume(); return json(400, { statusCode: "400", error: "bad_name", message: "bad name" }); }
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          rest("POST", "/objects", { bucket_id: bucket, name, metadata: { size: Buffer.concat(chunks).length } }, "storage", "return=minimal").then((r) => {
            if (r.status >= 300) return json(400, { statusCode: "403", error: "Unauthorized", message: "new row violates row-level security policy" });
            const f = `${FILES}/${bucket}/${name}`;
            const file = fileFromUpload(Buffer.concat(chunks), req.headers["content-type"]);
            fs.mkdirSync(f.slice(0, f.lastIndexOf("/")), { recursive: true });
            fs.writeFileSync(f, file.bytes);
            fs.writeFileSync(f + ".type", file.type);
            json(200, { Key: `${bucket}/${name}` });
          });
        });
        return;
      }
      if (m && !m[1] && req.method === "DELETE" && !m[3]) {
        const bucket = m[2];
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", async () => {
          const out = [];
          for (const name of JSON.parse(body || "{}").prefixes ?? []) {
            const r = await rest("DELETE", `/objects?bucket_id=eq.${bucket}&name=eq.${encodeURIComponent(name)}`);
            if (r.status < 300 && JSON.parse(r.body).length) {
              fs.rmSync(`${FILES}/${bucket}/${name}`, { force: true });
              out.push({ name });
            }
          }
          json(200, out);
        });
        return;
      }
      if (url.pathname.startsWith("/storage/v1/")) {
        req.resume();
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ Key: url.pathname }));
      }
      // PostgREST
      const target = url.pathname.replace(/^\/rest\/v1/, "") + url.search;
      const headers = { ...req.headers, host: "127.0.0.1:3001" };
      const up = http.request({ host: "127.0.0.1", port: 3001, path: target, method: req.method, headers }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      up.on("error", (e) => {
        res.statusCode = 502;
        res.end(String(e));
      });
      req.pipe(up);
    })
    .listen(54321, "127.0.0.1", () => console.log("local supabase on :54321")));
}

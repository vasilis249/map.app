// Server-only security-header layer. The .server.ts suffix keeps this out of the
// client bundle. Applied to every response by src/server.ts.
//
// Goal: score A on securityheaders.com and mitigate clickjacking, MIME sniffing,
// referrer leakage and (best-effort) XSS via a Content-Security-Policy.
//
// NOTE on CSP + 'unsafe-inline' for scripts: TanStack Start streams inline
// hydration scripts without an exposed per-request nonce, so a strict script CSP
// would break hydration. We therefore allow inline scripts but lock everything
// else down (frame-ancestors 'none', restricted connect/img/style sources). If a
// nonce channel becomes available, drop 'unsafe-inline' from script-src and switch
// to 'nonce-<value>'.

function supabaseOrigin(): string | null {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function buildCsp(): string {
  const sb = supabaseOrigin();
  // Supabase realtime uses secure WebSockets on the same host.
  const sbWs = sb ? sb.replace(/^http(s?):/, "ws$1:") : null; // wss: in production, ws: for the local stack

  const connectSrc = [
    "'self'",
    sb,
    sbWs,
    "https://*.supabase.co",
    "wss://*.supabase.co",
    // Live map: style, vector tiles, glyphs and sprites (OpenFreeMap, free, no key).
    "https://tiles.openfreemap.org",
  ].filter(Boolean);

  // Profile photos come from Supabase Storage; the map draws its tiles and sprites from connect-src fetches.
  const imgSrc = ["'self'", "data:", "blob:", sb, "https://*.supabase.co"].filter(Boolean);

  // Voice clips: recorded locally (blob:) and streamed from Supabase.
  const mediaSrc = ["'self'", "blob:", "data:", sb, "https://*.supabase.co"].filter(Boolean);

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // Inline hydration scripts.
    "script-src": ["'self'", "'unsafe-inline'"],
    // Tailwind / inline style attributes; fonts are self-hosted.
    "style-src": ["'self'", "'unsafe-inline'"],
    "font-src": ["'self'", "data:"],
    "img-src": imgSrc as string[],
    "media-src": mediaSrc as string[],
    "connect-src": connectSrc as string[],
    "frame-src": ["'none'"],
    "worker-src": ["'self'", "blob:"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
    "upgrade-insecure-requests": [],
  };

  return Object.entries(directives)
    .map(([k, v]) => (v.length ? `${k} ${v.join(" ")}` : k))
    .join("; ");
}

let cachedCsp: string | undefined;

export function applySecurityHeaders(response: Response, request?: Request): Response {
  // Skip if we've already stamped this response (defensive).
  if (response.headers.has("x-content-type-options")) return response;

  if (!cachedCsp) cachedCsp = buildCsp();

  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", cachedCsp);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(self), geolocation=(self), payment=(), usb=(), interest-cohort=()",
  );
  headers.set(
    "Strict-Transport-Security",
    "max-age=63072000; includeSubDomains; preload",
  );
  headers.set("X-DNS-Prefetch-Control", "off");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");

  // Server-function / API responses carry per-user data: never cache them.
  if (request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/_serverFn") || path.startsWith("/api/")) {
      headers.set("Cache-Control", "private, no-store");
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { applySecurityHeaders } from "@/lib/security-headers.server";
import { handleNav } from "@/lib/nav/api.server";

// Every response gets the security headers (CSP, Permissions-Policy microphone + geolocation, HSTS…).
// /api/nav/* is the routing / place-search proxy (the provider key stays here).
export default createServerEntry({
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const response = pathname.startsWith("/api/nav/") ? await handleNav(request) : await handler.fetch(request);
    return applySecurityHeaders(response, request);
  },
});

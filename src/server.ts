import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { applySecurityHeaders } from "@/lib/security-headers.server";

// Every response gets the security headers (CSP, Permissions-Policy microphone + geolocation, HSTS…).
export default createServerEntry({
  async fetch(request) {
    const response = await handler.fetch(request);
    return applySecurityHeaders(response, request);
  },
});

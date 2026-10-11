import { createStart } from "@tanstack/react-start";

// Client-rendered app: the session lives in localStorage, the map / audio / location APIs exist only in the
// browser (and the iOS web view). The server sends the HTML shell with the security headers (src/server.ts).
export const startInstance = createStart(() => ({ defaultSsr: false }));

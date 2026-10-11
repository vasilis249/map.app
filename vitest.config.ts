import { defineConfig } from "vitest/config";

// Unit tests only (pure modules: codec, formatting; navigation logic with recorded GPS tracks in Phase 4).
// Separate from vite.config.ts so the Cloudflare / Start plugins stay out of the test run.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});

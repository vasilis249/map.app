import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  server: { port: 3000 },
  resolve: { tsconfigPaths: true },
  plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), tailwindcss(), tanstackStart(), viteReact()],
  // Web workers as ES modules: the map's MapLibre worker is an ES module (maplibre-gl-worker.mjs imports a shared
  // chunk), bundled by `?worker&url` in components/map/live-map.tsx (kit LESSONS #19).
  worker: { format: "es" },
});

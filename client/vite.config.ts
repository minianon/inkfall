import { defineConfig } from "vite";
import { resolve } from "node:path";

const here = __dirname;

export default defineConfig({
  root: here,
  server: {
    port: 5173,
    // The shared sim lives outside client/, so Vite needs to read the parent.
    fs: { allow: [resolve(here, "..")] },
    // One origin in dev and in production: the client always talks to /ws.
    proxy: {
      "/ws": { target: "ws://localhost:8787", ws: true },
      "/health": { target: "http://localhost:8787" },
    },
  },
  build: {
    outDir: resolve(here, "dist"),
    emptyOutDir: true,
    target: "es2022",
  },
});

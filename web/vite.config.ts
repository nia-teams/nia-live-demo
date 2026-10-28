import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch (err) {
  if (!err || typeof err !== "object" || !("code" in err) || (err as { code?: unknown }).code !== "ENOENT") {
    throw err;
  }
}

const backendPort = Number(process.env.PORT) || 8787;

// The web app and the orchestrator are one origin from the browser's point of
// view: in dev this proxy forwards /api and /ws to the server (:8787), in
// production the server serves web/dist itself.
export default defineConfig({
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/api": { target: `http://127.0.0.1:${backendPort}`, xfwd: true },
      "/ws": { target: `ws://127.0.0.1:${backendPort}`, ws: true, xfwd: true },
    },
  },
});

#!/usr/bin/env node
import { fileURLToPath } from "node:url";
try { process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url))); } catch { /* ambient env only */ }
if (!process.env.CLIPROXY_API_KEY) {
  console.error("\nMissing required env: CLIPROXY_API_KEY\nCopy .env.example to .env and fill in CLIProxyAPI credentials.\n");
  process.exit(1);
}

/** Environment-driven server configuration. */
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  /* deployed environments may provide ambient variables */
}

const env = (name: string, fallback = ""): string => process.env[name] ?? fallback;
const baseUrl = env("CLIPROXY_BASE_URL", "http://127.0.0.1:8317/v1").replace(/\/+$/, "");

export const config = {
  host: env("HOST", "127.0.0.1"),
  port: Number(env("PORT", "8787")),
  gptlive: {
    baseUrl,
    wsUrl: env("CLIPROXY_WS_URL", baseUrl.replace(/^http/, "ws")).replace(/\/+$/, ""),
    apiKey: env("CLIPROXY_API_KEY"),
    model: env("GPT_LIVE_MODEL", "gpt-live-1-codex"),
    voice: env("GPT_LIVE_VOICE", "maple"),
    responsesModel: env("GPT_LIVE_RESPONSES_MODEL", "gpt-6.1-sol"),
    serviceTier: env("GPT_LIVE_SERVICE_TIER", "ultrafast"),
    debug: Boolean(env("GPT_LIVE_DEBUG")),
  },
};

export function missingConfig(): string[] {
  return [
    ["CLIPROXY_BASE_URL", config.gptlive.baseUrl],
    ["CLIPROXY_API_KEY", config.gptlive.apiKey],
  ].filter(([, value]) => !value).map(([name]) => name ?? "");
}

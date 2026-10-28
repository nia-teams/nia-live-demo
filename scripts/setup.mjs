import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";

const ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));
const ENV_TEMPLATE = fileURLToPath(new URL("../.env.example", import.meta.url));
const DEFAULT_BASE_URL = "http://127.0.0.1:8317/v1";
const interactive = stdin.isTTY === true;
const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;
const ask = async (question, fallback = "") => rl ? ((await rl.question(question)).trim() || fallback) : fallback;

function readEnv() {
  if (!existsSync(ENV_PATH)) return {};
  return Object.fromEntries(readFileSync(ENV_PATH, "utf8").split("\n").flatMap((line) => {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    return match ? [[match[1], match[2]]] : [];
  }));
}

function writeEnv(updates) {
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8").split("\n") : [];
  const remaining = { ...updates };
  const output = lines.map((line) => {
    const match = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (!match || !(match[1] in remaining)) return line;
    const key = match[1];
    const value = remaining[key];
    delete remaining[key];
    return `${key}=${value}`;
  });
  for (const [key, value] of Object.entries(remaining)) output.push(`${key}=${value}`);
  writeFileSync(ENV_PATH, output.join("\n").replace(/\n*$/, "\n"));
}

async function main() {
  if (!existsSync(ENV_PATH)) copyFileSync(ENV_TEMPLATE, ENV_PATH);
  const env = readEnv();
  const baseUrl = await ask(`CLIProxyAPI base URL [${env.CLIPROXY_BASE_URL || DEFAULT_BASE_URL}]: `, env.CLIPROXY_BASE_URL || DEFAULT_BASE_URL);
  const apiKey = await ask("CLIProxyAPI API key: ", env.CLIPROXY_API_KEY || "");
  if (!apiKey) throw new Error("CLIPROXY_API_KEY is required");

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (response.ok) console.log("✓ CLIProxyAPI /v1/models reachable");
    else console.warn(`! CLIProxyAPI /v1/models returned HTTP ${response.status}; continuing with local configuration`);
  } catch {
    console.warn("! CLIProxyAPI /v1/models was not reachable; continuing without a network check");
  }
  writeEnv({ CLIPROXY_BASE_URL: baseUrl, CLIPROXY_API_KEY: apiKey });
  console.log("✓ Wrote .env. Run pnpm dev or pnpm build && pnpm start.");
}

main().catch((error) => { console.error(`Setup failed: ${error.message}`); process.exitCode = 1; }).finally(() => rl?.close());

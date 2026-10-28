/** HTTP + WebSocket entrypoint for Nia Live sessions. */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { ClientMessage } from "../../shared/messages";
import { config, missingConfig } from "./config";
import { addSession, getSession, stopAll, stopSession } from "./registry";
import { Session } from "./session";

const WEB_DIST = resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
const MAX_HTTP_BODY_BYTES = 64 * 1024;
const MAX_WS_PAYLOAD_BYTES = 1024 * 1024;
const MAX_MIC_BASE64_CHARS = 262_144;
const MAX_INTERACT_CHARS = 4_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

class PayloadTooLargeError extends Error {}
class InvalidJsonError extends Error {}

const server = createServer((req, res) => {
  void route(req, res).catch((err: unknown) => {
    console.error("[http] unhandled:", err);
    if (!res.headersSent) json(res, 500, { error: "internal error" });
  });
});

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path === "/healthz") return void res.writeHead(200).end("ok");
  if (req.method === "POST" && path === "/api/session/start") return handleStart(res);
  if (req.method === "POST" && path === "/api/session/stop") return handleStop(req, res);
  if (path === "/api" || path.startsWith("/api/")) return void json(res, 404, { error: "not found" });
  return serveStatic(res, path);
}

async function handleStart(res: ServerResponse): Promise<void> {
  const missing = missingConfig();
  if (missing.length) {
    json(res, 500, { error: `missing env vars: ${missing.join(", ")} — copy .env.example to .env` });
    return;
  }
  let session: Session | undefined;
  try {
    const sessionId = crypto.randomUUID();
    session = new Session(sessionId, (id) => void stopSession(id, "leg_died"));
    const callId = await session.bridge.createServerAudioPeerCall();
    addSession(session);
    session.start();
    console.log(`[http] session started: ${sessionId} (call_id=${callId}, mode=server-webrtc, model=${config.gptlive.model})`);
    json(res, 201, { session_id: sessionId, call_id: callId, model: config.gptlive.model, ws_path: `/ws/${sessionId}` });
  } catch (err) {
    await session?.stop().catch(() => {});
    const message = err instanceof Error ? err.message : "session start failed";
    console.error(`[http] session start failed: ${message}`);
    json(res, 502, { error: "session start failed — check server logs and CLIProxyAPI configuration" });
  }
}

async function handleStop(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readJson(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) return void json(res, 413, { error: "payload too large" });
    return void json(res, 400, { error: "invalid JSON body" });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    json(res, 400, { error: "expected JSON object" });
    return;
  }
  const sessionId = (body as { session_id?: unknown }).session_id;
  if (typeof sessionId === "string" && sessionId) await stopSession(sessionId, "client_stop");
  res.writeHead(204).end();
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }
  if (decoded === "/" || decoded === "") decoded = "/index.html";
  const candidate = resolve(WEB_DIST, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  const relFromRoot = relative(WEB_DIST, candidate);
  if (relFromRoot.startsWith("..") || isAbsolute(relFromRoot)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    if ((await stat(candidate)).isDirectory()) throw new Error("dir");
    res.writeHead(200, { "Content-Type": MIME[extname(candidate)] ?? "application/octet-stream" });
    res.end(await readFile(candidate));
  } catch {
    try {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(await readFile(join(WEB_DIST, "index.html")));
    } catch {
      res.writeHead(404).end("not found — in dev, use the Vite server (pnpm dev)");
    }
  }
}

function matchesOriginHost(originUrl: URL, rawHost: string | string[] | undefined): boolean {
  const first = Array.isArray(rawHost) ? rawHost[0] : rawHost;
  const candidate = first?.split(",")[0]?.trim();
  if (!candidate || !/^[A-Za-z0-9._:\[\]-]+$/.test(candidate)) return false;
  try {
    return new URL(`${originUrl.protocol}//${candidate}`).host === originUrl.host;
  } catch {
    return false;
  }
}

function isAllowedUpgradeOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    if (LOOPBACK_HOSTS.has(originUrl.hostname)) return true;
    return (
      matchesOriginHost(originUrl, req.headers.host) ||
      matchesOriginHost(originUrl, req.headers["x-forwarded-host"])
    );
  } catch {
    return false;
  }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });
server.on("upgrade", (req, socket, head) => {
  if (!isAllowedUpgradeOrigin(req)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  const match = /^\/ws\/([A-Za-z0-9_-]+)$/.exec(new URL(req.url ?? "", "http://x").pathname);
  const session = match?.[1] ? getSession(match[1]) : undefined;
  if (!session) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (!session.tryAttachFrontend(ws)) {
      ws.close(1008, "already connected");
      return;
    }
    ws.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const msg = parsed as Partial<ClientMessage>;
      if (msg.type === "mic_audio" && typeof msg.audio === "string" && msg.audio && msg.audio.length <= MAX_MIC_BASE64_CHARS) {
        session.sendMicAudio(msg.audio);
      } else if (msg.type === "canvas_interact" && typeof msg.text === "string" && msg.text) {
        session.sendCanvasInteract(msg.text.slice(0, MAX_INTERACT_CHARS));
      } else if (msg.type === "stop") {
        ws.close(1000);
      }
    });
    ws.on("close", () => {
      session.detachFrontend(ws);
      void stopSession(session.sessionId, "frontend_disconnect");
    });
  });
});

server.listen(config.port, config.host, () => {
  console.log(`[server] listening on http://${config.host}:${config.port} (model=${config.gptlive.model}, baseUrl=${config.gptlive.baseUrl})`);
  const missing = missingConfig();
  if (missing.length) console.warn(`[server] missing env vars: ${missing.join(", ")} — copy .env.example to .env`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void stopAll().finally(() => process.exit(0)));

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_HTTP_BODY_BYTES) {
        settled = true;
        req.resume();
        rejectPromise(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(raw));
      } catch {
        rejectPromise(new InvalidJsonError());
      }
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      rejectPromise(err);
    });
  });
}

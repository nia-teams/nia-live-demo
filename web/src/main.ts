/**
 * Owns one session end to end: start → websocket → mic, and the
 * teardown of all four in the right order.
 *
 * UI and interactions are aligned with Nia Teams `LiveVoicePage.tsx` (excluding image upload):
 * - Bottom status bar (`h-6` / 24px) with spinning agent-activity pill or status text
 * - Bottom subtitle box showing the most recent 4 turns (`你：` / `Nia：`) with full-width punctuation normalization
 * - 56x56 circular control buttons:
 *   - Disconnected: centered green PhoneIcon button
 *   - Connecting: centered amber spinning ring + PhoneXMarkIcon cancel button
 *   - Connected: left Mute button (with in-capsule green liquid volume fill `#5DCAA5` + pulsing halo ring) + centered red Hangup button
 * - Microphone starts muted while connecting and un-mutes only after upstream `ready`
 */

import type { Turn } from "../../shared/messages";
import { startMicCapture, type MicCapture } from "./micCapture";
import { createOverlays } from "./overlays/index";
import { openSessionSocket, type SessionSocket } from "./socket";

const AGENT_NAME = "Nia";

const HALF_WIDTH_PUNCTUATION_MAP: Readonly<Record<string, string>> = {
  ",": "，",
  ".": "。",
  "!": "！",
  "?": "？",
  ";": "；",
  ":": "：",
};

export function normalizeLiveTranscriptPunctuation(text: string): string {
  return text.replace(
    /([,.!?;:])(\s*)/g,
    (match, punct: string, trailingWs: string, offset: number, source: string) => {
      const prev = offset > 0 ? (source[offset - 1] ?? "") : "";
      const next = offset + match.length < source.length ? (source[offset + match.length] ?? "") : "";
      if (
        (punct === "." || punct === ":" || punct === ",") &&
        /[0-9A-Za-z]/.test(prev) &&
        /[0-9A-Za-z]/.test(next) &&
        trailingWs.length === 0
      ) {
        return match;
      }
      const mapped = HALF_WIDTH_PUNCTUATION_MAP[punct];
      return mapped ?? match;
    },
  );
}

const layoutEl = document.getElementById("layout") as HTMLDivElement;
const stage = document.getElementById("stage") as HTMLDivElement;

const agentActivityPill = document.getElementById("agent-activity-pill") as HTMLDivElement;
const agentActivityText = document.getElementById("agent-activity-text") as HTMLSpanElement;
const statusTextEl = document.getElementById("status-text") as HTMLSpanElement;
const transcriptBoxEl = document.getElementById("transcript-box") as HTMLDivElement;

const micBtn = document.getElementById("mic-btn") as HTMLButtonElement;
const micHaloEl = document.getElementById("mic-halo") as HTMLSpanElement;
const micFillEl = document.getElementById("mic-fill") as unknown as SVGRectElement;
const startBtn = document.getElementById("start-btn") as HTMLButtonElement;
const connectingBtn = document.getElementById("connecting-btn") as HTMLButtonElement;

type CallState = "idle" | "connecting" | "listening" | "ended" | "error";

let callState: CallState = "idle";
let statusDetail = "点击下方按钮开始通话";
let agentActivity: string | null = null;
let errorMessage: string | null = null;
let isHangingUp = false;
let upstreamReady = false;
let micMuted = false;
let transcripts: Turn[] = [];

function setHidden(el: HTMLElement, hidden: boolean): void {
  if (hidden) el.setAttribute("data-hidden", "");
  else el.removeAttribute("data-hidden");
}

function syncUi(): void {
  const isDisconnected =
    !isHangingUp && (callState === "idle" || callState === "ended" || Boolean(errorMessage));
  const isConnecting = !isHangingUp && !isDisconnected && callState === "connecting";
  const isCallConnected = !isHangingUp && !isDisconnected && !isConnecting;

  const showVoiceStatusText =
    isHangingUp ||
    callState === "idle" ||
    callState === "connecting" ||
    callState === "ended" ||
    callState === "error" ||
    micMuted;

  const voiceStatusLabel = isHangingUp
    ? statusDetail
    : callState === "idle"
      ? "点击下方按钮开始通话"
      : callState === "connecting" || callState === "ended" || callState === "error"
        ? statusDetail
        : micMuted
          ? "已静音"
          : "";

  if (agentActivity) {
    agentActivityPill.setAttribute("data-visible", "");
    agentActivityText.textContent = agentActivity;
    statusTextEl.setAttribute("data-hidden", "");
  } else {
    agentActivityPill.removeAttribute("data-visible");
    agentActivityText.textContent = "";
    if (showVoiceStatusText && voiceStatusLabel) {
      statusTextEl.removeAttribute("data-hidden");
      statusTextEl.textContent = voiceStatusLabel;
      if (callState === "error" || Boolean(errorMessage)) {
        statusTextEl.setAttribute("data-error", "");
      } else {
        statusTextEl.removeAttribute("data-error");
      }
    } else {
      statusTextEl.setAttribute("data-hidden", "");
      statusTextEl.textContent = "";
    }
  }

  // Single centered button across all states: Start -> Connecting -> Mic Mute
  setHidden(micBtn, !isCallConnected);
  setHidden(startBtn, !isDisconnected);
  setHidden(connectingBtn, !isConnecting);

  const startLabel = callState === "ended" || errorMessage ? "重新开始语音" : "开始语音";
  startBtn.setAttribute("aria-label", startLabel);
  startBtn.title = startLabel;

  if (micMuted) {
    micBtn.setAttribute("data-muted", "");
  } else {
    micBtn.removeAttribute("data-muted");
  }
  micBtn.setAttribute("aria-pressed", String(micMuted));
  const muteLabel = micMuted ? "取消静音" : "静音麦克风";
  micBtn.setAttribute("aria-label", muteLabel);
  micBtn.title = muteLabel;
}

function renderTranscripts(): void {
  const recent = transcripts.slice(-4);
  if (recent.length === 0) {
    transcriptBoxEl.removeAttribute("data-visible");
    transcriptBoxEl.textContent = "";
    return;
  }
  transcriptBoxEl.setAttribute("data-visible", "");
  transcriptBoxEl.textContent = "";
  for (const t of recent) {
    const row = document.createElement("div");
    row.className = "transcript-line";

    const who = document.createElement("span");
    who.className = `transcript-who ${t.role}`;
    who.textContent = t.role === "user" ? "你：" : `${AGENT_NAME}：`;

    const text = document.createElement("span");
    text.className = "transcript-text";
    text.textContent = normalizeLiveTranscriptPunctuation(t.text);

    row.append(who, text);
    transcriptBoxEl.appendChild(row);
  }
  transcriptBoxEl.scrollTop = transcriptBoxEl.scrollHeight;
}

function upsertTurn(turn: Turn): void {
  const idx = transcripts.findIndex((t) => t.id === turn.id);
  if (idx === -1) {
    transcripts.push(turn);
  } else {
    transcripts[idx] = turn;
  }
  renderTranscripts();
}

const setStage = (state: "idle" | "connecting" | "live") => {
  stage.dataset.state = state;
};

const overlays = createOverlays({
  stage,
  onCanvasInteract: (text) => {
    upsertTurn({
      id: `canvas_${Date.now()}`,
      role: "user",
      text: `[画布交互] ${text.trim()}`,
      done: true,
    });
    socket?.sendCanvasInteract(text);
  },
});

function renderStarterCanvas(): void {
  overlays.render({
    widget: "canvas_card",
    props: {
      title: "",
      subtitle: "",
      srcDoc: `<!DOCTYPE html><html style="color-scheme:dark;"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>*{box-sizing:border-box;}html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;overscroll-behavior:none;background:transparent;color:#eef2ff;font-family:-apple-system,system-ui,sans-serif;}#content{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden;}</style></head><body><div id="content"><div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:24px;text-align:center;"><div style="position:relative;display:flex;width:96px;height:96px;align-items:center;justify-content:center;border-radius:9999px;background:radial-gradient(circle, rgba(93,202,165,0.22) 0%, rgba(14,58,108,0.08) 70%);border:1px solid rgba(255,255,255,0.14);"><img src="/nia-avatar-circle.png" alt="Nia" style="width:64px;height:64px;border-radius:9999px;object-fit:cover;display:block;" /></div></div></div></body></html>`,
    },
  });
}

renderStarterCanvas();
syncUi();

// ── Mic volume capsule fill + halo visualizer (matches Teams drawMicWave) ────
let micAnalyser: AnalyserNode | null = null;
let micFreqBuf: Uint8Array<ArrayBuffer> | null = null;
let waveRaf = 0;

function drawMicWave(): void {
  const live = Boolean(micAnalyser && micFreqBuf && upstreamReady && !micMuted);
  let level = 0;
  if (live && micAnalyser && micFreqBuf && typeof micAnalyser.getByteFrequencyData === "function") {
    micAnalyser.getByteFrequencyData(micFreqBuf);
    let sum = 0;
    const binCount = Math.min(42, micFreqBuf.length - 1);
    for (let i = 1; i <= binCount; i += 1) {
      sum += micFreqBuf[i] ?? 0;
    }
    level = binCount > 0 ? Math.min(1, (sum / binCount / 255) * 1.6) : 0;
  }

  if (micFillEl) {
    const maxH = 12;
    const minH = live ? 2.4 : 0;
    const fillH = live ? Math.min(maxH, Math.max(minH, minH + level * (maxH - minH))) : 0;
    const fillY = 14.25 - fillH;
    micFillEl.setAttribute("y", fillY.toFixed(2));
    micFillEl.setAttribute("height", fillH.toFixed(2));
  }

  if (micHaloEl) {
    const scale = live ? 1 + level * 0.24 : 1;
    const opacity = live ? Math.min(0.75, 0.14 + level * 0.6) : 0;
    micHaloEl.style.transform = `scale(${scale.toFixed(3)})`;
    micHaloEl.style.opacity = opacity.toFixed(2);
  }
}

function tickWave(): void {
  drawMicWave();
  waveRaf = requestAnimationFrame(tickWave);
}

function stopLiveness(): void {
  if (waveRaf) {
    cancelAnimationFrame(waveRaf);
    waveRaf = 0;
  }
  micAnalyser = null;
  micFreqBuf = null;
  drawMicWave();
}

// ── Mic mute ──────────────────────────────────────────────────────────────────
function toggleMute(): void {
  micMuted = !micMuted;
  mic?.setMuted(!upstreamReady || micMuted);
  drawMicWave();
  syncUi();
}

micBtn.addEventListener("click", () => toggleMute());

// ── Screen wake lock ──────────────────────────────────────────────────────────
interface WakeLockSentinelLike {
  released?: boolean;
  release(): Promise<void>;
  addEventListener?(type: string, listener: () => void): void;
}

let wakeLockSentinel: WakeLockSentinelLike | null = null;
let wantWakeLock = false;

async function acquireWakeLock(): Promise<void> {
  wantWakeLock = true;
  const nav = navigator as Navigator & {
    wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
  };
  if (!nav.wakeLock || typeof nav.wakeLock.request !== "function") return;
  if (wakeLockSentinel && !wakeLockSentinel.released) return;
  try {
    wakeLockSentinel = await nav.wakeLock.request("screen");
    wakeLockSentinel.addEventListener?.("release", () => {
      wakeLockSentinel = null;
    });
  } catch {
    /* ignore */
  }
}

async function releaseWakeLock(): Promise<void> {
  wantWakeLock = false;
  const current = wakeLockSentinel;
  wakeLockSentinel = null;
  if (current) {
    try {
      await current.release();
    } catch {
      /* ignore */
    }
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && wantWakeLock) {
    void acquireWakeLock();
  }
});

layoutEl.addEventListener("pointerdown", () => {
  socket?.unlockAudio();
  if (wantWakeLock && (!wakeLockSentinel || wakeLockSentinel.released)) {
    void acquireWakeLock();
  }
});

// ── Session lifecycle ─────────────────────────────────────────────────────────
let sessionId: string | null = null;
let socket: SessionSocket | null = null;
let mic: MicCapture | null = null;
let generation = 0;

function cleanupMedia(): void {
  upstreamReady = false;
  stopLiveness();
  if (socket) {
    socket.close();
    socket = null;
  }
  if (mic) {
    mic.stop();
    mic = null;
  }
}

async function start(): Promise<void> {
  const myGeneration = ++generation;
  const superseded = () => generation !== myGeneration;

  cleanupMedia();
  isHangingUp = false;
  errorMessage = null;
  agentActivity = null;
  micMuted = false;
  transcripts = [];
  renderTranscripts();
  renderStarterCanvas();

  callState = "connecting";
  statusDetail = "正在连接…";
  setStage("connecting");
  syncUi();
  void acquireWakeLock();

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("当前环境不支持麦克风实时语音");
    }

    // 1. Capture microphone upfront inside user gesture, keep muted until upstream ready
    const capture = await startMicCapture((base64) => {
      if (!upstreamReady || micMuted) return;
      socket?.sendMicAudio(base64);
    });
    if (superseded()) {
      capture.stop();
      return;
    }
    capture.setMuted(true);
    mic = capture;
    micAnalyser = capture.analyser;
    micFreqBuf = new Uint8Array(capture.analyser.frequencyBinCount || 256);
    if (!waveRaf) {
      waveRaf = requestAnimationFrame(tickWave);
    }

    // 2. Start server session
    const response = await fetch("/api/session/start", { method: "POST" });
    const started = (await response.json()) as {
      session_id: string;
      ws_path: string;
      error?: string;
    };
    if (!response.ok) {
      throw new Error(started.error ?? "启动实时语音失败");
    }
    if (superseded()) {
      void endOnServer(started.session_id);
      return;
    }
    sessionId = started.session_id;

    statusDetail = "正在连接语音服务…";
    syncUi();

    socket = openSessionSocket(started.ws_path, {
      onReady: () => {
        if (superseded()) return;
        upstreamReady = true;
        mic?.setMuted(micMuted);
        callState = "listening";
        statusDetail = "";
        setStage("live");
        syncUi();
      },
      onTurn: (turn) => {
        if (superseded()) return;
        upsertTurn(turn);
      },
      onUi: (msg) => {
        if (superseded()) return;
        overlays.render(msg);
        if (msg.widget === "canvas_stream" && msg.props.done) {
          agentActivity = null;
          callState = "listening";
          statusDetail = "";
          syncUi();
        }
      },
      onAgentActivity: (activity) => {
        if (superseded()) return;
        agentActivity = activity;
        syncUi();
      },
      onInterrupted: () => {
        /* playback queue already cleared in socket.ts */
      },
      onError: (message) => {
        if (superseded()) return;
        void stop({
          statusLabel: message || "连接已断开",
          isError: true,
        });
      },
      onClose: () => {
        if (!superseded() && !isHangingUp) {
          void stop({ statusLabel: "通话已结束" });
        }
      },
    });
  } catch (err) {
    const id = sessionId;
    sessionId = null;
    if (id) void endOnServer(id);
    if (superseded()) return;
    cleanupMedia();
    void releaseWakeLock();
    callState = "error";
    errorMessage = err instanceof Error ? err.message : "启动实时语音失败";
    statusDetail = errorMessage;
    setStage("idle");
    syncUi();
  }
}

async function stop(options?: { statusLabel?: string; isError?: boolean }): Promise<void> {
  if (isHangingUp) return;
  isHangingUp = true;
  generation += 1;
  agentActivity = null;
  statusDetail = options?.statusLabel ?? "正在挂断…";
  syncUi();

  cleanupMedia();
  overlays.hideAll();
  renderStarterCanvas();

  const id = sessionId;
  sessionId = null;
  if (id) {
    await endOnServer(id);
  }
  void releaseWakeLock();

  isHangingUp = false;
  if (options?.isError) {
    callState = "error";
    errorMessage = options.statusLabel ?? "连接已断开";
    statusDetail = errorMessage;
  } else {
    callState = "ended";
    errorMessage = null;
    statusDetail = options?.statusLabel === "正在挂断…" ? "通话已结束" : (options?.statusLabel ?? "通话已结束");
  }
  setStage("idle");
  syncUi();
}

async function endOnServer(id: string): Promise<void> {
  try {
    await fetch("/api/session/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: id }),
    });
  } catch {
    /* ignore */
  }
}

window.addEventListener("pagehide", () => {
  if (!sessionId) return;
  navigator.sendBeacon?.(
    "/api/session/stop",
    new Blob([JSON.stringify({ session_id: sessionId })], { type: "application/json" }),
  );
});

startBtn.addEventListener("click", () => void start());
connectingBtn.addEventListener("click", () => void stop({ statusLabel: "通话已结束" }));

drawMicWave();

(window as unknown as { __ui: typeof overlays.render }).__ui = overlays.render;

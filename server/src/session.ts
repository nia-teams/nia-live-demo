/** Per-session wiring between GPT-Live, server-side WebRTC audio, and the browser UI socket. */

import type WebSocket from "ws";
import type { ServerMessage, Turn } from "../../shared/messages";
import { GptLiveBridge, type GptLiveEvents } from "./gptlive";
import { SILENCE_CHECKIN } from "./prompts";
import { dispatchToolCall } from "./tools";

const YIELD_GRACE_MS = 600;
const YIELD_QUIET_MS = 350;
const YIELD_STALE_MS = 6_000;
const INTERRUPT_COOLDOWN_MS = 1_000;
const SILENCE_CHECKIN_MS = 12_000;
const SILENCE_POLL_MS = 3_000;
const CHECKIN_COOLDOWN_MS = 20_000;

const PREBUFFER_TARGET_MS = 200;
const PREBUFFER_MAX_WAIT_MS = 180;
const UNDERRUN_SLACK_MS = 40;
const PCM_BYTES_PER_MS = 48;

export class Session implements GptLiveEvents {
  readonly bridge: GptLiveBridge;
  private frontend: WebSocket | null = null;
  private ready = false;
  private stopping = false;
  private lastAudioAt: number | null = null;
  private lastInterruptAt: number | null = null;
  private interruptWatch: NodeJS.Timeout | null = null;
  private audioBuffering = true;
  private readonly audioQueue: Buffer[] = [];
  private audioQueuedMs = 0;
  private audioFlushTimer: NodeJS.Timeout | null = null;
  private playheadEndMs = 0;
  private lastUserActivityAt: number | null = null;
  private lastCheckinAt: number | null = null;
  private readyAt: number | null = null;
  private silencePoll: NodeJS.Timeout | null = null;

  lastActivityAt = Date.now();
  readonly startedAt = Date.now();

  constructor(
    readonly sessionId: string,
    private readonly onDead: (sessionId: string) => void,
  ) {
    this.bridge = new GptLiveBridge(this, (msg) => this.log(msg));
  }

  start(): void {
    void this.runLeg("GPT-Live", () => this.bridge.run());
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.resetAudioPrebuffer();
    if (this.interruptWatch) clearTimeout(this.interruptWatch);
    if (this.silencePoll) clearInterval(this.silencePoll);
    await this.bridge.close();
    this.frontend = null;
  }

  tryAttachFrontend(ws: WebSocket): boolean {
    if (this.frontend) return false;
    this.frontend = ws;
    if (this.ready) this.emit({ type: "ready" });
    return true;
  }

  detachFrontend(ws: WebSocket): void {
    if (this.frontend === ws) this.frontend = null;
  }

  sendMicAudio(audioB64: string): void {
    this.lastActivityAt = Date.now();
    this.bridge.sendMicAudio(audioB64);
  }

  sendCanvasInteract(text: string): void {
    this.lastActivityAt = Date.now();
    this.lastUserActivityAt = Date.now();
    this.log(`canvas interact: ${text}`);
    this.bridge.handleCanvasInteract(text);
  }

  onReady(): void {
    this.ready = true;
    this.readyAt = Date.now();
    this.log("GPT-Live ready");
    this.emit({ type: "ready" });
    this.silencePoll = setInterval(() => this.checkSilence(), SILENCE_POLL_MS);
  }

  onInputAudio(_audioB64: string): void {
    this.lastActivityAt = Date.now();
  }

  onAudio(audioB64: string): void {
    this.lastAudioAt = Date.now();
    const pcm = Buffer.from(audioB64, "base64");
    if (pcm.length <= 0 || pcm.length % 2 !== 0) return;
    const now = Date.now();
    const chunkMs = pcm.length / PCM_BYTES_PER_MS;
    if (!this.audioBuffering && now > this.playheadEndMs + UNDERRUN_SLACK_MS) {
      this.audioBuffering = true;
    }
    if (this.audioBuffering) {
      this.audioQueue.push(pcm);
      this.audioQueuedMs += chunkMs;
      if (this.audioQueuedMs >= PREBUFFER_TARGET_MS) this.flushAudioQueue(now);
      else if (!this.audioFlushTimer) {
        this.audioFlushTimer = setTimeout(() => {
          this.audioFlushTimer = null;
          if (!this.stopping) this.flushAudioQueue(Date.now());
        }, PREBUFFER_MAX_WAIT_MS);
        this.audioFlushTimer.unref?.();
      }
      return;
    }
    this.playheadEndMs = Math.max(now, this.playheadEndMs) + chunkMs;
    this.sendPcm(pcm);
  }

  onTurn(turn: Turn): void {
    this.emit({ type: "turn", ...turn });
    if (turn.role === "user") this.lastUserActivityAt = Date.now();
  }

  onUserTurnStarted(): void {
    this.lastUserActivityAt = Date.now();
    this.resetAudioPrebuffer();
    this.emit({ type: "interrupted" });
    if (this.interruptWatch) return;
    this.interruptWatch = setTimeout(() => {
      this.interruptWatch = null;
      this.stopStaleAudio();
    }, YIELD_GRACE_MS);
  }

  onAgentActivity(activity: string | null): void {
    this.emit({ type: "agent_activity", activity });
  }

  onToolCall(name: string | null, args: Record<string, unknown>): Record<string, unknown> {
    const ui = dispatchToolCall(name, args);
    if (!ui) {
      this.log(`tool call ignored: ${name ?? "(unnamed)"} ${JSON.stringify(args).slice(0, 120)}`);
      return { shown: false, error: "unknown tool or invalid arguments; nothing was displayed" };
    }
    if (ui.widget !== "canvas_stream" || ui.props.done) {
      this.log(`tool → ${ui.widget} ${JSON.stringify(ui.props).slice(0, 120)}`);
    }
    this.emit({ type: "ui", ...ui });
    return { shown: true };
  }

  onError(message: string): void {
    this.log(`error: ${message}`);
    this.emit({ type: "error", message });
  }

  private flushAudioQueue(now: number): void {
    if (this.audioFlushTimer) {
      clearTimeout(this.audioFlushTimer);
      this.audioFlushTimer = null;
    }
    this.audioBuffering = false;
    if (this.audioQueue.length === 0) return;
    const queued = this.audioQueue.splice(0);
    const totalMs = this.audioQueuedMs;
    this.audioQueuedMs = 0;
    this.playheadEndMs = Math.max(now, this.playheadEndMs) + totalMs;
    for (const pcm of queued) this.sendPcm(pcm);
  }

  private sendPcm(pcm: Buffer): void {
    if (this.frontend && this.frontend.readyState === this.frontend.OPEN) this.frontend.send(pcm);
  }

  private resetAudioPrebuffer(): void {
    if (this.audioFlushTimer) {
      clearTimeout(this.audioFlushTimer);
      this.audioFlushTimer = null;
    }
    this.audioQueue.length = 0;
    this.audioQueuedMs = 0;
    this.playheadEndMs = 0;
    this.audioBuffering = true;
  }

  private checkSilence(): void {
    if (this.stopping) return;
    const now = Date.now();
    const lastSignal = Math.max(this.readyAt ?? this.startedAt, this.lastAudioAt ?? 0, this.lastUserActivityAt ?? 0);
    if (now - lastSignal < SILENCE_CHECKIN_MS) return;
    if (this.lastCheckinAt !== null && now - this.lastCheckinAt < CHECKIN_COOLDOWN_MS) return;
    this.lastCheckinAt = now;
    this.bridge.append("instructions", SILENCE_CHECKIN);
  }

  private stopStaleAudio(): void {
    const last = this.lastAudioAt;
    if (last === null || this.stopping) return;
    if (this.lastInterruptAt !== null && Date.now() - this.lastInterruptAt < INTERRUPT_COOLDOWN_MS) return;
    const quietFor = Date.now() - last;
    if (quietFor < YIELD_QUIET_MS || quietFor > YIELD_STALE_MS) return;
    this.lastInterruptAt = Date.now();
    this.log("user barge-in — clearing server audio state");
    this.bridge.abortActiveBackend("user barge-in");
    this.emit({ type: "interrupted" });
  }

  private async runLeg(name: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      if (!this.stopping) this.log(`${name} leg failed: ${err instanceof Error ? err.message : err}`);
    }
    if (this.stopping) return;
    this.emit({ type: "error", message: `the ${name} connection dropped` });
    this.onDead(this.sessionId);
  }

  private emit(message: ServerMessage): void {
    const ws = this.frontend;
    if (!ws || ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch {
      this.frontend = null;
    }
  }

  private log(msg: string): void {
    console.log(`[session ${this.sessionId.slice(0, 8)}] ${msg}`);
  }
}

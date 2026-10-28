/**
 * Per-session GPT-Live 1.1 (Codex Frameless Bidi / `quicksilver=v2`) bridge via CLIProxyAPI.
 *
 * Architecture (matching `openai/codex` `codex-rs/codex-api/src/endpoint/realtime_call.rs`
 * and `realtime_websocket/methods_frameless_bidi.rs`):
 *  1. Browser captures 24kHz mono PCM16 over `/ws` to the Node server.
 *  2. `GptLiveBridge.createServerAudioPeerCall()` creates a server-side `OpenAIQuicksilverAudioPeer`
 *     (`werift` UDP + `libopus-wasm`) and sends `POST ${baseUrl}/live` with
 *     `OpenAI-Alpha: quicksilver=v2`, returning the CLIProxy media-relay SDP answer and `call_id` (`rtc_...`).
 *  3. `GptLiveBridge.run()` attaches to the Sideband WebSocket `ws://.../v1/live/${callId}`:
 *     - parses Frameless Bidi events (`session.started`, `input_transcript.added`,
 *       `output_transcript.added`, `turn.done`, `delegation.created`, plus reflected
 *       `session.input_audio.append` / `session.output_audio.delta`);
 *     - sends `delegation.context.append` and `session.context.append` chunked at ≤500 UTF-8 bytes
 *       (`CONTEXT_APPEND_MAX_BYTES = 500`, `content: [{ type: "input_text", text }]`).
 */

import WebSocket from "ws";
import type { Turn } from "../../shared/messages";
import { toolSchemas } from "../../shared/tools";
import { config } from "./config";
import { OpenAIQuicksilverAudioPeer } from "./openclaw/realtime-quicksilver-media.runtime";
import { OpenAIQuicksilverPendingAudio } from "./openclaw/realtime-quicksilver-audio-buffer";
import {
  CLIENT_DELEGATION_STUB,
  DEFAULT_GREETING,
  DEFAULT_INSTRUCTIONS,
  GREETING_PREAMBLE,
  LIVE_DIRECTIVE,
  RESPONSES_INSTRUCTIONS,
} from "./prompts";
import { extractStreamingHtmlArg, prepareStreamingPreview } from "./tools";
import { TurnProjector } from "./turns";

const CLOSE_DRAIN_TIMEOUT_MS = 3_000;
const CONTEXT_APPEND_MAX_BYTES = 500;

const voiceField = (voice: string): string | { id: string } =>
  voice.startsWith("voice_") ? { id: voice } : voice;

type Json = Record<string, any>;

export type AppendKind = "instructions" | "commentary" | "thinking";

export type ContextAppendChannel = "speakable" | "commentary" | "developer";

export interface GptLiveEvents {
  onReady(): void;
  /** Mirrored 24kHz PCM16 assistant audio from Sideband. */
  onAudio(audioB64: string): void;
  /** Mirrored 24kHz PCM16 user microphone audio from Sideband. */
  onInputAudio?(audioB64: string): void;
  onTurn(turn: Turn): void;
  onUserTurnStarted(): void;
  onAgentActivity?(activity: string | null): void;
  onToolCall(
    name: string | null,
    args: Record<string, unknown>,
  ): Record<string, unknown>;
  onError(message: string): void;
}

/**
 * Exact replica of `context_append_chunks` in `codex-rs/codex-api/src/endpoint/realtime_websocket/methods_frameless_bidi.rs`:
 * splits UTF-8 strings on valid code-point boundaries into chunks of at most 500 UTF-8 bytes.
 */
export function contextAppendChunks(text: string): string[] {
  if (Buffer.byteLength(text, "utf8") <= CONTEXT_APPEND_MAX_BYTES) {
    return [text];
  }
  const chunks: string[] = [];
  let current = "";
  for (const ch of text) {
    if (
      Buffer.byteLength(current + ch, "utf8") > CONTEXT_APPEND_MAX_BYTES &&
      current
    ) {
      chunks.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function buildFramelessSessionConfig(): Record<string, unknown> {
  const instructions = DEFAULT_INSTRUCTIONS + LIVE_DIRECTIVE;
  return {
    model: config.gptlive.model,
    instructions,
    audio: {
      output: {
        voice: voiceField(config.gptlive.voice),
      },
    },
    delegation: {
      type: "client",
    },
  };
}

export class GptLiveBridge {
  private ws: WebSocket | null = null;
  private peer: OpenAIQuicksilverAudioPeer | null = null;
  private pendingAudio = new OpenAIQuicksilverPendingAudio();
  private callId: string | null = null;
  private sessionId: string | null = null;
  private sessionStarted = false;
  private mediaClockReady = false;
  private readySignaled = false;
  private closedByServer: (() => void) | null = null;

  private readonly turns: TurnProjector;
  private handledCalls = new Set<string>();
  private transcriptMap = new Map<
    string,
    { role: "user" | "assistant"; text: string }
  >();
  private syncedTurnCount = 0;
  private agentHistory: Record<string, unknown>[] = [];
  private backendRunSeq = 0;
  private activeBackendAbort: AbortController | null = null;
  private currentCanvasHtml = "";
  private currentRevision = 0;
  private nextRevision = 0;
  private canvasHistory: Array<{
    revision: number;
    title: string;
    html: string;
    styles: string;
  }> = [];
  private readonly seenEventTypes = new Set<string>();

  constructor(
    private readonly events: GptLiveEvents,
    private readonly log: (msg: string) => void = () => {},
  ) {
    this.turns = new TurnProjector({
      onTurn: (turn) => {
        this.transcriptMap.set(turn.id, { role: turn.role, text: turn.text });
        this.events.onTurn(turn);
      },
      onUserTurnStarted: () => this.events.onUserTurnStarted(),
    });
  }

  get activeCallId(): string | null {
    return this.callId;
  }

  /**
   * Step 1 (WebRTC signaling): POST SDP offer + Frameless session config to CLIProxy `/v1/live`.
   * Returns `{ callId, answerSdp }`.
   */
  async createCall(
    offerSdp: string,
  ): Promise<{ callId: string; answerSdp: string }> {
    const res = await fetch(`${config.gptlive.baseUrl}/live`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.gptlive.apiKey}`,
        "OpenAI-Alpha": "quicksilver=v2",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sdp: offerSdp,
        session: buildFramelessSessionConfig(),
      }),
    });

    const bodyText = await res.text();
    if (!res.ok) {
      throw new Error(
        `CLIProxy /v1/live failed (${res.status}): ${bodyText.slice(0, 300)}`,
      );
    }

    const location = res.headers.get("location") ?? "";
    const callId =
      location
        .split("?")[0]
        ?.split("/")
        .filter(Boolean)
        .reverse()
        .find((seg) => seg.startsWith("rtc_")) ?? "";

    if (!callId) {
      throw new Error(
        `CLIProxy /v1/live missing rtc_ call_id in Location header: ${location}`,
      );
    }
    if (!bodyText.trimStart().startsWith("v=0")) {
      throw new Error(
        `CLIProxy /v1/live returned invalid SDP answer: ${bodyText.slice(0, 200)}`,
      );
    }

    this.callId = callId;
    this.sessionStarted = false;
    this.mediaClockReady = false;
    this.readySignaled = false;
    this.log(`WebRTC call created via CLIProxy: call_id=${callId}`);
    return { callId, answerSdp: bodyText };
  }

  /**
   * Create the server-side OpenClaw `OpenAIQuicksilverAudioPeer` (`werift` + `libopus-wasm`),
   * negotiate the WebRTC call with CLIProxy `/v1/live`, and apply the SDP answer.
   */
  async createServerAudioPeerCall(): Promise<string> {
    const peer = await OpenAIQuicksilverAudioPeer.create({
      callbacks: {
        onAudio: () => {
          /* Assistant 24kHz PCM is already delivered losslessly via Sideband output_audio.delta */
        },
        onError: (err) => this.events.onError(err.message),
        onMediaError: (err) =>
          this.log(`OpenClaw AudioPeer media warning: ${err.message}`),
      },
    });
    this.peer = peer;
    if (this.pendingAudio.length > 0) {
      const pending = this.pendingAudio;
      this.pendingAudio = new OpenAIQuicksilverPendingAudio();
      peer.adoptPendingAudio(pending);
    }
    const offerSdp = await peer.createOffer();
    const { callId, answerSdp } = await this.createCall(offerSdp);
    await peer.applyAnswer(answerSdp);
    return callId;
  }

  /**
   * Step 2 (Sideband control & transcript channel): connect to `ws://.../v1/live/${callId}`
   * and pump events until the call closes.
   */
  async run(): Promise<void> {
    if (!this.callId) {
      await this.createServerAudioPeerCall();
    }
    const callId = this.callId!;
    const sidebandUrl = `${config.gptlive.wsUrl}/live/${encodeURIComponent(callId)}`;

    return new Promise((resolve) => {
      const ws = new WebSocket(sidebandUrl, {
        headers: {
          Authorization: `Bearer ${config.gptlive.apiKey}`,
          "OpenAI-Alpha": "quicksilver=v2",
        },
        maxPayload: 16 * 1024 * 1024,
      });
      this.ws = ws;

      ws.on("open", () => {
        this.log(`Sideband WebSocket connected: ${sidebandUrl}`);
      });
      ws.on("message", (raw) => {
        try {
          this.handleEvent(JSON.parse(raw.toString()) as Json);
        } catch {
          this.log("gptlive error: malformed sideband event");
        }
      });
      ws.on("error", (err) => this.events.onError(err.message));
      ws.on("close", () => {
        this.ws = null;
        this.turns.dispose();
        resolve();
      });
    });
  }

  /**
   * Feed 24kHz mono PCM16 base64 microphone audio from the browser WebSocket
   * into OpenClaw's `OpenAIQuicksilverAudioPeer` ring buffer (20ms paced Opus RTP).
   */
  sendMicAudio(audioB64: string): void {
    const pcm = Buffer.from(audioB64, "base64");
    if (pcm.length < 2) return;
    if (this.peer) {
      this.peer.sendAudio(pcm);
    } else {
      this.pendingAudio.append(pcm);
    }
  }

  /**
   * Bidirectional canvas bridge: user tapped a node or control on the canvas.
   */
  handleCanvasInteract(text: string): void {
    const id = `canvas_${Date.now()}`;
    this.transcriptMap.set(id, {
      role: "user",
      text: `[Canvas touch interaction] ${text}`,
    });
    this.append(
      "instructions",
      `${text}。请立即用一两句自然的口语向用户讲解他刚点击的这个画布元素，或配合他刚触发的画布操作。`,
      null,
    );
  }

  /**
   * Send context into the running Frameless Bidi session using Codex's wire format:
   * - If `delegationId` is provided: `delegation.context.append` (`delegation_item_id`, `channel`, `content: [{type: "input_text", text}]`)
   * - Otherwise: `session.context.append` (`channel`, `content: [{type: "input_text", text}]`)
   */
  append(
    kind: AppendKind,
    text: string,
    delegationId: string | null = null,
  ): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const channel: ContextAppendChannel =
      kind === "instructions"
        ? "developer"
        : kind === "thinking"
          ? "commentary"
          : "speakable";
    const useDelegationEnvelope =
      Boolean(delegationId) && kind !== "instructions";

    for (const chunk of contextAppendChunks(trimmed)) {
      if (useDelegationEnvelope && delegationId) {
        this.sendRaw({
          type: "delegation.context.append",
          delegation_item_id: delegationId,
          channel,
          content: [{ type: "input_text", text: chunk }],
        });
      } else {
        this.sendRaw({
          type: "session.context.append",
          channel,
          content: [{ type: "input_text", text: chunk }],
        });
      }
    }
  }

  async close(): Promise<void> {
    this.abortActiveBackend("session closing");
    this.pendingAudio.clear();
    if (this.peer) {
      this.peer.close();
      this.peer = null;
    }
    const callId = this.callId;
    const ws = this.ws;
    if (ws) {
      const drained = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), CLOSE_DRAIN_TIMEOUT_MS);
        this.closedByServer = () => {
          clearTimeout(timer);
          resolve(true);
        };
        ws.once("close", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      this.sendRaw({ type: "session.close" });
      if (!(await drained)) ws.close();
    }
    if (callId) {
      this.callId = null;
      await fetch(
        `${config.gptlive.baseUrl}/realtime/calls/${encodeURIComponent(callId)}/hangup`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.gptlive.apiKey}`,
          },
        },
      ).catch(() => {});
    }
  }

  private sendRaw(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private maybeSignalReady(): void {
    if (this.readySignaled || !this.sessionStarted) return;
    if (this.peer && !this.mediaClockReady) return;
    this.readySignaled = true;
    this.sendGreeting();
    this.events.onReady();
  }

  private handleEvent(event: Json): void {
    this.debugEventShape(event);
    const type = String(event.type ?? "");

    switch (type) {
      case "session.started":
      case "session.updated": {
        this.sessionId = String(event.session?.id ?? this.callId ?? "");
        this.log(
          `gptlive 1.1 session started (id=${this.sessionId || "?"}` +
            (event.session?.expires_at
              ? `, expires_at=${event.session.expires_at}`
              : "") +
            ")",
        );
        if (type === "session.started") {
          this.sessionStarted = true;
          this.maybeSignalReady();
        }
        break;
      }

      // Sideband reflects both user mic audio and assistant output audio (24kHz PCM16 base64)
      case "session.input_audio.append":
      case "input_audio.append": {
        if (!this.mediaClockReady) {
          this.mediaClockReady = true;
          this.maybeSignalReady();
        }
        const audio =
          typeof event.audio === "string" ? event.audio : "";
        if (audio) this.events.onInputAudio?.(audio);
        break;
      }

      case "session.output_audio.delta":
      case "output_audio.delta": {
        const delta =
          typeof event.delta === "string"
            ? event.delta
            : typeof event.audio === "string"
              ? event.audio
              : "";
        if (delta) {
          if (!this.mediaClockReady) {
            this.mediaClockReady = true;
            this.maybeSignalReady();
          }
          this.events.onAudio(delta);
        }
        break;
      }

      // Frameless Bidi (Codex v3) transcript events: `input_transcript.added` / `output_transcript.added`
      // plus v3 `session.input_transcript.delta` / `session.output_transcript.delta`
      case "input_transcript.added":
      case "output_transcript.added":
      case "session.input_transcript.delta":
      case "session.output_transcript.delta": {
        const role =
          type === "input_transcript.added" ||
          type === "session.input_transcript.delta"
            ? "user"
            : "assistant";
        const text =
          typeof event.item?.text === "string"
            ? event.item.text
            : typeof event.delta === "string"
              ? event.delta
              : "";
        if (text) {
          this.turns.fragment(
            role,
            text,
            typeof event.start_ms === "number" ? event.start_ms : null,
            typeof event.end_ms === "number" ? event.end_ms : null,
          );
        }
        break;
      }

      case "turn.done": {
        const role = event.turn?.role;
        if (role === "user" || role === "assistant") {
          this.turns.close(role);
        }
        break;
      }

      // Frameless Bidi delegation event (`delegation.created` with `item.id` & `item.content`)
      // as well as legacy `session.delegation.created`
      case "delegation.created":
      case "session.delegation.created": {
        const item = event.item ?? event.delegation ?? {};
        const delegationId = typeof item.id === "string" ? item.id : "";
        const target = item.target ?? "client";
        let inputTranscript = "";
        if (Array.isArray(item.content)) {
          inputTranscript = item.content
            .filter(
              (c: any) =>
                c &&
                (c.type === "input_text" || typeof c.text === "string") &&
                typeof c.text === "string",
            )
            .map((c: any) => c.text)
            .join("");
        }
        this.log(
          `gptlive delegation created (target=${target}, id=${delegationId || "?"}, input=${JSON.stringify(inputTranscript)})`,
        );
        if (delegationId && target === "client") {
          void this.runLocalBackend(delegationId, inputTranscript);
        }
        break;
      }

      case "session.context.appended":
      case "delegation.context.appended":
      case "session.instructions.appended":
      case "session.thinking.appended":
      case "session.commentary.appended":
        if (config.gptlive.debug) {
          this.log(`gptlive ${type}`);
        }
        break;

      case "session.closed":
        this.log(
          `gptlive session closed (reason=${event.reason ?? "?"}` +
            (event.usage?.seconds !== undefined
              ? `, seconds=${event.usage.seconds}`
              : "") +
            ")",
        );
        this.closedByServer?.();
        break;

      case "session.usage.updated":
        this.log(
          `gptlive usage: audio_duration_ms=${event.usage?.audio_duration_ms ?? event.usage?.seconds ?? "?"}`,
        );
        break;

      case "error":
        this.log(`gptlive error: ${JSON.stringify(event).slice(0, 600)}`);
        this.events.onError(String(event.error?.message ?? "GPT-Live error"));
        break;

      default:
        break;
    }
  }

  private sendGreeting(): void {
    const greeting = DEFAULT_GREETING;
    if (!greeting) return;
    this.append("thinking", GREETING_PREAMBLE + greeting);
  }

  /** Cancel any in-flight backend Agent Loop run (on new delegation or verified user barge-in). */
  abortActiveBackend(reason: string): void {
    if (this.activeBackendAbort) {
      this.log(
        `aborting in-flight backend run #${this.backendRunSeq} (${reason})`,
      );
      this.activeBackendAbort.abort();
      this.activeBackendAbort = null;
    }
  }

  private pushCanvasRevision(
    rawHtml: string,
    title?: string,
    action: "write" | "edit" = "write",
  ): {
    revision: number;
    visibleLabels: string[];
  } {
    const preview = prepareStreamingPreview(rawHtml, { keepScripts: true });
    this.currentCanvasHtml = rawHtml;
    const revision = ++this.nextRevision;
    this.currentRevision = revision;
    const revTitle = (title && title.trim()) || `Revision #${revision}`;
    this.canvasHistory.push({
      revision,
      title: revTitle,
      html: preview.html || rawHtml,
      styles: preview.styles,
    });
    if (this.canvasHistory.length > 25) {
      this.canvasHistory.shift();
    }
    this.events.onToolCall("canvas_stream", {
      html: preview.html || rawHtml,
      styles: preview.styles,
      done: true,
      revision,
      title: revTitle,
      action,
    });
    const visibleLabels = [
      ...rawHtml.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi),
    ]
      .map((m) => (m[1] ?? "").replace(/<[^>]+>/g, "").trim())
      .filter(Boolean)
      .slice(0, 20);
    return { revision, visibleLabels };
  }

  private executeBackendToolCall(
    callName: string,
    parsedArgs: Record<string, unknown>,
    streamedHtml: string,
    t0: number,
    round: number,
    runSeq: number,
  ): Record<string, unknown> {
    if (callName === "render_canvas_card") {
      const htmlStr =
        typeof parsedArgs.html === "string" && parsedArgs.html.trim()
          ? parsedArgs.html
          : streamedHtml;
      if (!htmlStr) {
        return { shown: false, error: "missing html parameter" };
      }
      const title =
        typeof parsedArgs.title === "string" ? parsedArgs.title : undefined;
      const { revision, visibleLabels } = this.pushCanvasRevision(
        htmlStr,
        title,
      );
      this.log(
        `canvas write completed in ${Date.now() - t0}ms (rev=${revision}, ${htmlStr.length} chars, round=${round}, run=#${runSeq})`,
      );
      return {
        shown: true,
        status: "rendered on full-screen canvas",
        revision,
        visible_labels: visibleLabels,
        revisions: this.canvasHistory.map((r) => ({
          revision: r.revision,
          title: r.title,
        })),
      };
    }

    if (callName === "canvas_edit" || callName === "edit_canvas") {
      if (!this.currentCanvasHtml) {
        return {
          shown: false,
          error:
            "ERROR: canvas is currently empty. Call render_canvas_card first.",
        };
      }
      const oldString =
        typeof parsedArgs.old_string === "string" ? parsedArgs.old_string : "";
      const newString =
        typeof parsedArgs.new_string === "string" ? parsedArgs.new_string : "";
      if (!oldString) {
        return {
          shown: false,
          error: "ERROR: old_string not found in canvas (old_string was empty)",
        };
      }

      const occurrences = this.currentCanvasHtml.split(oldString).length - 1;
      if (occurrences === 0) {
        return {
          shown: false,
          error:
            "ERROR: old_string not found in canvas. Call canvas_read to inspect the exact current SVG/HTML.",
          current_canvas_html: this.currentCanvasHtml,
        };
      }
      if (occurrences > 1) {
        return {
          shown: false,
          error: `ERROR: old_string found ${occurrences} times, must be unique. Include more surrounding context.`,
        };
      }

      const updatedHtml = this.currentCanvasHtml.replace(
        oldString,
        () => newString,
      );
      const title =
        typeof parsedArgs.title === "string"
          ? parsedArgs.title
          : `Edited rev #${this.currentRevision}`;
      const { revision, visibleLabels } = this.pushCanvasRevision(
        updatedHtml,
        title,
        "edit",
      );
      this.log(
        `canvas_edit applied in ${Date.now() - t0}ms (rev=${revision}, chars=${updatedHtml.length}, run=#${runSeq})`,
      );
      return {
        shown: true,
        message: "OK: replacement applied",
        revision,
        visible_labels: visibleLabels,
      };
    }

    if (callName === "canvas_read" || callName === "read_canvas") {
      const lines = this.currentCanvasHtml.split("\n");
      const rawOffset =
        typeof parsedArgs.offset === "number"
          ? Math.max(1, Math.floor(parsedArgs.offset))
          : 1;
      const rawLimit =
        typeof parsedArgs.limit === "number" && parsedArgs.limit > 0
          ? Math.floor(parsedArgs.limit)
          : lines.length;
      const sliced = lines
        .slice(rawOffset - 1, rawOffset - 1 + rawLimit)
        .join("\n");
      return {
        shown: true,
        current_revision: this.currentRevision,
        total_lines: lines.length,
        content: sliced,
        revisions: this.canvasHistory.map((r) => ({
          revision: r.revision,
          title: r.title,
        })),
      };
    }

    if (callName === "restore_canvas_revision") {
      const targetRev = Number(parsedArgs.revision);
      const found = this.canvasHistory.find((r) => r.revision === targetRev);
      if (!found) {
        return {
          shown: false,
          error: `Revision ${targetRev} not found in history`,
          available_revisions: this.canvasHistory.map((r) => ({
            revision: r.revision,
            title: r.title,
          })),
        };
      }
      this.currentCanvasHtml = found.html;
      this.currentRevision = found.revision;
      this.events.onToolCall("canvas_stream", {
        html: found.html,
        styles: found.styles,
        done: true,
        revision: found.revision,
        title: found.title,
        action: "restore",
      });
      this.log(
        `canvas restored to revision #${found.revision} ("${found.title}") in ${Date.now() - t0}ms`,
      );
      return {
        shown: true,
        status: `restored canvas to revision #${found.revision} (${found.title})`,
        revision: found.revision,
        title: found.title,
      };
    }

    return { shown: false, error: `unknown tool ${callName}` };
  }

  private async runLocalBackend(
    delegationId: string,
    delegatedPrompt = "",
  ): Promise<void> {
    this.abortActiveBackend(`superseded by delegation ${delegationId}`);
    const runSeq = ++this.backendRunSeq;
    const abortController = new AbortController();
    this.activeBackendAbort = abortController;
    const isStale = () =>
      abortController.signal.aborted || this.backendRunSeq !== runSeq;

    const baseUrl = config.gptlive.baseUrl;
    const apiKey = config.gptlive.apiKey;
    const streamModel = config.gptlive.responsesModel;
    const serviceTier = config.gptlive.serviceTier;
    const t0 = Date.now();

    const allTurns = [...this.transcriptMap.values()];
    const newTurns = allTurns.slice(this.syncedTurnCount);
    this.syncedTurnCount = allTurns.length;
    const latestTranscript = (newTurns.length ? newTurns : allTurns.slice(-4))
      .map((t) => `${t.role}: ${t.text}`)
      .join("\n");

    const promptNote = delegatedPrompt.trim()
      ? `\nDelegated user request: ${delegatedPrompt.trim()}`
      : "";

    const revSummary = this.canvasHistory.length
      ? `\n[Canvas state: current revision=#${this.currentRevision}, history=${this.canvasHistory
          .map((r) => `#${r.revision}:${r.title}`)
          .join(", ")}]`
      : "\n[Canvas state: empty]";

    const runHistory: Record<string, unknown>[] = [
      ...this.agentHistory,
      {
        role: "user",
        content: `Voice transcript update:\n${latestTranscript}${promptNote}${revSummary}\n\nHandle the user's latest request.`,
      },
    ];
    this.agentHistory = [...runHistory];

    if (this.currentCanvasHtml && !isStale()) {
      const currentPreview = prepareStreamingPreview(this.currentCanvasHtml);
      this.events.onToolCall("canvas_stream", {
        html: currentPreview.html || this.currentCanvasHtml,
        styles: currentPreview.styles,
        done: false,
        title: "updating canvas…",
        action: "stream",
      });
    }

    try {
      this.events.onAgentActivity?.("Thinking…");
      const MAX_TOOL_ROUNDS = 3;
      let finalSpokenReply = "";

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (isStale()) return;

        const res = await fetch(`${baseUrl}/responses`, {
          method: "POST",
          signal: abortController.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: streamModel,
            instructions: RESPONSES_INSTRUCTIONS,
            input: runHistory,
            tools: toolSchemas(),
            tool_choice: "auto",
            parallel_tool_calls: true,
            store: false,
            stream: true,
            include: ["reasoning.encrypted_content"],
            reasoning: { effort: "low" },
            ...(serviceTier ? { service_tier: serviceTier } : {}),
          }),
        });

        if (!res.ok || !res.body) {
          throw new Error(`upstream ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = "";
        let rawArgJson = "";
        let streamedHtml = "";
        let roundText = "";
        let lastPushAt = 0;
        let firstFrameLogged = false;
        const outputItems: Json[] = [];

        const pushPreview = (htmlSource: string, done: boolean) => {
          if (isStale()) return;
          const preview = prepareStreamingPreview(htmlSource);
          if (!preview.html && !done) return;
          if (!firstFrameLogged && preview.html) {
            firstFrameLogged = true;
            this.events.onAgentActivity?.("Rendering canvas…");
            this.log(
              `canvas stream first visual frame at +${Date.now() - t0}ms (${preview.html.length} chars, round=${round}, run=#${runSeq})`,
            );
          }
          this.events.onToolCall("canvas_stream", {
            html: preview.html,
            styles: preview.styles,
            done,
          });
        };

        while (true) {
          if (isStale()) {
            await reader.cancel().catch(() => {});
            return;
          }
          const { done, value } = await reader.read();
          if (done) break;
          if (isStale()) return;
          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split("\n");
          sseBuffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const dataStr = line.slice(6).trim();
            if (!dataStr || dataStr === "[DONE]") continue;
            try {
              const ev = JSON.parse(dataStr);
              if (
                ev.type === "response.function_call_arguments.delta" &&
                typeof ev.delta === "string"
              ) {
                rawArgJson += ev.delta;
                const extracted = extractStreamingHtmlArg(rawArgJson);
                if (extracted) {
                  streamedHtml = extracted;
                  const now = Date.now();
                  if (now - lastPushAt >= 75) {
                    lastPushAt = now;
                    pushPreview(streamedHtml, false);
                  }
                }
              } else if (
                ev.type === "response.output_text.delta" &&
                typeof ev.delta === "string"
              ) {
                roundText += ev.delta;
              } else if (ev.type === "response.output_item.done" && ev.item) {
                outputItems.push(ev.item as Json);
              }
            } catch {
              /* ignore partial JSON line */
            }
          }
        }

        if (isStale()) return;

        if (roundText.trim()) {
          finalSpokenReply = roundText.trim();
        }

        for (const item of outputItems) {
          if (
            item.type === "reasoning" ||
            item.type === "function_call" ||
            item.type === "message"
          ) {
            runHistory.push(item);
          }
        }

        const calls = outputItems.filter(
          (item) => item.type === "function_call",
        );
        if (!calls.length) {
          this.agentHistory = [...runHistory];
          break;
        }

        for (const call of calls) {
          let parsedArgs: Record<string, unknown> = {};
          if (typeof call.arguments === "string" && call.arguments) {
            try {
              parsedArgs = JSON.parse(
                call.arguments,
              ) as Record<string, unknown>;
            } catch {
              parsedArgs = {};
            }
          }
          const callName =
            typeof call.name === "string" && call.name
              ? call.name
              : "render_canvas_card";
          const toolResult = this.executeBackendToolCall(
            callName,
            parsedArgs,
            streamedHtml,
            t0,
            round,
            runSeq,
          );

          runHistory.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify(toolResult),
          });
        }
        this.agentHistory = [...runHistory];
      }

      if (isStale()) return;

      const spokenReply = finalSpokenReply || CLIENT_DELEGATION_STUB;
      this.append("thinking", `Canvas state updated: ${spokenReply}`, null);
      this.append("commentary", spokenReply, delegationId);
    } catch (err) {
      if (isStale() || (err instanceof Error && err.name === "AbortError")) {
        this.log(`local backend run #${runSeq} aborted cleanly`);
        return;
      }
      this.log(
        `local backend delegation error: ${err instanceof Error ? err.message : err}`,
      );
      this.append("commentary", CLIENT_DELEGATION_STUB, delegationId);
    } finally {
      if (this.activeBackendAbort === abortController) {
        this.activeBackendAbort = null;
        this.events.onAgentActivity?.(null);
      }
    }
  }

  private debugEventShape(event: Json): void {
    if (!config.gptlive.debug) return;
    const type = String(event.type ?? "(untyped)");
    if (!this.seenEventTypes.has(type)) {
      this.seenEventTypes.add(type);
      this.log(
        `gptlive event: ${type} keys=[${Object.keys(event).sort().join(",")}]`,
      );
    }
    if (
      type !== "session.output_audio.delta" &&
      type !== "output_audio.delta" &&
      type !== "session.input_audio.append" &&
      type !== "input_audio.append"
    ) {
      this.log(`gptlive raw: ${JSON.stringify(event).slice(0, 600)}`);
    }
  }
}

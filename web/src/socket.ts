/**
 * The browser's leg of the session websocket. Mic audio goes up; transcripts,
 * visuals, and 24kHz PCM voice audio come down.
 */
import type { ClientMessage, ServerMessage, Turn, UiMessage } from "../../shared/messages";

export interface SessionSocketHandlers {
  onReady: () => void;
  onTurn: (turn: Turn) => void;
  onUi: (msg: UiMessage) => void;
  onAgentActivity?: (activity: string | null) => void;
  /** Assistant output was cut off on barge-in: clear queued playback audio. */
  onInterrupted: () => void;
  onError: (message: string) => void;
  onClose: () => void;
}

export interface SessionSocket {
  sendMicAudio: (base64: string) => void;
  sendCanvasInteract: (text: string) => void;
  unlockAudio: () => void;
  close: () => void;
}

export function openSessionSocket(
  wsPath: string,
  handlers: SessionSocketHandlers,
): SessionSocket {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}${wsPath}`);
  ws.binaryType = "arraybuffer";
  let closedByUs = false;
  let playbackCtx: AudioContext | null = null;
  let nextPlayTime = 0;
  const activeSources = new Set<AudioBufferSourceNode>();

  function clearPlaybackQueue(): void {
    for (const src of activeSources) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        /* ignore */
      }
    }
    activeSources.clear();
    if (playbackCtx) {
      nextPlayTime = playbackCtx.currentTime;
    }
  }

  ws.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
    if (event.data instanceof ArrayBuffer) {
      if (!playbackCtx) {
        playbackCtx = new AudioContext({ sampleRate: 24000 });
        nextPlayTime = playbackCtx.currentTime;
      }
      if (playbackCtx.state === "suspended") void playbackCtx.resume();
      const int16 = new Int16Array(event.data);
      if (int16.length === 0) return;
      const f32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) f32[i] = (int16[i] ?? 0) / 32768;
      const buf = playbackCtx.createBuffer(1, f32.length, 24000);
      buf.getChannelData(0).set(f32);
      const src = playbackCtx.createBufferSource();
      src.buffer = buf;
      src.connect(playbackCtx.destination);
      activeSources.add(src);
      src.onended = () => activeSources.delete(src);
      const now = playbackCtx.currentTime;
      if (nextPlayTime < now) nextPlayTime = now + 0.04;
      src.start(nextPlayTime);
      nextPlayTime += buf.duration;
      return;
    }
    let msg: ServerMessage;
    try {
      msg = JSON.parse(event.data) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "ready":
        if (playbackCtx?.state === "suspended") void playbackCtx.resume();
        handlers.onReady();
        break;
      case "turn":
        handlers.onTurn(msg);
        break;
      case "ui":
        handlers.onUi(msg);
        break;
      case "agent_activity":
        handlers.onAgentActivity?.(msg.activity);
        break;
      case "interrupted":
        clearPlaybackQueue();
        handlers.onInterrupted();
        break;
      case "error":
        handlers.onError(msg.message);
        break;
    }
  };

  ws.onerror = () => {
    if (!closedByUs) handlers.onError("connection to the server was lost");
  };
  ws.onclose = () => {
    if (!closedByUs) handlers.onClose();
  };

  const send = (msg: ClientMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  return {
    sendMicAudio: (audio) => send({ type: "mic_audio", audio }),
    sendCanvasInteract: (text) => send({ type: "canvas_interact", text }),
    unlockAudio: () => {
      if (playbackCtx?.state === "suspended") void playbackCtx.resume();
    },
    close: () => {
      closedByUs = true;
      clearPlaybackQueue();
      if (playbackCtx) {
        void playbackCtx.close();
        playbackCtx = null;
      }
      send({ type: "stop" });
      ws.close();
    },
  };
}

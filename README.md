# Nia Live Demo

Nia Live is a real-time full-duplex voice companion with a full-screen interactive visual canvas. The browser captures microphone audio, renders streaming SVG/HTML, plays assistant audio with Web Audio, and shows live subtitles and voice controls.

## Architecture

```text
Browser
  ├─ AudioWorklet: 24 kHz mono PCM16, 20 ms / 480-sample frames
  ├─ WebSocket: mic frames up, transcripts/UI/audio down
  ├─ Web Audio player: assistant PCM playback + interruption queue clear
  └─ Canvas stage: streaming SVG/HTML, local scripts, tap-to-voice bridge
        │
        ▼
Node Orchestrator (tsx, bound to 127.0.0.1:8787 by default)
  ├─ OpenAIQuicksilverAudioPeer (werift UDP + libopus-wasm)
  ├─ 200 ms audio jitter prebuffer (180 ms max wait, 40 ms slack)
  ├─ GPT-Live Sideband WebSocket and transcript projection
  └─ Ultrafast Responses tool loop
        │
        ▼
CLIProxyAPI (live-media-relay.enabled: true)
  ├─ GPT-Live: gpt-live-1-codex (Quicksilver v2 WebRTC + Sideband)
  └─ Responses: gpt-6.1-sol or gpt-6-astra (service_tier: ultrafast)
```

UDP ports require no client or orchestrator configuration: the server-side WebRTC peer negotiates ephemeral ICE/UDP ports with CLIProxyAPI, so applications only call the HTTP and WebSocket endpoints.

## Quickstart

Requirements: Node.js 22+, pnpm, and a running CLIProxyAPI configured with `live-media-relay.enabled: true`.

```bash
pnpm install
cp .env.example .env
# fill in CLIPROXY_API_KEY
pnpm dev
```

To build the frontend bundle and serve everything from the local Node orchestrator (`http://127.0.0.1:8787`):

```bash
pnpm build && pnpm start
```

`pnpm run setup` interactively collects `CLIPROXY_BASE_URL` and `CLIPROXY_API_KEY`, optionally checks `/v1/models`, and writes `.env`.

## Canvas tools

The Responses agent uses four tools:

- `render_canvas_card`: write a complete new canvas document.
- `canvas_edit`: replace one exact unique string in the current SVG/HTML.
- `canvas_read`: inspect current source and revision history.
- `restore_canvas_revision`: restore an earlier revision.

Interactive canvas code runs locally in the browser. Use local JavaScript for games, sliders, calculators, and animations. Add `data-voice-prompt`, `data-action`, or `data-prompt` only to controls that should create a voice turn; those attributes are bridged to `window.sendCanvasPrompt(text)` and then to the session WebSocket.

## Repository map

- `shared/`: typed browser/server protocol and tool schemas.
- `server/`: GPT-Live bridge, server-side UDP/Opus peer, Responses tool loop, and HTTP/WebSocket server.
- `web/`: Vite client, AudioWorklet microphone capture, Web Audio playback, canvas stage, subtitles, and controls.
- `server/prompts/`: editable Nia voice persona.

## Security and hygiene

This repository is designed as a local developer demo (`HOST=127.0.0.1` by default). The browser never receives `CLIPROXY_API_KEY`, while model-generated canvas SVG/HTML and scripts execute directly in the browser session for low-latency streaming interactivity. Keep `.env`, `node_modules/`, and `web/dist/` untracked.

## License

MIT © 2026 Nia Teams. Third-party notices are listed in `THIRD_PARTY_NOTICES.md`.

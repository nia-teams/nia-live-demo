# Nia Live Demo

English | [简体中文](./README_CN.md)

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
Node Orchestrator (tsx, bound to 0.0.0.0:8787 by default)
  ├─ OpenAIQuicksilverAudioPeer (werift UDP + libopus-wasm)
  ├─ 200 ms audio jitter prebuffer (180 ms max wait, 40 ms slack)
  ├─ GPT-Live Sideband WebSocket and transcript projection
  └─ Ultrafast Responses tool loop
        │
        ▼
CLIProxyAPI (oauth.providers.codex.live-media-relay.enabled: true)
  ├─ GPT-Live: gpt-live-1-codex (Quicksilver v2 WebRTC + Sideband)
  └─ Responses: gpt-6.1-sol or gpt-6-astra (service_tier: ultrafast)
```

UDP ports require no client or orchestrator configuration: the server-side WebRTC peer negotiates ephemeral local ICE/UDP ports with CLIProxyAPI, so applications only call the HTTP and WebSocket endpoints.

## Prerequisites

1. **Node.js 20.12+** (or 22+) and **pnpm** (`corepack enable`).
2. **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** (with Codex Live media relay enabled): for how to use CLIProxyAPI (and proxy setup if needed), refer to [CLIProxyAPI on GitHub](https://github.com/router-for-me/CLIProxyAPI) and its [official guides](https://help.router-for.me/).
3. **ChatGPT Subscription Account** (connected via CLIProxyAPI Codex OAuth):
   - Default `GPT_LIVE_SERVICE_TIER=ultrafast` (`gpt-6.1-sol` / `gpt-6-astra`) requires a **ChatGPT Pro ($500/month)** subscription.
   - For non-$500 tiers (e.g., $200 Pro / Plus), set `GPT_LIVE_SERVICE_TIER=default` (or `priority`) in `.env`.

## Quick Start

```bash
pnpm install
cp .env.example .env
pnpm run setup
pnpm dev
```

`pnpm dev` starts the Node orchestrator on `http://0.0.0.0:8787` and the Vite client on `http://0.0.0.0:5173`. To build the frontend bundle and serve everything from the Node server:

```bash
pnpm build && pnpm start
```

### Opening on a Mobile Phone

Mobile browsers (iOS Safari / Chrome) require a trusted **HTTPS** URL on non-`localhost` origins to access the microphone (`getUserMedia` / `AudioWorklet`)—opening a plain LAN URL such as `http://192.168.x.x:5173` will block the microphone, and iOS also blocks `wss://` WebSockets on untrusted self-signed certificates. If your environment does not already provide an HTTPS preview URL, expose the local port through an HTTPS tunnel; for tunnel usage, refer directly to the official documentation of [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), [localhost.run](https://localhost.run/docs/), or [VS Code Port Forwarding](https://code.visualstudio.com/docs/debugtest/port-forwarding).

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

This repository is designed as a developer reference demo (`HOST=0.0.0.0` by default for mobile/tunnel testing; set `HOST=127.0.0.1` in `.env` for loopback-only). The browser never receives `CLIPROXY_API_KEY`, while model-generated canvas SVG/HTML and scripts execute directly in the browser session for low-latency streaming interactivity. Keep `.env`, `node_modules/`, and `web/dist/` untracked.

## License

MIT © 2026 Nia Teams. Third-party notices are listed in `THIRD_PARTY_NOTICES.md`.

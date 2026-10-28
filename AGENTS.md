# AGENTS.md

This repository is a small pnpm workspace for Nia Live. Keep changes focused and preserve the typed browser/server contract.

## Commands

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm dev
```

`pnpm dev` starts the Node server on `0.0.0.0:8787` and Vite on `0.0.0.0:5173`; the Vite proxy forwards `/api` and `/ws` to Node.

## Repository boundaries

- `shared/messages.ts` is the wire protocol. Keep `UiMessage` limited to `canvas_card` and `canvas_stream`.
- `shared/tools.ts` defines the four canvas tools and their schemas.
- `server/src/gptlive.ts` owns Quicksilver WebRTC signaling, Sideband events, delegation, Responses streaming, and revision state.
- `server/src/session.ts` owns the 200 ms audio prebuffer, barge-in handling, silence check-ins, and browser socket emission.
- `web/src/micCapture.ts` must continue sending continuous 24 kHz PCM16 frames, including silence; model turn detection owns VAD.
- `web/src/socket.ts` must clear the Web Audio playback queue when it receives `interrupted`.
- `web/src/overlays/index.ts` owns canvas DOM updates and the `[data-voice-prompt],[data-action],[data-prompt]` bridge.

## Canvas guidance

Use local JavaScript for games, sliders, calculators, and animation loops. Register `window.__canvasCleanup` for timers or animation frames. Use voice data attributes only for actions that should be explained conversationally; high-frequency controls should remain local.

In this local reference demo, `canvas_stream` renders directly into `#stream-surface` in the page DOM so progressive SVG/HTML and interactive scripts run without iframe churn. Keep API keys and server secrets strictly on the Node side; if adapting this demo for a multi-user or public deployment, isolate untrusted canvas markup/scripts inside a sandboxed iframe.

## Documentation

`README.md` is the public overview. `docs/ARCHITECTURE.md` explains transport, buffering, and canvas interaction. Persona text lives in `server/prompts/instructions.md` and `server/prompts/greeting.md`.

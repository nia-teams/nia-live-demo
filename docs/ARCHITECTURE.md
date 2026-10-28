# Nia Live Architecture

## Runtime flow

1. A user gesture starts microphone capture immediately. `AudioWorklet` downsamples to 24 kHz mono PCM16 and batches exactly 480 samples (20 ms) per frame.
2. The browser opens a session WebSocket. Mic frames travel to Node; Node sends them through `OpenAIQuicksilverAudioPeer`, which uses `werift` for WebRTC/UDP and `libopus-wasm` for Opus pacing.
3. CLIProxyAPI relays GPT-Live media and exposes a Sideband WebSocket. The Node bridge projects transcript fragments into turns and forwards assistant PCM to the browser.
4. Node holds a 200 ms audio prebuffer (`PREBUFFER_TARGET_MS = 200`, `PREBUFFER_MAX_WAIT_MS = 180`, `UNDERRUN_SLACK_MS = 40`) to smooth jitter. On barge-in, the server emits `interrupted`; the browser clears queued Web Audio sources immediately.
5. GPT-Live delegates canvas work to a Responses loop using `gpt-6.1-sol` or `gpt-6-astra` with `service_tier: "ultrafast"`.
6. Responses tool output streams as typed `canvas_stream` messages. The browser updates `#canvas-deck`, executes completed local scripts, and bridges selected controls back to voice.

## Why UDP needs no configuration

The server creates the WebRTC peer and negotiates ephemeral ICE/UDP ports with CLIProxyAPI. Neither the browser nor the application needs to select or expose a fixed media port. Deployments still need normal outbound UDP reachability and any infrastructure firewall policy required by the hosting environment.

## Browser surface

- Full-screen `#stage` containing `#canvas-deck`.
- Starter Nia card followed by streamed SVG/HTML on the live canvas.
- Four most recent transcript turns with Chinese punctuation normalization that preserves decimals such as `1.5`.
- A 24 px bottom status row with `Thinking…` / `Rendering canvas…` activity states.
- One centered 56 px control that transitions from start, to connecting/cancel, to mic/mute with liquid fill and halo feedback.

## Canvas interaction model

Canvas-generated local JavaScript handles high-frequency interaction directly in `#stream-surface` without a server round trip. Conversational controls use `[data-voice-prompt]`, `[data-action]`, or `[data-prompt]`; the delegated click bridge calls `window.sendCanvasPrompt(text)` and forwards the text over the session WebSocket.

## Production hardening

By default the demo binds to `0.0.0.0` (for mobile/tunnel testing; override with `HOST=127.0.0.1` in `.env` for loopback-only) and checks WebSocket upgrade origins against `Host` / `X-Forwarded-Host`. Before exposing a deployment publicly, add authentication and rate limiting around session creation and WebSocket upgrades, isolate model-generated canvas HTML/JS in a sandboxed iframe according to your threat model, and keep upstream diagnostics server-side.

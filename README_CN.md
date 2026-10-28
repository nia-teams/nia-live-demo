# Nia Live Demo

[English](./README.md) | 简体中文

Nia Live 是一个全双工实时语音 + 全屏流式交互画布（SVG/HTML）伙伴 Demo。浏览器采集麦克风音频、实时渲染流式画布并播放语音，Node 编排层通过本地 WebRTC + Sideband 连接 CLIProxyAPI，实现边聊边画、点击画布元素双向联动与随时语音打断。

## 架构概览

```text
Browser（浏览器）
  ├─ AudioWorklet: 24 kHz 单声道 PCM16，20 ms / 480 采样帧上行
  ├─ WebSocket: 上行麦克风音频帧，下行实时字幕 / 画布流 / 语音流
  ├─ Web Audio: 播放助手语音，用户开口打断时立即清空播放队列
  └─ Canvas Stage: 流式渲染 SVG/HTML、运行本地交互脚本、点击桥接回语音
        │
        ▼
Node Orchestrator（默认监听 127.0.0.1:8787）
  ├─ OpenAIQuicksilverAudioPeer (werift UDP + libopus-wasm)
  ├─ 200 ms 音频抖动预缓冲（最大等待 180 ms，欠载容差 40 ms）
  ├─ GPT-Live Sideband WebSocket 与实时分句投影
  └─ Ultrafast Responses 画布工具循环
        │
        ▼
CLIProxyAPI (oauth.providers.codex.live-media-relay.enabled: true)
  ├─ GPT-Live: gpt-live-1-codex (Quicksilver v2 WebRTC + Sideband)
  └─ Responses: gpt-6.1-sol 或 gpt-6-astra (service_tier: ultrafast)
```

## 前置依赖

1. **Node.js 22+** 与 **pnpm**（`corepack enable`）。
2. **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)**（需开启 Codex 实时媒体中继）：具体使用方式（以及如需配置代理）请直接参考 [CLIProxyAPI GitHub 仓库](https://github.com/router-for-me/CLIProxyAPI)（[中文说明](https://github.com/router-for-me/CLIProxyAPI/blob/main/README_CN.md)）及其[官方用户手册](https://help.router-for.me/cn/)。
3. **ChatGPT 订阅账号**（通过 CLIProxyAPI 的 Codex OAuth 接入）：
   - 默认 `GPT_LIVE_SERVICE_TIER=ultrafast`（`gpt-6.1-sol` / `gpt-6-astra`）需要 **ChatGPT Pro（$500/月档位）** 订阅账号。
   - 若使用非 $500 档位账号（如 $200 Pro / Plus），请在 `.env` 中设置 `GPT_LIVE_SERVICE_TIER=default`（或 `priority`）。

## 快速启动

```bash
pnpm install
cp .env.example .env
pnpm run setup
pnpm dev
```

`pnpm dev` 会启动 Node 服务（`http://127.0.0.1:8787`）与 Vite 前端（`http://localhost:5173`）。若需构建前端静态产物并由单个 Node 进程统一托管：

```bash
pnpm build && pnpm start
```

## 画布工具说明

后端 Responses 画布智能体使用四个工具维护全屏画布状态：

- `render_canvas_card`：写入全新的全屏 SVG/HTML 画布文档。
- `canvas_edit`：对当前画布源码做精确唯一字符串替换（局部增量高亮或改字）。
- `canvas_read`：读取当前画布源码与历史版本号。
- `restore_canvas_revision`：回滚到指定的历史版本。

画布中的高频交互（游戏循环、滑块、计算器、动画）直接在浏览器本地 JavaScript 中运行；需要触发语音讲解的按钮或节点添加 `data-voice-prompt`、`data-action` 或 `data-prompt` 属性即可自动桥接回语音会话。

## 目录结构

- `shared/`：前后端共享的消息协议与画布工具 Schema。
- `server/`：GPT-Live 桥接、服务端 WebRTC/Opus 媒体节点、Responses 流式工具循环与 HTTP/WebSocket 服务。
- `web/`：Vite 前端、AudioWorklet 24kHz 麦克风采集、Web Audio 播放、全屏画布与字幕控制栏。
- `server/prompts/`：可自由定制的 Nia 语音人设与开场白。

## 安全边界说明

本仓库定位为本地开发者参考 Demo（服务端默认仅绑定 `HOST=127.0.0.1`）。浏览器端不会接触 `CLIPROXY_API_KEY`；模型生成的画布 SVG/HTML 与交互脚本直接在当前页面会话内执行以获得最低流式延迟。请勿提交 `.env`、`node_modules/` 与 `web/dist/`。

## 开源协议

MIT © 2026 Nia Teams。第三方开源组件声明见 `THIRD_PARTY_NOTICES.md`。

import type { UiMessage } from "../../../shared/messages";

export interface OverlayContext {
  stage: HTMLElement;
  onCanvasInteract?: (text: string) => void;
}

export interface Overlays {
  render: (msg: UiMessage) => void;
  hideAll: () => void;
}

const STREAM_DESIGN_SYSTEM_CSS = `
:root {
  --color-background-primary: #0b0d12;
  --color-background-secondary: #151a2a;
  --color-background-tertiary: #1e263d;
  --color-background-info: #0C447C;
  --color-background-danger: #501313;
  --color-background-success: #173404;
  --color-background-warning: #412402;
  --color-text-primary: #eef2ff;
  --color-text-secondary: #9aa7c2;
  --color-text-tertiary: #6d7b99;
  --color-text-info: #85B7EB;
  --color-text-danger: #F09595;
  --color-text-success: #97C459;
  --color-text-warning: #EF9F27;
  --color-border-primary: rgba(255, 255, 255, 0.36);
  --color-border-secondary: rgba(255, 255, 255, 0.24);
  --color-border-tertiary: rgba(255, 255, 255, 0.14);
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: "SF Mono", "Fira Code", monospace;
  --p: var(--color-text-primary);
  --s: var(--color-text-secondary);
  --t: var(--color-text-tertiary);
  --bg2: var(--color-background-secondary);
  --b: var(--color-border-tertiary);
}

#stream-surface > svg,
#stream-surface > canvas {
  width: 100% !important;
  height: 100% !important;
  max-width: 100% !important;
  max-height: 100% !important;
  display: block;
}

svg text.t   { font: 400 15px var(--font-sans); fill: #e8ecf4; }
svg text.ts  { font: 400 13px var(--font-sans); fill: #9aa7c2; }
svg text.th  { font: 500 16px var(--font-sans); fill: #f4f7ff; }

svg .box > rect, svg .box > circle, svg .box > ellipse { fill: #151a2a; stroke: rgba(255,255,255,0.22); }
svg .node, svg [data-prompt], svg g[id] { cursor: pointer; transition: filter 0.2s ease, opacity 0.2s ease; }
svg .node:active, svg [data-prompt]:active, svg g[id]:active { filter: brightness(1.25) drop-shadow(0 0 10px rgba(110,168,255,0.55)); }
svg .arr { stroke: #9aa7c2; stroke-width: 1.5; fill: none; }
svg .leader { stroke: #6d7b99; stroke-width: 0.75; stroke-dasharray: 4 4; fill: none; }

/* Nia Live semantic dark-mode palettes */
svg .c-purple > rect, svg .c-purple > circle, svg .c-purple > ellipse,
svg rect.c-purple, svg circle.c-purple, svg ellipse.c-purple { fill: #2e276c; stroke: #AFA9EC; stroke-width: 1; }
svg .c-purple text.th, svg .c-purple text.t, svg .c-purple text { fill: #e0defc; }
svg .c-purple text.ts { fill: #b8b3f0; }

svg .c-teal > rect, svg .c-teal > circle, svg .c-teal > ellipse,
svg rect.c-teal, svg circle.c-teal, svg ellipse.c-teal { fill: #0a4638; stroke: #5DCAA5; stroke-width: 1; }
svg .c-teal text.th, svg .c-teal text.t, svg .c-teal text { fill: #bcf0de; }
svg .c-teal text.ts { fill: #74d9b6; }

svg .c-coral > rect, svg .c-coral > circle, svg .c-coral > ellipse,
svg rect.c-coral, svg circle.c-coral, svg ellipse.c-coral { fill: #5e2410; stroke: #F0997B; stroke-width: 1; }
svg .c-coral text.th, svg .c-coral text.t, svg .c-coral text { fill: #fbd6c8; }
svg .c-coral text.ts { fill: #f3ab91; }

svg .c-pink > rect, svg .c-pink > circle, svg .c-pink > ellipse,
svg rect.c-pink, svg circle.c-pink, svg ellipse.c-pink { fill: #5c1d32; stroke: #ED93B1; stroke-width: 1; }
svg .c-pink text.th, svg .c-pink text.t, svg .c-pink text { fill: #fad4e1; }
svg .c-pink text.ts { fill: #f0a6be; }

svg .c-gray > rect, svg .c-gray > circle, svg .c-gray > ellipse,
svg rect.c-gray, svg circle.c-gray, svg ellipse.c-gray { fill: #262936; stroke: #94a3b8; stroke-width: 1; }
svg .c-gray text.th, svg .c-gray text.t, svg .c-gray text { fill: #e2e8f0; }
svg .c-gray text.ts { fill: #94a3b8; }

svg .c-blue > rect, svg .c-blue > circle, svg .c-blue > ellipse,
svg rect.c-blue, svg circle.c-blue, svg ellipse.c-blue { fill: #0e3a6c; stroke: #85B7EB; stroke-width: 1; }
svg .c-blue text.th, svg .c-blue text.t, svg .c-blue text { fill: #d0e6fc; }
svg .c-blue text.ts { fill: #96c3f0; }

svg .c-green > rect, svg .c-green > circle, svg .c-green > ellipse,
svg rect.c-green, svg circle.c-green, svg ellipse.c-green { fill: #1e420b; stroke: #97C459; stroke-width: 1; }
svg .c-green text.th, svg .c-green text.t, svg .c-green text { fill: #d7edb5; }
svg .c-green text.ts { fill: #a9d171; }

svg .c-amber > rect, svg .c-amber > circle, svg .c-amber > ellipse,
svg rect.c-amber, svg circle.c-amber, svg ellipse.c-amber { fill: #522e05; stroke: #EF9F27; stroke-width: 1; }
svg .c-amber text.th, svg .c-amber text.t, svg .c-amber text { fill: #fde09e; }
svg .c-amber text.ts { fill: #f3b34c; }

svg .c-red > rect, svg .c-red > circle, svg .c-red > ellipse,
svg rect.c-red, svg circle.c-red, svg ellipse.c-red { fill: #611919; stroke: #F09595; stroke-width: 1; }
svg .c-red text.th, svg .c-red text.t, svg .c-red text { fill: #fad1d1; }
svg .c-red text.ts { fill: #f3a8a8; }

.canvas-tap-flash {
  filter: drop-shadow(0 0 12px rgba(110, 168, 255, 0.85)) brightness(1.22) !important;
}
`;

export function createOverlays(ctx: OverlayContext): Overlays {
  let canvasDeck = document.getElementById("canvas-deck") as HTMLDivElement | null;
  if (!canvasDeck) {
    canvasDeck = document.createElement("div");
    canvasDeck.id = "canvas-deck";
    canvasDeck.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;z-index:3;display:none;background:linear-gradient(180deg, #121726 0%, #090b10 58%, #050608 68%, #050608 100%);padding:0;margin:0;box-sizing:border-box;overflow:hidden;";
    ctx.stage.appendChild(canvasDeck);
  }

  let streamStyleEl: HTMLStyleElement | null = null;
  let streamSurfaceEl: HTMLDivElement | null = null;

  const fireInteract = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    ctx.onCanvasInteract?.(trimmed);
  };

  // Expose global bridge for inline scripts/sliders inside generated HTML/SVG
  const win = window as unknown as {
    sendCanvasPrompt?: (text: string) => void;
    Websandbox?: { connection: { remote: { sendPrompt: (p: { text: string }) => Promise<void> } } };
  };
  win.sendCanvasPrompt = (text: string) => fireInteract(text);
  win.Websandbox = {
    connection: {
      remote: {
        sendPrompt: async ({ text }: { text: string }) => {
          fireInteract(text);
        },
      },
    },
  };

  const ensureStreamSurface = (): HTMLDivElement => {
    if (!streamSurfaceEl || !canvasDeck!.contains(streamSurfaceEl)) {
      canvasDeck!.innerHTML = "";
      streamStyleEl = document.createElement("style");
      streamStyleEl.textContent = STREAM_DESIGN_SYSTEM_CSS;
      streamSurfaceEl = document.createElement("div");
      streamSurfaceEl.id = "stream-surface";
      streamSurfaceEl.style.cssText =
        "width:100%;height:100%;padding:8px 8px 0;display:flex;flex-direction:column;align-items:stretch;justify-content:flex-start;overflow:auto;box-sizing:border-box;";

      // Elements marked with [data-voice-prompt], [data-action], or [data-prompt] trigger a voice turn
      streamSurfaceEl.addEventListener("click", (ev) => {
        const target = ev.target as Element | null;
        if (!target) return;
        const promptEl = target.closest("[data-voice-prompt],[data-action],[data-prompt]");
        if (promptEl && streamSurfaceEl!.contains(promptEl)) {
          promptEl.classList.add("canvas-tap-flash");
          setTimeout(() => promptEl.classList.remove("canvas-tap-flash"), 700);
          const promptText =
            promptEl.getAttribute("data-voice-prompt") ||
            promptEl.getAttribute("data-action") ||
            promptEl.getAttribute("data-prompt") ||
            "";
          if (promptText) {
            fireInteract(promptText);
          }
        }
      });

      canvasDeck!.append(streamStyleEl, streamSurfaceEl);
    }
    return streamSurfaceEl;
  };

  const hideAll = () => {
    if (canvasDeck) {
      canvasDeck.style.display = "none";
      canvasDeck.innerHTML = "";
      streamStyleEl = null;
      streamSurfaceEl = null;
    }
  };

  const render = (msg: UiMessage) => {
    switch (msg.widget) {
      case "canvas_card": {
                if (!canvasDeck) break;
        canvasDeck.style.display = "block";
        canvasDeck.innerHTML = "";
        streamStyleEl = null;
        streamSurfaceEl = null;
        const iframe = document.createElement("iframe");
        iframe.style.cssText =
          "position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent;margin:0;padding:0;overflow:hidden;display:block;";
        iframe.setAttribute("scrolling", "no");
        iframe.setAttribute("sandbox", "allow-scripts");
        iframe.srcdoc = msg.props.srcDoc;
        canvasDeck.appendChild(iframe);
        break;
      }
      case "canvas_stream": {
                if (!canvasDeck) break;
        canvasDeck.style.display = "block";
        const surface = ensureStreamSurface();
        if (streamStyleEl) {
          const extra = typeof msg.props.styles === "string" ? msg.props.styles : "";
          const fullCss = `${STREAM_DESIGN_SYSTEM_CSS}\n${extra}`;
          if (streamStyleEl.textContent !== fullCss) {
            streamStyleEl.textContent = fullCss;
          }
        }
        surface.innerHTML = msg.props.html;
        if (msg.props.done) {
          // Cancel any running timers/animation loops from a previous canvas script
          const winAny = window as unknown as { __canvasCleanup?: () => void };
          if (typeof winAny.__canvasCleanup === "function") {
            try {
              winAny.__canvasCleanup();
            } catch {
              /* ignore cleanup errors */
            }
            winAny.__canvasCleanup = undefined;
          }
          const scripts = surface.querySelectorAll("script");
          scripts.forEach((oldScript) => {
            const s = document.createElement("script");
            for (let i = 0; i < oldScript.attributes.length; i++) {
              const attr = oldScript.attributes[i]!;
              s.setAttribute(attr.name, attr.value);
            }
            s.textContent = oldScript.textContent;
            oldScript.parentNode?.replaceChild(s, oldScript);
          });
        }
        break;
      }
    }
  };

  return { render, hideAll };
}

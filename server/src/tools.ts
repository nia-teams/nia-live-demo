import type { UiMessage } from "../../shared/messages";
import { inferToolName } from "../../shared/tools";

const STREAM_LISTENER_SCRIPT = `<script>
window.addEventListener("message", function(e) {
  var d = e.data;
  if (!d || d.type !== "canvas-stream") return;
  if (typeof d.styles === "string") {
    var st = document.getElementById("stream-styles");
    if (!st) {
      st = document.createElement("style");
      st.id = "stream-styles";
      document.head.appendChild(st);
    }
    if (st.textContent !== d.styles) st.textContent = d.styles;
  }
  var root = document.getElementById("content");
  if (root && typeof d.html === "string") {
    root.innerHTML = d.html;
    if (d.done) {
      var scripts = root.querySelectorAll("script");
      scripts.forEach(function(oldScript) {
        var s = document.createElement("script");
        for (var i = 0; i < oldScript.attributes.length; i++) {
          var attr = oldScript.attributes[i];
          s.setAttribute(attr.name, attr.value);
        }
        s.textContent = oldScript.textContent;
        oldScript.parentNode.replaceChild(s, oldScript);
      });
    }
  }
});
</script>`;

export function assembleCanvasDoc(html: string): string {
  return `<!DOCTYPE html>
<html style="color-scheme: dark;">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <style>
    :root {
      --color-background-primary: #0b0d12;
      --color-background-secondary: #151a2a;
      --color-background-tertiary: #1e263d;
      --color-text-primary: #eef2ff;
      --color-text-secondary: #9aa7c2;
      --color-text-tertiary: #6d7b99;
      --color-border-primary: rgba(255, 255, 255, 0.32);
      --color-border-secondary: rgba(255, 255, 255, 0.2);
      --color-border-tertiary: rgba(255, 255, 255, 0.1);
    }
    * {
      box-sizing: border-box;
    }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      overscroll-behavior: none;
      background: transparent;
      color: var(--color-text-primary);
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    #content {
      width: 100%;
      height: 100%;
      padding: 8px 8px 0;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      justify-content: flex-start;
      overflow: auto;
    }
    #content > svg,
    #content > canvas {
      width: 100% !important;
      height: 100% !important;
      max-width: 100% !important;
      max-height: 100% !important;
      display: block;
    }
  </style>
  ${STREAM_LISTENER_SCRIPT}
</head>
<body>
  <div id="content" class="initial-render">
    ${html}
  </div>
</body>
</html>`;
}

/**
 * Sanitizes and auto-closes partial streaming HTML/SVG so the browser can
 * render progressive elements smoothly before the closing tags arrive.
 */
export function prepareStreamingPreview(
  raw: string,
  options?: { keepScripts?: boolean },
): { styles: string; html: string } {
  const cleaned = raw
    .replace(/^```(?:html|svg|xml)?\s*/i, "")
    .replace(/```\s*$/i, "");

  const styleMatches = cleaned.match(/<style\b[^>]*>([\s\S]*?)<\/style>/gi);
  const styles = styleMatches
    ? styleMatches.map((s) => s.replace(/<\/?style\b[^>]*>/gi, "")).join("\n")
    : "";

  if (options?.keepScripts) {
    const finalHtml = cleaned
      .replace(/<(style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .trim();
    return { styles, html: finalHtml };
  }

  let body = cleaned.replace(/<[^>]*$/, "");
  body = body.replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  body = body.replace(/<(style|script|head)\b[^>]*>[\s\S]*$/gi, "");
  body = body.replace(/&[a-zA-Z0-9#]*$/, "");

  const openSvgs = (body.match(/<svg\b/gi) || []).length;
  const closeSvgs = (body.match(/<\/svg>/gi) || []).length;
  if (openSvgs > closeSvgs) {
    const openDefs = (body.match(/<defs\b/gi) || []).length;
    const closeDefs = (body.match(/<\/defs>/gi) || []).length;
    if (openDefs > closeDefs) {
      const openRadial = (body.match(/<radialGradient\b/gi) || []).length;
      const closeRadial = (body.match(/<\/radialGradient>/gi) || []).length;
      for (let i = 0; i < openRadial - closeRadial; i++) body += "</radialGradient>";
      const openLinear = (body.match(/<linearGradient\b/gi) || []).length;
      const closeLinear = (body.match(/<\/linearGradient>/gi) || []).length;
      for (let i = 0; i < openLinear - closeLinear; i++) body += "</linearGradient>";
      body += "</defs>";
    }
    const openG = (body.match(/<g\b/gi) || []).length;
    const closeG = (body.match(/<\/g>/gi) || []).length;
    for (let i = 0; i < openG - closeG; i++) body += "</g>";
    for (let i = 0; i < openSvgs - closeSvgs; i++) body += "</svg>";
  }

  return { styles, html: body };
}

/**
 * Extracts the streaming string value of `"html": "..."` from an incomplete
 * `response.function_call_arguments.delta` JSON buffer so progressive canvas
 * preview works inside the standard Responses tool-call loop.
 */
export function extractStreamingHtmlArg(partialJson: string): string {
  const m = partialJson.match(/"html"\s*:\s*"/);
  if (!m || m.index === undefined) return "";
  let i = m.index + m[0].length;
  let out = "";
  while (i < partialJson.length) {
    const ch = partialJson[i];
    if (ch === "\\") {
      if (i + 1 >= partialJson.length) break;
      const next = partialJson[i + 1];
      if (next === "n") out += "\n";
      else if (next === "r") out += "\r";
      else if (next === "t") out += "\t";
      else if (next === '"' || next === "\\" || next === "/") out += next;
      else if (next === "u") {
        if (i + 5 >= partialJson.length) break;
        out += String.fromCharCode(parseInt(partialJson.slice(i + 2, i + 6), 16));
        i += 4;
      }
      i += 2;
    } else if (ch === '"') {
      break;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

export function dispatchToolCall(
  name: string | null,
  args: Record<string, unknown>,
): UiMessage | null {
  if (name === "canvas_stream") {
    return {
      widget: "canvas_stream",
      props: {
        html: typeof args.html === "string" ? args.html : "",
        ...(typeof args.styles === "string" ? { styles: args.styles } : {}),
        done: Boolean(args.done),
        ...(typeof args.revision === "number" ? { revision: args.revision } : {}),
        ...(typeof args.title === "string" ? { title: args.title } : {}),
        ...(typeof args.action === "string"
          ? { action: args.action as "write" | "edit" | "restore" | "stream" }
          : {}),
      },
    };
  }
  const resolved = name || inferToolName(args);
  if (!resolved) return null;

  const text = (value: unknown, max: number): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : undefined;
  };

  switch (resolved) {
    case "render_canvas_card": {
      const title = text(args.title, 100) ?? "Canvas";
      const subtitle = text(args.subtitle, 200);
      const html = typeof args.html === "string" ? args.html.trim() : "";
      if (!html) return null;
      return {
        widget: "canvas_card",
        props: {
          title,
          ...(subtitle ? { subtitle } : {}),
          srcDoc: assembleCanvasDoc(html),
        },
      };
    }
    default:
      return null;
  }
}

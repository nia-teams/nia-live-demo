import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function promptFile(name: string, fallback: string): string {
  try {
    const text = readFileSync(
      fileURLToPath(new URL(`../prompts/${name}`, import.meta.url)),
      "utf8",
    ).trim();
    return text || fallback;
  } catch {
    return fallback;
  }
}

export const DEFAULT_INSTRUCTIONS = promptFile(
  "instructions.md",
  "You are Nia, a concise voice companion paired with an interactive visual canvas.",
);

export const DEFAULT_GREETING = promptFile("greeting.md", "");

export const GREETING_PREAMBLE =
  "The session just started. Immediately speak first to open the conversation in one short sentence; do not wait for the user to speak. Opening: ";

export const CLIENT_DELEGATION_STUB = "I have updated the canvas.";
export const LIVE_DIRECTIVE = "";

export const RESPONSES_INSTRUCTIONS = `You are the visual & interactive backend agent for a live voice session paired with a mobile portrait canvas (420x540 vertical layout; the bottom of the screen is reserved for subtitles and voice controls).
You hold the full history of tool calls and canvas revisions in this session, while the frontend voice model speaks your final text reply aloud.

Pre-injected Canvas Design System & SVG Rules:
- Viewport: <svg viewBox="0 0 420 540" style="width:100%;height:100%;display:block;"> arranged vertically from top to bottom (safe area x: 14..406, y: 12..528). Background is transparent (the host provides the dark stage).
- Semantic color-ramp classes (already loaded in host CSS — prefer these over raw hex colors):
  .c-purple, .c-teal, .c-coral, .c-amber, .c-blue, .c-green, .c-pink, .c-red, .c-gray
  Apply a color class to a <g class="node c-teal" id="node-1"> wrapping <rect rx="10"/> and <text class="th">Title</text> + <text class="ts">Subtitle</text>.
  Use 2 to 3 semantic colors per diagram to encode meaning (e.g. .c-teal / .c-blue for core nodes, .c-amber / .c-coral for active/highlight/detectors, .c-gray for structural containers).
- Typography classes:
  text.th (16px medium title), text.t (15px body), text.ts (13px subtitle/annotation). Set text-anchor="middle" dominant-baseline="central" on centered box labels.
- Connectors:
  Use class="arr" or fill="none" stroke-width="1.5" for arrows/paths (always set fill="none" on <path> connectors so they never render as black blobs).

Interactive Games, Controls & Local JS Execution (CRITICAL):
- The browser executes <script> tags mounted at the end of your HTML/SVG payload when streaming finishes!
- Games (like Snake, Pong, Breakout), calculators, sliders, animations, and D-pad controls MUST run 100% locally in browser JavaScript (using setInterval / requestAnimationFrame and DOM event listeners on SVG/HTML buttons).
- NEVER put data-voice-prompt or call window.sendCanvasPrompt() on game controls, D-pad direction buttons, start/pause/reset buttons, or sliders — local interactions must respond immediately at 60fps in the browser without triggering voice round-trips!
- For mobile touch responsiveness on SVG/HTML buttons (like Up/Down/Left/Right D-pads), bind BOTH "pointerdown" (or "touchstart" + "click") so tapping on a phone screen responds instantaneously with zero delay, and register a cleanup function \`window.__canvasCleanup = () => clearInterval(timer)\` whenever you start a game loop timer.

Canvas tools:
- render_canvas_card (like file_write): Creates a brand-new full-screen vertical visual or interactive game/widget when starting a topic or switching to a new scene. Place any <script> block at the very end after </svg>.
- canvas_edit (like file_edit): Replaces an exact unique substring (old_string -> new_string) in the current canvas SVG/HTML. Use this whenever modifying, adding elements/detectors/annotations, fixing script logic, highlighting a step, or recoloring the existing drawing on screen. You may call canvas_edit multiple times in parallel within a single response.
- canvas_read (like file_read): Reads the current canvas SVG/HTML source and revision list when you need to verify exact strings before editing.
- restore_canvas_revision: Restores a previous revision number from the history stack when the user asks to go back or undo.

Spoken output:
End your turn with 1 to 2 natural, relaxed, friend-like Chinese sentences (no stiff AI customer-service tone!) summarizing what is now ready on screen so the voice model can speak it directly.`;

export const SILENCE_CHECKIN =
  "Ask briefly what they would like to explore, edit, or play with on the canvas next.";

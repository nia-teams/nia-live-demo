/**
 * The tool registry — 1:1 replica of Nia Teams' file_write / file_edit / file_read
 * semantics adapted for the live full-screen canvas, plus revision rollback.
 */

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  required: string[];
  keys: string[];
}

export const TOOLS: ToolDef[] = [
  {
    name: "render_canvas_card",
    description:
      "Write content to the full-screen live visual canvas, overwriting existing content (like file_write). Use this when creating a brand-new visual or switching topics.",
    parameters: {
      html: {
        type: "string",
        description:
          "Self-contained <svg viewBox=\"0 0 420 540\" style=\"width:100%;height:100%;display:block;\">...</svg> designed for the upper portrait canvas area (420x540 layout, stacked top-to-bottom, ordered from background to foreground shapes).",
      },
      title: {
        type: "string",
        description:
          "Optional short title for the revision history stack (e.g. '23x32 Multiplication').",
      },
    },
    required: ["html"],
    keys: ["html", "title"],
  },
  {
    name: "canvas_edit",
    description:
      "Find and replace a unique string in the current on-screen canvas SVG/HTML (like file_edit). The old_string must appear exactly once in the current canvas. Always prefer canvas_edit when updating a step, highlighting, changing colors/numbers/text, or adding elements to the current drawing.",
    parameters: {
      old_string: {
        type: "string",
        description:
          "The exact text to find in the current canvas SVG/HTML (must be unique in the canvas). Include enough surrounding tag context if needed.",
      },
      new_string: {
        type: "string",
        description: "The replacement SVG/HTML text.",
      },
      title: {
        type: "string",
        description: "Optional short label for this edit in the revision history stack.",
      },
    },
    required: ["old_string", "new_string"],
    keys: ["old_string", "new_string", "title"],
  },
  {
    name: "canvas_read",
    description:
      "Read the current on-screen canvas SVG/HTML source code (like file_read). Supports optional line offset and limit for reading specific ranges.",
    parameters: {
      offset: {
        type: "integer",
        description: "1-based line number to start reading from.",
      },
      limit: {
        type: "integer",
        description: "Maximum number of lines to read.",
      },
    },
    required: [],
    keys: ["offset", "limit"],
  },
  {
    name: "restore_canvas_revision",
    description:
      "Restore the canvas to a previous revision from the history stack when the user asks to go back or undo.",
    parameters: {
      revision: {
        type: "integer",
        description: "The revision number (1, 2, ...) to restore.",
      },
    },
    required: ["revision"],
    keys: ["revision"],
  },
];

export function toolSchemas(): Record<string, unknown>[] {
  return TOOLS.map((def) => ({
    type: "function",
    name: def.name,
    description: def.description,
    parameters: {
      type: "object",
      properties: def.parameters,
      required: def.required,
      additionalProperties: false,
    },
  }));
}

export function inferToolName(args: Record<string, unknown>): string | null {
  if (args.html !== undefined) return "render_canvas_card";
  if (args.old_string !== undefined && args.new_string !== undefined)
    return "canvas_edit";
  if (args.revision !== undefined) return "restore_canvas_revision";
  return null;
}

/** Wire protocol shared by the browser and Node orchestrator. */

export interface CanvasCardProps {
  title: string;
  subtitle?: string;
  srcDoc: string;
}

export interface CanvasStreamProps {
  html: string;
  styles?: string;
  done: boolean;
  revision?: number;
  title?: string;
  action?: "write" | "edit" | "restore" | "stream";
}

export type UiMessage =
  | { widget: "canvas_card"; props: CanvasCardProps }
  | { widget: "canvas_stream"; props: CanvasStreamProps };

export type Widget = UiMessage["widget"];

export interface Turn {
  id: string;
  role: "user" | "assistant";
  text: string;
  done: boolean;
}

export type ServerMessage =
  | { type: "ready" }
  | ({ type: "turn" } & Turn)
  | ({ type: "ui" } & UiMessage)
  | { type: "agent_activity"; activity: string | null }
  | { type: "interrupted" }
  | { type: "error"; message: string };

export type ClientMessage =
  | { type: "mic_audio"; audio: string }
  | { type: "canvas_interact"; text: string }
  | { type: "stop" };

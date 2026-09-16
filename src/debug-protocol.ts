export const DEBUG_COMMAND_INDEX = 0;
export const DEBUG_EPOCH_INDEX = 1;
export const DEBUG_WATCH_LENGTH_INDEX = 2;
export const DEBUG_WATCH_REQUEST_ID_INDEX = 3;
export const DEBUG_CONTROL_LENGTH = 4;

export const DEBUG_COMMAND_CONTINUE = 0;
export const DEBUG_COMMAND_STEP = 1;
export const DEBUG_COMMAND_RUN_TO_COMPLETION = 2;
export const DEBUG_COMMAND_WATCH = 3;

export type DebugCommand = "continue" | "run-to-completion" | "step";

/** A source range where the generated executor can synchronously pause. */
export interface BreakpointLocation {
  id: number;
  /** One-based, matching CodeMirror's displayed line number. */
  line: number;
  /** Zero-based, matching CodeMirror's character offset. */
  column: number;
  endLine: number;
  endColumn: number;
}

export interface DebugPausedMessage {
  type: "debug-paused";
  breakpointId: number;
  reason: "breakpoint" | "step";
  stack?: string;
}

export interface DebugWatchResultMessage {
  type: "debug-watch-result";
  requestId: number;
  expression: string;
  result?: string;
  error?: string;
}

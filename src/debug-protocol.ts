export const DEBUG_COMMAND_INDEX = 0;
export const DEBUG_EPOCH_INDEX = 1;
export const DEBUG_WATCH_LENGTH_INDEX = 2;
export const DEBUG_WATCH_REQUEST_ID_INDEX = 3;
export const DEBUG_WATCH_ID_INDEX = 4;
export const DEBUG_CONTROL_LENGTH = 5;

export const DEBUG_COMMAND_CONTINUE = 0;
export const DEBUG_COMMAND_STEP = 1;
export const DEBUG_COMMAND_RUN_TO_COMPLETION = 2;
export const DEBUG_COMMAND_WATCH = 3;
export const DEBUG_COMMAND_WATCH_EXPAND = 4;
export const DEBUG_COMMAND_HOVER = 5;

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

/** A serializable, shallow preview of a watched JavaScript value. */
export type DebugWatchValue =
  | {
      type: "primitive" | "function" | "promise" | "getter" | "circular";
      label: string;
      expandable?: false;
    }
  | {
      type: "array" | "object";
      label: string;
      expandable: true;
      /** Present only when this node's direct properties have been loaded. */
      children?: DebugWatchProperty[];
      /** More direct properties are available after this bounded preview. */
      hasMore?: boolean;
    };

export interface DebugWatchProperty {
  key: string;
  value: DebugWatchValue;
}

export interface DebugWatchResultMessage {
  type: "debug-watch-result";
  requestId: number;
  watchId: number;
  /** Empty for an initial expression evaluation, otherwise identifies a child. */
  path: string[];
  value?: DebugWatchValue;
  error?: string;
}

/** A compact, one-shot value preview for an identifier under the pointer. */
export interface DebugHoverResultMessage {
  type: "debug-hover-result";
  requestId: number;
  expression: string;
  result?: string;
  error?: string;
  notInScope?: boolean;
}

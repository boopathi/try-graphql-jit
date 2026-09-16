import {
  DEBUG_COMMAND_INDEX,
  DEBUG_COMMAND_RUN_TO_COMPLETION,
  DEBUG_COMMAND_STEP,
  DEBUG_COMMAND_WATCH,
  DEBUG_EPOCH_INDEX,
  DEBUG_WATCH_LENGTH_INDEX,
  DEBUG_WATCH_REQUEST_ID_INDEX,
  type DebugPausedMessage,
  type DebugWatchResultMessage,
} from "./debug-protocol";

type WatchEvaluator = (expression: string) => unknown;
type StackProvider = () => string | undefined;

/** Runs inside the JIT Worker and synchronously blocks at instrumented lines. */
export class DebugController {
  private breakpointIds = new Set<number>();
  private control: Int32Array | undefined;
  private watchBuffer: Uint8Array | undefined;
  private pausedDuration = 0;
  private shouldPauseAtNextCheckpoint = false;
  private shouldSkipBreakpoints = false;
  private readonly decoder = new TextDecoder();

  connect(controlBuffer: SharedArrayBuffer, watchBuffer: SharedArrayBuffer) {
    this.control = new Int32Array(controlBuffer);
    this.watchBuffer = new Uint8Array(watchBuffer);
  }

  configure(breakpointIds: number[]) {
    this.breakpointIds = new Set(breakpointIds);
    this.pausedDuration = 0;
    this.shouldPauseAtNextCheckpoint = false;
    this.shouldSkipBreakpoints = false;
  }

  getPausedDuration() {
    return this.pausedDuration;
  }

  checkpoint(
    breakpointId: number,
    evaluateWatch: WatchEvaluator,
    getStack?: StackProvider,
  ) {
    const reason = this.shouldPauseAtNextCheckpoint
      ? "step"
      : !this.shouldSkipBreakpoints && this.breakpointIds.has(breakpointId)
        ? "breakpoint"
        : undefined;

    if (!reason || !this.control) return;

    this.shouldPauseAtNextCheckpoint = false;
    let epoch = Atomics.load(this.control, DEBUG_EPOCH_INDEX);
    const message: DebugPausedMessage = {
      type: "debug-paused",
      breakpointId,
      reason,
      stack: getStack?.(),
    };
    self.postMessage(message);

    const pauseStart = performance.now();
    while (true) {
      Atomics.wait(this.control, DEBUG_EPOCH_INDEX, epoch);
      const observedEpoch = Atomics.load(this.control, DEBUG_EPOCH_INDEX);
      if (observedEpoch === epoch) continue;

      epoch = observedEpoch;
      const command = Atomics.load(this.control, DEBUG_COMMAND_INDEX);

      if (command === DEBUG_COMMAND_WATCH) {
        this.evaluateWatch(evaluateWatch);
        continue;
      }

      break;
    }
    this.pausedDuration += performance.now() - pauseStart;

    const command = Atomics.load(this.control, DEBUG_COMMAND_INDEX);
    this.shouldPauseAtNextCheckpoint = command === DEBUG_COMMAND_STEP;
    this.shouldSkipBreakpoints = command === DEBUG_COMMAND_RUN_TO_COMPLETION;
  }

  private evaluateWatch(evaluate: WatchEvaluator) {
    if (!this.control || !this.watchBuffer) return;

    const requestId = Atomics.load(this.control, DEBUG_WATCH_REQUEST_ID_INDEX);
    const expressionLength = Atomics.load(
      this.control,
      DEBUG_WATCH_LENGTH_INDEX,
    );
    let expression = "";

    try {
      expression = this.readWatchExpression(expressionLength);
      const message: DebugWatchResultMessage = {
        type: "debug-watch-result",
        requestId,
        expression,
        result: formatWatchValue(evaluate(expression)),
      };
      self.postMessage(message);
    } catch (error) {
      const message: DebugWatchResultMessage = {
        type: "debug-watch-result",
        requestId,
        expression,
        error: formatWatchError(error),
      };
      self.postMessage(message);
    }
  }

  private readWatchExpression(length: number) {
    if (
      !this.watchBuffer ||
      length < 0 ||
      length > this.watchBuffer.byteLength
    ) {
      throw new Error("The watch expression could not be read.");
    }

    // Chrome's TextDecoder does not decode views backed by SharedArrayBuffer.
    const source = new Uint8Array(length);
    source.set(this.watchBuffer.subarray(0, length));
    return this.decoder.decode(source);
  }
}

function formatWatchError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatWatchValue(value: unknown): string {
  try {
    return previewWatchValue(value, new WeakSet(), 0);
  } catch {
    return "[Value preview unavailable]";
  }
}

function previewWatchValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "undefined":
    case "boolean":
    case "number":
    case "bigint":
      return String(value);
    case "symbol":
      return value.toString();
    case "function":
      return `[Function${value.name ? ` ${value.name}` : ""}]`;
    case "object":
      break;
  }

  if (value instanceof Promise) return "Promise { <pending> }";
  if (seen.has(value)) return "[Circular]";
  if (depth >= 2) return Array.isArray(value) ? "[…]" : "{…}";

  seen.add(value);
  if (Array.isArray(value)) {
    const preview = value
      .slice(0, 6)
      .map((item) => previewWatchValue(item, seen, depth + 1));
    if (value.length > preview.length) preview.push("…");
    return `[${preview.join(", ")}]`;
  }

  const properties = Object.entries(Object.getOwnPropertyDescriptors(value));
  const preview = properties.slice(0, 6).map(([key, descriptor]) => {
    const propertyValue =
      "value" in descriptor
        ? previewWatchValue(descriptor.value, seen, depth + 1)
        : "[Getter]";
    return `${key}: ${propertyValue}`;
  });
  if (properties.length > preview.length) preview.push("…");
  return `{ ${preview.join(", ")} }`;
}

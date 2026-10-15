import {
  DEBUG_COMMAND_INDEX,
  DEBUG_COMMAND_RUN_TO_COMPLETION,
  DEBUG_COMMAND_STEP,
  DEBUG_COMMAND_HOVER,
  DEBUG_COMMAND_WATCH,
  DEBUG_COMMAND_WATCH_EXPAND,
  DEBUG_EPOCH_INDEX,
  DEBUG_WATCH_ID_INDEX,
  DEBUG_WATCH_LENGTH_INDEX,
  DEBUG_WATCH_REQUEST_ID_INDEX,
  type DebugPausedMessage,
  type DebugHoverResultMessage,
  type DebugWatchProperty,
  type DebugWatchResultMessage,
  type DebugWatchValue,
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
  /** Values retain their identity only for the current synchronous pause. */
  private readonly watchValues = new Map<number, unknown>();

  connect(controlBuffer: SharedArrayBuffer, watchBuffer: SharedArrayBuffer) {
    this.control = new Int32Array(controlBuffer);
    this.watchBuffer = new Uint8Array(watchBuffer);
  }

  configure(breakpointIds: number[]) {
    this.breakpointIds = new Set(breakpointIds);
    this.pausedDuration = 0;
    this.shouldPauseAtNextCheckpoint = false;
    this.shouldSkipBreakpoints = false;
    this.watchValues.clear();
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
    this.watchValues.clear();
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

      if (command === DEBUG_COMMAND_WATCH_EXPAND) {
        this.expandWatch();
        continue;
      }

      if (command === DEBUG_COMMAND_HOVER) {
        this.evaluateHover(evaluateWatch);
        continue;
      }

      break;
    }
    this.pausedDuration += performance.now() - pauseStart;

    const command = Atomics.load(this.control, DEBUG_COMMAND_INDEX);
    this.shouldPauseAtNextCheckpoint = command === DEBUG_COMMAND_STEP;
    this.shouldSkipBreakpoints = command === DEBUG_COMMAND_RUN_TO_COMPLETION;
    this.watchValues.clear();
  }

  private evaluateWatch(evaluate: WatchEvaluator) {
    if (!this.control || !this.watchBuffer) return;

    const requestId = Atomics.load(this.control, DEBUG_WATCH_REQUEST_ID_INDEX);
    const watchId = Atomics.load(this.control, DEBUG_WATCH_ID_INDEX);
    const expressionLength = Atomics.load(
      this.control,
      DEBUG_WATCH_LENGTH_INDEX,
    );
    let expression = "";

    try {
      expression = this.readWatchExpression(expressionLength);
      const watchedValue = evaluate(expression);
      this.watchValues.set(watchId, watchedValue);
      const message: DebugWatchResultMessage = {
        type: "debug-watch-result",
        requestId,
        watchId,
        path: [],
        value: snapshotWatchValue(watchedValue, new Set(), true, 0),
      };
      self.postMessage(message);
    } catch (error) {
      const message: DebugWatchResultMessage = {
        type: "debug-watch-result",
        requestId,
        watchId,
        path: [],
        error: formatWatchError(error),
      };
      self.postMessage(message);
    }
  }

  private expandWatch() {
    if (!this.control) return;

    const requestId = Atomics.load(this.control, DEBUG_WATCH_REQUEST_ID_INDEX);
    const watchId = Atomics.load(this.control, DEBUG_WATCH_ID_INDEX);
    let path: string[] = [];

    try {
      const request = JSON.parse(
        this.readWatchExpression(
          Atomics.load(this.control, DEBUG_WATCH_LENGTH_INDEX),
        ),
      ) as unknown;
      const watchedValue = this.watchValues.get(watchId);
      if (!this.watchValues.has(watchId)) {
        throw new Error(
          "This watch is no longer available at the current pause.",
        );
      }

      const { path: requestedPath, offset } = readWatchRequest(
        request,
        watchId,
      );
      path = requestedPath;
      const { value, ancestors } = getWatchValueAtPath(watchedValue, path);
      const message: DebugWatchResultMessage = {
        type: "debug-watch-result",
        requestId,
        watchId,
        path,
        value: snapshotWatchValue(value, ancestors, true, offset),
      };
      self.postMessage(message);
    } catch (error) {
      const message: DebugWatchResultMessage = {
        type: "debug-watch-result",
        requestId,
        watchId,
        path,
        error: formatWatchError(error),
      };
      self.postMessage(message);
    }
  }

  private evaluateHover(evaluate: WatchEvaluator) {
    if (!this.control || !this.watchBuffer) return;

    const requestId = Atomics.load(this.control, DEBUG_WATCH_REQUEST_ID_INDEX);
    let expression = "";
    try {
      expression = this.readWatchExpression(
        Atomics.load(this.control, DEBUG_WATCH_LENGTH_INDEX),
      );
      const message: DebugHoverResultMessage = {
        type: "debug-hover-result",
        requestId,
        expression,
        result: formatHoverValue(evaluate(expression)),
      };
      self.postMessage(message);
    } catch (error) {
      const message: DebugHoverResultMessage = {
        type: "debug-hover-result",
        requestId,
        expression,
        error: formatWatchError(error),
        notInScope: error instanceof ReferenceError,
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

const WATCH_PROPERTY_PAGE_SIZE = 32;
const HOVER_PROPERTY_LIMIT = 3;

function formatHoverValue(value: unknown) {
  try {
    return previewHoverValue(value, new Set(), true);
  } catch {
    return "[Preview unavailable]";
  }
}

function previewHoverValue(
  value: unknown,
  seen: Set<object>,
  includeProperties: boolean,
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
  if (!includeProperties) return Array.isArray(value) ? "Array" : "Object";

  const nextSeen = new Set(seen);
  nextSeen.add(value);
  if (Array.isArray(value)) {
    const preview: string[] = [];
    const previewLength = Math.min(value.length, HOVER_PROPERTY_LIMIT);
    for (let index = 0; index < previewLength; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      preview.push(
        descriptor && "value" in descriptor
          ? previewHoverValue(descriptor.value, nextSeen, false)
          : "<empty>",
      );
    }
    if (value.length > previewLength) preview.push("…");
    return `[${preview.join(", ")}]`;
  }

  const keys = getEnumerableOwnPropertyKeys(value, HOVER_PROPERTY_LIMIT + 1);
  const preview = keys.slice(0, HOVER_PROPERTY_LIMIT).map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    const propertyValue =
      "value" in descriptor
        ? previewHoverValue(descriptor.value, nextSeen, false)
        : "[Getter]";
    return `${key}: ${propertyValue}`;
  });
  if (keys.length > preview.length) preview.push("…");
  return `{ ${preview.join(", ")} }`;
}

function snapshotWatchValue(
  value: unknown,
  ancestors: Set<object>,
  includeChildren: boolean,
  propertyOffset: number,
): DebugWatchValue {
  if (value === null) return { type: "primitive", label: "null" };

  switch (typeof value) {
    case "string":
      return { type: "primitive", label: JSON.stringify(value) };
    case "undefined":
    case "boolean":
    case "number":
    case "bigint":
      return { type: "primitive", label: String(value) };
    case "symbol":
      return { type: "primitive", label: value.toString() };
    case "function":
    case "object":
      break;
  }

  if (value instanceof Promise) {
    return { type: "promise", label: "Promise { <pending> }" };
  }
  if (ancestors.has(value)) return { type: "circular", label: "[Circular]" };

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  const isArray = Array.isArray(value);
  const isFunction = typeof value === "function";
  const snapshot: Extract<DebugWatchValue, { expandable: true }> = {
    type: isArray ? "array" : "object",
    label: isFunction
      ? `[Function${value.name ? ` ${value.name}` : ""}]`
      : isArray
        ? `Array(${value.length})`
        : "Object",
    expandable: true,
  };
  if (includeChildren) {
    const { children, hasMore } = snapshotWatchProperties(
      value,
      nextAncestors,
      propertyOffset,
    );
    snapshot.children = children;
    snapshot.hasMore = hasMore;
  }
  return snapshot;
}

function snapshotWatchProperties(
  value: object,
  ancestors: Set<object>,
  propertyOffset: number,
) {
  // Descriptors let us show fields without accidentally evaluating user getters.
  const nextPropertyOffset = propertyOffset + WATCH_PROPERTY_PAGE_SIZE;
  const keys = getEnumerableOwnPropertyKeys(value, nextPropertyOffset + 1);
  const hasMore = keys.length > nextPropertyOffset;
  const children: DebugWatchProperty[] = keys
    .slice(propertyOffset, nextPropertyOffset)
    .map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      return {
        key,
        value:
          "value" in descriptor
            ? snapshotWatchValue(descriptor.value, ancestors, false, 0)
            : {
                type: "getter",
                label:
                  descriptor.get && descriptor.set
                    ? "[Getter/Setter]"
                    : descriptor.get
                      ? "[Getter]"
                      : "[Setter]",
              },
      };
    });
  return { children, hasMore };
}

function getEnumerableOwnPropertyKeys(value: object, limit: number) {
  const keys: string[] = [];
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;

    keys.push(key);
    if (keys.length === limit) break;
  }
  return keys;
}

function readWatchRequest(request: unknown, watchId: number) {
  if (
    typeof request !== "object" ||
    request === null ||
    (request as { watchId?: unknown }).watchId !== watchId ||
    !Array.isArray((request as { path?: unknown }).path) ||
    !(request as { path: unknown[] }).path.every(
      (segment) => typeof segment === "string",
    ) ||
    !Number.isSafeInteger((request as { offset?: unknown }).offset) ||
    (request as { offset: number }).offset < 0
  ) {
    throw new Error("The watch expansion request could not be read.");
  }

  return request as { path: string[]; offset: number };
}

function getWatchValueAtPath(value: unknown, path: string[]) {
  let current = value;
  const ancestors = new Set<object>();

  for (const segment of path) {
    if (
      (typeof current !== "object" && typeof current !== "function") ||
      current === null
    ) {
      throw new Error("This watch value cannot be expanded.");
    }
    ancestors.add(current);
    const descriptor = Object.getOwnPropertyDescriptor(current, segment);
    if (!descriptor) {
      throw new Error("This property is no longer available.");
    }
    if (!("value" in descriptor)) {
      throw new Error("Getters are not evaluated by the watch inspector.");
    }
    current = descriptor.value;
  }

  return { value: current, ancestors };
}

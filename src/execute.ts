import PromiseWorker from "./promise-worker";
import { supportsGraphqlJitDebugging } from "./graphql-jit-version";
import {
  DEBUG_COMMAND_CONTINUE,
  DEBUG_COMMAND_INDEX,
  DEBUG_COMMAND_RUN_TO_COMPLETION,
  DEBUG_COMMAND_STEP,
  DEBUG_COMMAND_HOVER,
  DEBUG_COMMAND_WATCH,
  DEBUG_COMMAND_WATCH_EXPAND,
  DEBUG_CONTROL_LENGTH,
  DEBUG_EPOCH_INDEX,
  DEBUG_WATCH_ID_INDEX,
  DEBUG_WATCH_LENGTH_INDEX,
  DEBUG_WATCH_REQUEST_ID_INDEX,
  type DebugCommand,
  type DebugHoverResultMessage,
  type DebugPausedMessage,
  type DebugWatchResultMessage,
  type BreakpointLocation,
} from "./debug-protocol";

let {
  rawWorker,
  worker,
  debugControl,
  debugWatchBuffer,
}: {
  rawWorker?: Worker;
  worker?: PromiseWorker;
  debugControl?: Int32Array;
  debugWatchBuffer?: SharedArrayBuffer;
} = {};
const debugPauseListeners = new Set<(message: DebugPausedMessage) => void>();
const debugWatchResultListeners = new Set<
  (message: DebugWatchResultMessage) => void
>();
const debugHoverResultListeners = new Set<
  (message: DebugHoverResultMessage) => void
>();
const watchExpressionEncoder = new TextEncoder();
let nextWatchRequestId = 0;
let debugWatchCommandQueue = Promise.resolve();
let debugWatchCommandGeneration = 0;
let cancelActiveDebugWatchRequest: (() => void) | undefined;

// Create the Worker ahead of the first compilation so its startup cost does not
// affect the compile/run interaction.
window.addEventListener("load", () => {
  if (!worker) {
    ({ rawWorker, worker, debugControl, debugWatchBuffer } = createWorker());
  }
});

interface CompileReply {
  compiledQuery: string;
  ready: boolean;
  breakpoints: BreakpointLocation[];
}

interface RunReply {
  executionResult: string;
}

export function compileQuery(
  schema: string,
  resolvers: string,
  query: string,
): Promise<CompileReply> {
  return getWorker().postMessage({
    type: "compile",
    schema,
    resolvers,
    query,
  });
}

export function runCompiledQuery(breakpointIds: number[]): Promise<RunReply> {
  return new Promise((resolve, reject) => {
    let isCancelled = false;
    let isFulfilled = false;

    // Preserve the existing runaway-resolver guard after the first execution.
    // The Worker is recreated on timeout, which also clears its cached compile.
    const timeout =
      isFirstRun || breakpointIds.length > 0
        ? undefined
        : window.setTimeout(() => {
            if (!isFulfilled) {
              isCancelled = true;
              rawWorker?.terminate();
              ({ rawWorker, worker, debugControl, debugWatchBuffer } =
                createWorker());
              reject(
                new Error(
                  "Took too long to execute. Check your resolvers for infinite loops or long tasks.",
                ),
              );
            }
          }, 1000);

    isFirstRun = false;

    getWorker()
      .postMessage<RunReply>({ type: "run", breakpointIds })
      .then((reply) => {
        if (!isCancelled) {
          isFulfilled = true;
          clearTimeoutIfNeeded(timeout);
          resolve(reply);
        }
      })
      .catch((e) => {
        if (!isCancelled) {
          isFulfilled = true;
          clearTimeoutIfNeeded(timeout);
          reject(e);
        }
      });
  });
}

export function onDebugPause(listener: (message: DebugPausedMessage) => void) {
  debugPauseListeners.add(listener);
  return () => debugPauseListeners.delete(listener);
}

export function evaluateDebugWatch(expression: string, watchId: number) {
  return requestDebugWatch(DEBUG_COMMAND_WATCH, expression, watchId);
}

export function expandDebugWatch(watchId: number, path: string[], offset = 0) {
  return requestDebugWatch(
    DEBUG_COMMAND_WATCH_EXPAND,
    JSON.stringify({ watchId, path, offset }),
    watchId,
  );
}

export function evaluateDebugHover(expression: string) {
  if (!supportsGraphqlJitDebugging) {
    return Promise.reject(
      new Error(
        "Identifier inspection requires graphql-jit 0.8.9-canary or newer.",
      ),
    );
  }

  if (!debugControl || !debugWatchBuffer) {
    return Promise.reject(
      new Error(
        "Identifier inspection is unavailable until execution is paused.",
      ),
    );
  }

  const bytes = watchExpressionEncoder.encode(expression);
  if (bytes.byteLength > debugWatchBuffer.byteLength) {
    return Promise.reject(new Error("Identifier is too long to inspect."));
  }

  const commandGeneration = debugWatchCommandGeneration;
  const request = debugWatchCommandQueue.then(() => {
    if (commandGeneration !== debugWatchCommandGeneration) {
      throw new Error(
        "Identifier inspection was cancelled when execution resumed.",
      );
    }
    return dispatchDebugHoverCommand(bytes, expression);
  });
  debugWatchCommandQueue = request.then(
    () => undefined,
    () => undefined,
  );
  return request;
}

function requestDebugWatch(
  command: typeof DEBUG_COMMAND_WATCH | typeof DEBUG_COMMAND_WATCH_EXPAND,
  source: string,
  watchId: number,
) {
  if (!supportsGraphqlJitDebugging) {
    return Promise.reject(
      new Error("Watch expressions require graphql-jit 0.8.9-canary or newer."),
    );
  }

  if (!debugControl || !debugWatchBuffer) {
    return Promise.reject(
      new Error("Watch evaluation is unavailable until execution is paused."),
    );
  }

  const bytes = watchExpressionEncoder.encode(source);
  if (bytes.byteLength > debugWatchBuffer.byteLength) {
    return Promise.reject(
      new Error("Watch expressions must be 16 KB or shorter."),
    );
  }

  // The shared request buffer has room for one message. Serializing commands
  // means a user can expand a value while other initial watches are loading.
  const commandGeneration = debugWatchCommandGeneration;
  const request = debugWatchCommandQueue.then(() => {
    if (commandGeneration !== debugWatchCommandGeneration) {
      throw new Error("Watch evaluation was cancelled when execution resumed.");
    }
    return dispatchDebugWatchCommand(command, bytes, watchId);
  });
  debugWatchCommandQueue = request.then(
    () => undefined,
    () => undefined,
  );
  return request;
}

function dispatchDebugWatchCommand(
  command: typeof DEBUG_COMMAND_WATCH | typeof DEBUG_COMMAND_WATCH_EXPAND,
  bytes: Uint8Array,
  watchId: number,
) {
  const requestId = ++nextWatchRequestId;
  return new Promise<DebugWatchResultMessage>((resolve, reject) => {
    const unsubscribe = onDebugWatchResult((message) => {
      if (message.requestId !== requestId || message.watchId !== watchId)
        return;

      cancelActiveDebugWatchRequest = undefined;
      unsubscribe();
      resolve(message);
    });
    cancelActiveDebugWatchRequest = () => {
      cancelActiveDebugWatchRequest = undefined;
      unsubscribe();
      reject(
        new Error("Watch evaluation was cancelled when execution resumed."),
      );
    };

    new Uint8Array(debugWatchBuffer!).set(bytes);
    Atomics.store(debugControl!, DEBUG_WATCH_LENGTH_INDEX, bytes.byteLength);
    Atomics.store(debugControl!, DEBUG_WATCH_REQUEST_ID_INDEX, requestId);
    Atomics.store(debugControl!, DEBUG_WATCH_ID_INDEX, watchId);
    Atomics.store(debugControl!, DEBUG_COMMAND_INDEX, command);
    Atomics.add(debugControl!, DEBUG_EPOCH_INDEX, 1);
    Atomics.notify(debugControl!, DEBUG_EPOCH_INDEX, 1);
  });
}

function dispatchDebugHoverCommand(bytes: Uint8Array, expression: string) {
  const requestId = ++nextWatchRequestId;
  return new Promise<DebugHoverResultMessage>((resolve, reject) => {
    const unsubscribe = onDebugHoverResult((message) => {
      if (
        message.requestId !== requestId ||
        message.expression !== expression
      ) {
        return;
      }

      cancelActiveDebugWatchRequest = undefined;
      unsubscribe();
      resolve(message);
    });
    cancelActiveDebugWatchRequest = () => {
      cancelActiveDebugWatchRequest = undefined;
      unsubscribe();
      reject(
        new Error(
          "Identifier inspection was cancelled when execution resumed.",
        ),
      );
    };

    new Uint8Array(debugWatchBuffer!).set(bytes);
    Atomics.store(debugControl!, DEBUG_WATCH_LENGTH_INDEX, bytes.byteLength);
    Atomics.store(debugControl!, DEBUG_WATCH_REQUEST_ID_INDEX, requestId);
    Atomics.store(debugControl!, DEBUG_COMMAND_INDEX, DEBUG_COMMAND_HOVER);
    Atomics.add(debugControl!, DEBUG_EPOCH_INDEX, 1);
    Atomics.notify(debugControl!, DEBUG_EPOCH_INDEX, 1);
  });
}

export function onDebugWatchResult(
  listener: (message: DebugWatchResultMessage) => void,
) {
  debugWatchResultListeners.add(listener);
  return () => debugWatchResultListeners.delete(listener);
}

export function onDebugHoverResult(
  listener: (message: DebugHoverResultMessage) => void,
) {
  debugHoverResultListeners.add(listener);
  return () => debugHoverResultListeners.delete(listener);
}

export function resumeDebug(command: DebugCommand) {
  if (!supportsGraphqlJitDebugging || !debugControl) return;

  debugWatchCommandGeneration += 1;
  cancelActiveDebugWatchRequest?.();
  Atomics.store(
    debugControl,
    DEBUG_COMMAND_INDEX,
    command === "step"
      ? DEBUG_COMMAND_STEP
      : command === "run-to-completion"
        ? DEBUG_COMMAND_RUN_TO_COMPLETION
        : DEBUG_COMMAND_CONTINUE,
  );
  Atomics.add(debugControl, DEBUG_EPOCH_INDEX, 1);
  Atomics.notify(debugControl, DEBUG_EPOCH_INDEX, 1);
}

let isFirstRun = true;

function getWorker() {
  if (!worker) {
    ({ rawWorker, worker, debugControl, debugWatchBuffer } = createWorker());
  }

  return worker;
}

function clearTimeoutIfNeeded(timeout: number | undefined) {
  if (timeout !== undefined) {
    window.clearTimeout(timeout);
  }
}

function createWorker() {
  const rawWorker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  });
  const worker = new PromiseWorker(rawWorker);
  const debugControl =
    !supportsGraphqlJitDebugging || typeof SharedArrayBuffer === "undefined"
      ? undefined
      : new Int32Array(
          new SharedArrayBuffer(
            Int32Array.BYTES_PER_ELEMENT * DEBUG_CONTROL_LENGTH,
          ),
        );
  const debugWatchBuffer =
    !supportsGraphqlJitDebugging || typeof SharedArrayBuffer === "undefined"
      ? undefined
      : new SharedArrayBuffer(16 * 1024);

  rawWorker.addEventListener("message", (event: MessageEvent) => {
    if (isDebugPausedMessage(event.data)) {
      debugPauseListeners.forEach((listener) => listener(event.data));
      return;
    }

    if (isDebugWatchResultMessage(event.data)) {
      debugWatchResultListeners.forEach((listener) => listener(event.data));
      return;
    }

    if (isDebugHoverResultMessage(event.data)) {
      debugHoverResultListeners.forEach((listener) => listener(event.data));
    }
  });

  if (debugControl && debugWatchBuffer) {
    rawWorker.postMessage({
      type: "debug-init",
      controlBuffer: debugControl.buffer,
      watchBuffer: debugWatchBuffer,
    });
  }

  return { rawWorker, worker, debugControl, debugWatchBuffer };
}

function isDebugHoverResultMessage(
  value: unknown,
): value is DebugHoverResultMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as DebugHoverResultMessage).type === "debug-hover-result" &&
    typeof (value as DebugHoverResultMessage).requestId === "number" &&
    typeof (value as DebugHoverResultMessage).expression === "string"
  );
}

function isDebugPausedMessage(value: unknown): value is DebugPausedMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as DebugPausedMessage).type === "debug-paused" &&
    typeof (value as DebugPausedMessage).breakpointId === "number" &&
    ((value as DebugPausedMessage).reason === "breakpoint" ||
      (value as DebugPausedMessage).reason === "step")
  );
}

function isDebugWatchResultMessage(
  value: unknown,
): value is DebugWatchResultMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as DebugWatchResultMessage).type === "debug-watch-result" &&
    typeof (value as DebugWatchResultMessage).requestId === "number" &&
    typeof (value as DebugWatchResultMessage).watchId === "number" &&
    Array.isArray((value as DebugWatchResultMessage).path)
  );
}

import PromiseWorker from "./promise-worker";
import { supportsGraphqlJitDebugging } from "./graphql-jit-version";
import {
  DEBUG_COMMAND_CONTINUE,
  DEBUG_COMMAND_INDEX,
  DEBUG_COMMAND_RUN_TO_COMPLETION,
  DEBUG_COMMAND_STEP,
  DEBUG_COMMAND_WATCH,
  DEBUG_CONTROL_LENGTH,
  DEBUG_EPOCH_INDEX,
  DEBUG_WATCH_LENGTH_INDEX,
  DEBUG_WATCH_REQUEST_ID_INDEX,
  type DebugCommand,
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
const watchExpressionEncoder = new TextEncoder();
let nextWatchRequestId = 0;

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

export function evaluateDebugWatch(expression: string) {
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

  const bytes = watchExpressionEncoder.encode(expression);
  if (bytes.byteLength > debugWatchBuffer.byteLength) {
    return Promise.reject(
      new Error("Watch expressions must be 16 KB or shorter."),
    );
  }

  const requestId = ++nextWatchRequestId;
  return new Promise<DebugWatchResultMessage>((resolve) => {
    const unsubscribe = onDebugWatchResult((message) => {
      if (message.requestId !== requestId) return;

      unsubscribe();
      resolve(message);
    });

    new Uint8Array(debugWatchBuffer!).set(bytes);
    Atomics.store(debugControl!, DEBUG_WATCH_LENGTH_INDEX, bytes.byteLength);
    Atomics.store(debugControl!, DEBUG_WATCH_REQUEST_ID_INDEX, requestId);
    Atomics.store(debugControl!, DEBUG_COMMAND_INDEX, DEBUG_COMMAND_WATCH);
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

export function resumeDebug(command: DebugCommand) {
  if (!supportsGraphqlJitDebugging || !debugControl) return;

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
    typeof (value as DebugWatchResultMessage).expression === "string"
  );
}

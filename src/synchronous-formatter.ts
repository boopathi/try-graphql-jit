import { instrumentGeneratedSource } from "./instrumentation";
import type { BreakpointLocation } from "./debug-protocol";

const STATUS_INDEX = 0;
const LENGTH_INDEX = 1;
const STATUS_PENDING = 0;
const STATUS_ERROR = 2;
const STATUS_TOO_LARGE = 3;
const CONTROL_LENGTH = 2;
const MIN_RESULT_BYTES = 64 * 1024;
const RESULT_SIZE_MULTIPLIER = 4;
// Vite may need to transform Prettier and its parser plugins on a first
// development load. Keep a bounded wait, but leave enough headroom for that
// one-time cold start.
const FORMAT_TIMEOUT_MS = 30_000;
const decoder = new TextDecoder();
const encoder = new TextEncoder();
let latestBreakpointLocations: BreakpointLocation[] = [];
let latestViewerSource: string | undefined;

const formatterWorker = new Worker(
  new URL("./formatter-worker.ts", import.meta.url),
  { type: "module" },
);

const formatterReady = new Promise<void>((resolve, reject) => {
  formatterWorker.addEventListener("message", (event: MessageEvent) => {
    if (event.data?.type === "ready") {
      resolve();
    }
  });
  formatterWorker.addEventListener("error", (event) => {
    reject(event.error ?? new Error(event.message));
  });
});

export async function waitForFormatter() {
  await formatterReady;

  if (!crossOriginIsolated) {
    throw new Error(
      "The debug formatter requires cross-origin isolation. Serve this app with COOP and COEP headers.",
    );
  }
}

export function formatAndInstrumentGeneratedSource(source: string): string {
  const formattedSource = formatGeneratedSource(source);

  // graphql-jit calls this formatter for its variable coercer too. That source
  // has no execution context, so only instrument the query executor.
  if (!/function\s+query\s*\(\s*__context\b/.test(formattedSource)) {
    return formattedSource;
  }

  const instrumented = instrumentGeneratedSource(formattedSource);
  latestBreakpointLocations = instrumented.breakpoints;
  latestViewerSource = formattedSource;
  return instrumented.source;
}

export function resetBreakpointLocations() {
  latestBreakpointLocations = [];
  latestViewerSource = undefined;
}

export function getBreakpointLocations() {
  return latestBreakpointLocations;
}

export function getViewerSource() {
  return latestViewerSource;
}

function formatGeneratedSource(source: string): string {
  const sourceLength = encoder.encode(source).byteLength;
  const resultCapacity = Math.max(
    MIN_RESULT_BYTES,
    sourceLength * RESULT_SIZE_MULTIPLIER,
  );
  const controlBuffer = new SharedArrayBuffer(
    Int32Array.BYTES_PER_ELEMENT * CONTROL_LENGTH,
  );
  const resultBuffer = new SharedArrayBuffer(resultCapacity);
  const control = new Int32Array(controlBuffer);

  formatterWorker.postMessage({
    type: "format",
    source,
    controlBuffer,
    resultBuffer,
  });

  const waitResult = Atomics.wait(
    control,
    STATUS_INDEX,
    STATUS_PENDING,
    FORMAT_TIMEOUT_MS,
  );
  const status = Atomics.load(control, STATUS_INDEX);
  const resultLength = Atomics.load(control, LENGTH_INDEX);

  if (waitResult === "timed-out" || status === STATUS_PENDING) {
    throw new Error("Timed out while formatting the generated query source.");
  }

  if (status === STATUS_TOO_LARGE) {
    throw new Error(
      `Formatted generated source (${resultLength} bytes) exceeds the ${resultCapacity}-byte debug buffer.`,
    );
  }

  // Chrome's TextDecoder does not accept views backed by SharedArrayBuffer.
  // Copying after the formatter has notified us also gives decoding a stable
  // non-shared snapshot.
  const resultBytes = new Uint8Array(resultLength);
  resultBytes.set(new Uint8Array(resultBuffer, 0, resultLength));
  const result = decoder.decode(resultBytes);
  if (status === STATUS_ERROR) {
    throw new Error(`Unable to format the generated query source: ${result}`);
  }

  return result;
}

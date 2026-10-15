import prettier from "prettier/standalone";
import * as parserBabel from "prettier/plugins/babel";
import * as parserEstree from "prettier/plugins/estree";

const STATUS_INDEX = 0;
const LENGTH_INDEX = 1;
const STATUS_DONE = 1;
const STATUS_ERROR = 2;
const STATUS_TOO_LARGE = 3;
const encoder = new TextEncoder();

interface FormatMessage {
  type: "format";
  source: string;
  controlBuffer: SharedArrayBuffer;
  resultBuffer: SharedArrayBuffer;
}

self.addEventListener("message", async (event: MessageEvent<FormatMessage>) => {
  if (event.data.type !== "format") return;

  const { source, controlBuffer, resultBuffer } = event.data;
  const control = new Int32Array(controlBuffer);
  const result = new Uint8Array(resultBuffer);

  try {
    const formatted = await prettier.format(source, {
      parser: "babel",
      plugins: [parserBabel, parserEstree],
      printWidth: 80,
    });
    const formattedBytes = encoder.encode(formatted);

    if (formattedBytes.byteLength > result.byteLength) {
      Atomics.store(control, LENGTH_INDEX, formattedBytes.byteLength);
      notify(control, STATUS_TOO_LARGE);
      return;
    }

    result.set(formattedBytes);
    Atomics.store(control, LENGTH_INDEX, formattedBytes.byteLength);
    notify(control, STATUS_DONE);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const messageBytes = encoder.encode(message);
    const messageLength = Math.min(messageBytes.byteLength, result.byteLength);

    result.set(messageBytes.subarray(0, messageLength));
    Atomics.store(control, LENGTH_INDEX, messageLength);
    notify(control, STATUS_ERROR);
  }
});

self.postMessage({ type: "ready" });

function notify(control: Int32Array, status: number) {
  Atomics.store(control, STATUS_INDEX, status);
  Atomics.notify(control, STATUS_INDEX, 1);
}

import PromiseWorker from "./promise-worker";

let { rawWorker, worker }: { rawWorker?: Worker; worker?: PromiseWorker } = {};

// Create the Worker ahead of the first compilation so its startup cost does not
// affect the compile/run interaction.
window.addEventListener("load", () => {
  ({ rawWorker, worker } = createWorker());
});

interface CompileReply {
  compiledQuery: string;
  ready: boolean;
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

export function runCompiledQuery(): Promise<RunReply> {
  return new Promise((resolve, reject) => {
    let isCancelled = false;
    let isFulfilled = false;

    // Preserve the existing runaway-resolver guard after the first execution.
    // The Worker is recreated on timeout, which also clears its cached compile.
    const timeout = isFirstRun
      ? undefined
      : window.setTimeout(() => {
          if (!isFulfilled) {
            isCancelled = true;
            rawWorker?.terminate();
            ({ rawWorker, worker } = createWorker());
            reject(
              new Error(
                "Took too long to execute. Check your resolvers for infinite loops or long tasks.",
              ),
            );
          }
        }, 1000);

    isFirstRun = false;

    getWorker()
      .postMessage<RunReply>({ type: "run" })
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

let isFirstRun = true;

function getWorker() {
  if (!worker) {
    ({ rawWorker, worker } = createWorker());
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
  return { rawWorker, worker };
}

import PromiseWorker from "./promise-worker";

let { rawWorker, worker }: { rawWorker?: Worker; worker?: PromiseWorker } = {};

// cold starts or creation of worker are slow
// so we remove timeout for first time execution
let isFirstTimeExecution = true;

window.addEventListener("load", () => {
  ({ rawWorker, worker } = createWorker());
});

interface Reply {
  compiledQuery: string;
  executionResult: string;
}

export async function executeQuery(
  schema: string,
  resolvers: string,
  query: string
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let isCancelled = false;
    let isFulfilled = false;

    console.log("isFirstTimeExecution", isFirstTimeExecution);

    if (!isFirstTimeExecution) {
      setTimeout(() => {
        if (!isFulfilled) {
          isCancelled = true;
          rawWorker!.terminate();
          ({ rawWorker, worker } = createWorker());
          reject(
            new Error(
              "Took too long to execute. Check your resolvers for infinte-loops / long-tasks."
            )
          );
        }
      }, 1000);
    } else {
      isFirstTimeExecution = false;
    }

    worker!
      .postMessage({
        schema,
        resolvers,
        query,
      })
      .then((reply) => {
        if (!isCancelled) {
          isFulfilled = true;
          resolve(reply);
        }
      })
      .catch((e) => {
        if (!isCancelled) {
          isFulfilled = true;
          reject(e);
        }
      });
  });
}

function createWorker() {
  const rawWorker = new Worker(new URL("./worker", import.meta.url), {
    type: "module",
  });
  const worker = new PromiseWorker(rawWorker);
  return { rawWorker, worker };
}

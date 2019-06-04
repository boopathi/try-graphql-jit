import PromiseWorker from "promise-worker";

let {
  rawWorker,
  worker
}: { rawWorker?: Worker; worker?: PromiseWorker } = createWorker();

interface Reply {
  compiledQuery: string;
  executionResult: string;
}

export async function executeQuery(
  schema: string,
  resolvers: string,
  query: string
): Promise<Reply> {
  if (rawWorker == null || worker == null) {
    ({ rawWorker, worker } = createWorker());
  }

  return new Promise((resolve, reject) => {
    let isCancelled = false;
    let isFulfilled = false;

    setTimeout(() => {
      if (!isFulfilled) {
        isCancelled = true;
        rawWorker!.terminate();
        rawWorker = undefined;
        worker = undefined;
        reject(
          new Error(
            "Took too long to execute. Check your resolvers for infinte-loops / long-tasks."
          )
        );
      }
    }, 500);

    worker!
      .postMessage({
        schema,
        resolvers,
        query
      })
      .then(reply => {
        if (!isCancelled) {
          isFulfilled = true;
          resolve(reply);
        }
      })
      .catch(e => {
        if (!isCancelled) {
          isFulfilled = true;
          reject(e);
        }
      });
  });
}

function createWorker() {
  const rawWorker = new Worker("./worker.ts");
  const worker = new PromiseWorker(rawWorker);
  return { rawWorker, worker };
}

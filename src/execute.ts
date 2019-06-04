import PromiseWorker from "promise-worker";

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
    const rawWorker = new Worker("./worker.ts");
    const worker = new PromiseWorker(rawWorker);
    let isCancelled = false;
    let isFulfilled = false;

    setTimeout(() => {
      if (!isFulfilled) {
        isCancelled = true;
        rawWorker.terminate();
        reject(new Error("Took too long to execute. Something fishy"));
      }
    }, 250);

    worker
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

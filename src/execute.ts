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
  const rawWorker = new Worker("./worker.ts");
  const worker = new PromiseWorker(rawWorker);

  return worker.postMessage({
    schema,
    resolvers,
    query
  });
}

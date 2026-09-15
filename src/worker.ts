import registerPromiseWorker from "./register-promise-worker";
import { DebugController } from "./debug-controller";
import {
  formatAndInstrumentGeneratedSource,
  getBreakpointLocations,
  getViewerSource,
  resetBreakpointLocations,
  waitForFormatter,
} from "./synchronous-formatter";
import type { BreakpointLocation } from "./debug-protocol";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { compileQuery, isCompiledQuery, type CompiledQuery } from "graphql-jit";
import { parse } from "graphql";

interface CompileMessage {
  type: "compile";
  query: string;
  schema: string;
  resolvers: string;
}

interface RunMessage {
  type: "run";
  breakpointIds: number[];
}

type Message = CompileMessage | RunMessage;

interface CompileReply {
  compiledQuery: string;
  ready: boolean;
  breakpoints: BreakpointLocation[];
}

interface RunReply {
  executionResult: string;
}

interface CachedCompilation {
  compiledQuery: CompiledQuery;
  compileTime: number;
}

let cachedCompilation: CachedCompilation | undefined;
const debugController = new DebugController();

self.addEventListener("message", (event: MessageEvent) => {
  const message = event.data;
  if (message?.type === "debug-init") {
    debugController.connect(message.controlBuffer, message.watchBuffer);
  }
});

registerPromiseWorker(
  async (message: Message): Promise<CompileReply | RunReply> => {
    if (message.type === "compile") {
      return compile(message);
    }

    return run(message);
  },
);

async function compile(message: CompileMessage): Promise<CompileReply> {
  cachedCompilation = undefined;
  resetBreakpointLocations();
  await waitForFormatter();

  const { query, schema, resolvers: code } = message;
  const body = `
      ${code};
      return resolvers;
    `;

  // Resolver snippets are trusted input for this local demo. They execute only
  // in this dedicated Worker, so they cannot access the page DOM or persist
  // query content unless the snippet explicitly does so through Worker APIs.
  const resolvers = new Function(body).call({});
  const execSchema = makeExecutableSchema({
    typeDefs: schema,
    resolvers,
  });

  const document = parse(query);
  const operationName =
    document.definitions.find(
      (definition) => definition.kind === "OperationDefinition",
    )?.name?.value ?? "anonymous";
  const sourceBase = `graphql-jit://try-graphql-jit/${encodeURIComponent(
    operationName,
  )}`;

  const compileStart = performance.now();
  const compiledQuery = compileQuery(execSchema, document, undefined, {
    debug: {
      enabled: true,
      querySourceName: `${sourceBase}.query.js`,
      variablesSourceName: `${sourceBase}.variables.js`,
      formatSourceCode: formatAndInstrumentGeneratedSource,
    },
  });
  const compileTime = performance.now() - compileStart;

  if (!isCompiledQuery(compiledQuery)) {
    return {
      compiledQuery: JSON.stringify(compiledQuery, null, 2),
      ready: false,
      breakpoints: [],
    };
  }

  cachedCompilation = { compiledQuery, compileTime };
  const jsCode: string = (compiledQuery as any)
    .__DO_NOT_USE_THIS_OR_YOU_WILL_BE_FIRED_compilation;
  const viewerSource = getViewerSource();

  return {
    // The cached executor still contains checkpoints. The viewer omits that
    // implementation detail while retaining the exact formatted line layout.
    compiledQuery: viewerSource
      ? `${viewerSource}${getSourceURLSuffix(jsCode)}`
      : jsCode,
    ready: true,
    breakpoints: getBreakpointLocations(),
  };
}

function getSourceURLSuffix(source: string) {
  const sourceURLStart = source.lastIndexOf("\n//# sourceURL=");
  return sourceURLStart === -1 ? "" : source.slice(sourceURLStart);
}

async function run(message: RunMessage): Promise<RunReply> {
  if (!cachedCompilation) {
    throw new Error("No compiled query is available. Compile the query first.");
  }

  debugController.configure(message.breakpointIds);
  const execStart = performance.now();
  const executionResult = await cachedCompilation.compiledQuery.query(
    {},
    { __graphqlJitDebug: debugController },
    {},
  );
  const executeTime =
    performance.now() - execStart - debugController.getPausedDuration();

  return {
    executionResult: JSON.stringify(
      {
        ...executionResult,
        compileTime: `${Math.floor(cachedCompilation.compileTime)} to ${Math.ceil(
          cachedCompilation.compileTime,
        )} ms`,
        executeTime: `${Math.floor(executeTime)} to ${Math.ceil(
          executeTime,
        )} ms`,
      },
      null,
      2,
    ),
  };
}

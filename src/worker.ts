import registerPromiseWorker from "./register-promise-worker";
import { DebugController } from "./debug-controller";
import type { BreakpointLocation } from "./debug-protocol";
import { supportsGraphqlJitDebugging } from "./graphql-jit-version";
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
const debugController = supportsGraphqlJitDebugging
  ? new DebugController()
  : undefined;
// Start loading Prettier as soon as the execution Worker starts. This makes
// the first debug compile wait only for an already-warming formatter Worker.
const debugFormatterPromise = supportsGraphqlJitDebugging
  ? import("./synchronous-formatter")
  : undefined;

self.addEventListener("message", (event: MessageEvent) => {
  const message = event.data;
  if (message?.type === "debug-init") {
    debugController?.connect(message.controlBuffer, message.watchBuffer);
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
  const debugFormatter = debugFormatterPromise
    ? await debugFormatterPromise
    : undefined;
  debugFormatter?.resetBreakpointLocations();
  await debugFormatter?.waitForFormatter();

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
  const debugOptions = debugFormatter
    ? {
        debug: {
          enabled: true,
          querySourceName: `graphql-jit://try-graphql-jit/${encodeURIComponent(
            operationName,
          )}.query.js`,
          variablesSourceName: `graphql-jit://try-graphql-jit/${encodeURIComponent(
            operationName,
          )}.variables.js`,
          formatSourceCode: debugFormatter.formatAndInstrumentGeneratedSource,
        },
      }
    : {
        // Legacy graphql-jit treats this as a truthy debug flag and exposes
        // its generated executor through the long-standing internal field.
        // Current versions likewise accept it, but without instrumentation.
        debug: { enabled: true },
      };

  const compileStart = performance.now();
  // Older graphql-jit versions ignore the nested debug options but retain the
  // long-standing compiled-source field that the playground displays.
  const compiledQuery = (compileQuery as (...args: unknown[]) => any)(
    execSchema,
    document,
    undefined,
    debugOptions,
  );
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
  const viewerSource = debugFormatter?.getViewerSource();

  return {
    // The cached executor still contains checkpoints. The viewer omits that
    // implementation detail while retaining the exact formatted line layout.
    compiledQuery: viewerSource
      ? `${viewerSource}${getSourceURLSuffix(jsCode)}`
      : jsCode,
    ready: true,
    breakpoints: debugFormatter?.getBreakpointLocations() ?? [],
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

  debugController?.configure(message.breakpointIds);
  const execStart = performance.now();
  const executionResult = await cachedCompilation.compiledQuery.query(
    {},
    debugController ? { __graphqlJitDebug: debugController } : {},
    {},
  );
  const executeTime =
    performance.now() - execStart - (debugController?.getPausedDuration() ?? 0);

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

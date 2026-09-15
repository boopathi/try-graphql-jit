import registerPromiseWorker from "./register-promise-worker";
import {
  formatGeneratedSource,
  waitForFormatter,
} from "./synchronous-formatter";
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
}

type Message = CompileMessage | RunMessage;

interface CompileReply {
  compiledQuery: string;
  ready: boolean;
}

interface RunReply {
  executionResult: string;
}

interface CachedCompilation {
  compiledQuery: CompiledQuery;
  compileTime: number;
}

let cachedCompilation: CachedCompilation | undefined;

registerPromiseWorker(
  async (message: Message): Promise<CompileReply | RunReply> => {
    if (message.type === "compile") {
      return compile(message);
    }

    return run();
  },
);

async function compile(message: CompileMessage): Promise<CompileReply> {
  cachedCompilation = undefined;
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
      formatSourceCode: formatGeneratedSource,
    },
  });
  const compileTime = performance.now() - compileStart;

  if (!isCompiledQuery(compiledQuery)) {
    return {
      compiledQuery: JSON.stringify(compiledQuery, null, 2),
      ready: false,
    };
  }

  cachedCompilation = { compiledQuery, compileTime };
  const jsCode: string = (compiledQuery as any)
    .__DO_NOT_USE_THIS_OR_YOU_WILL_BE_FIRED_compilation;

  return {
    compiledQuery: jsCode,
    ready: true,
  };
}

async function run(): Promise<RunReply> {
  if (!cachedCompilation) {
    throw new Error("No compiled query is available. Compile the query first.");
  }

  const execStart = performance.now();
  const executionResult = await cachedCompilation.compiledQuery.query(
    {},
    {},
    {},
  );
  const executeTime = performance.now() - execStart;

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

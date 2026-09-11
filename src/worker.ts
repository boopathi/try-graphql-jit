import registerPromiseWorker from "./register-promise-worker";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { compileQuery, isCompiledQuery } from "graphql-jit";
import { parse } from "graphql";
import prettier from "prettier/standalone";
import * as parserBabel from "prettier/plugins/babel";
import * as parserEstree from "prettier/plugins/estree";

interface Message {
  query: string;
  schema: string;
  resolvers: string;
}

interface Reply {
  compiledQuery: string;
  executionResult: string;
}

registerPromiseWorker(async (message: Message): Promise<Reply> => {
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

  const compileStart = performance.now();

  const compiledQuery = compileQuery(execSchema, parse(query), undefined, {
    debug: true,
  } as any);
  if (!isCompiledQuery(compiledQuery)) {
    return {
      compiledQuery: "",
      executionResult: JSON.stringify(compiledQuery, null, 2),
    };
  }
  const compileTime = performance.now() - compileStart;

  const execStart = performance.now();
  const executionResult = await compiledQuery.query({}, {}, {});
  const executeTime = performance.now() - execStart;

  const jsCode: any = (compiledQuery as any)
    .__DO_NOT_USE_THIS_OR_YOU_WILL_BE_FIRED_compilation;

  return {
    compiledQuery: await prettier.format(jsCode, {
      parser: "babel",
      plugins: [parserBabel, parserEstree],
      printWidth: 80,
    }),
    executionResult: JSON.stringify(
      {
        ...executionResult,
        compileTime: `${Math.floor(compileTime)} to ${Math.ceil(
          compileTime,
        )} ms`,
        executeTime: `${Math.floor(executeTime)} to ${Math.ceil(
          executeTime,
        )} ms`,
      },
      null,
      2,
    ),
  };
});

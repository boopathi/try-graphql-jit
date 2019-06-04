import registerPromiseWorker from "promise-worker/register";
import { makeExecutableSchema } from "graphql-tools";
import { compileQuery, isCompiledQuery } from "graphql-jit";
import { parse } from "graphql";

interface Message {
  query: string;
  schema: string;
  resolvers: string;
}

interface Reply {
  compiledQuery: string;
  executionResult: string;
}

registerPromiseWorker(
  async (message: Message): Promise<Reply> => {
    const { query, schema, resolvers: code } = message;

    const body = `
      ${code}
      return resolvers;
    `;

    // TODO
    // DANGEROUS
    // UNSAFE
    // Never save user's query.
    // This is only for demonstration
    const resolvers = new Function(body)();

    console.log(resolvers);

    const execSchema = makeExecutableSchema({
      typeDefs: schema,
      resolvers
    });

    const compiledQuery = compileQuery(execSchema, parse(query));
    if (!isCompiledQuery(compiledQuery)) {
      return {
        compiledQuery: "",
        executionResult: JSON.stringify(compiledQuery, null, 2)
      };
    }

    const executionResult = await compiledQuery.query({}, {}, {});

    return {
      compiledQuery: compiledQuery.query.toString(),
      executionResult: JSON.stringify(executionResult, null, 2)
    };
  }
);

import registerPromiseWorker from "promise-worker/register";
import { makeExecutableSchema } from "graphql-tools";
import { compileQuery, isCompiledQuery } from "./graphql-jit";
import { parse } from "graphql";
import prettier from "prettier/standalone";
import babylonParser from "prettier/parser-babylon";

interface Message {
  query: string;
  schema: string;
  resolvers: string;
}

interface Reply {
  compiledQuery: string;
  executionResult: string;
}

const safeNames = [
  "Object",
  "Array",
  "Number",
  "parseFloat",
  "parseInt",
  "Infinity",
  "NaN",
  "undefined",
  "Boolean",
  "String",
  "Symbol",
  "Date",
  "Promise",
  "RegExp",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "JSON",
  "Math",
  "console",
  "Intl",
  "ArrayBuffer",
  "Uint8Array",
  "Int8Array",
  "Uint16Array",
  "Int16Array",
  "Uint32Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "Uint8ClampedArray",
  "BigUint64Array",
  "BigInt64Array",
  "DataView",
  "Map",
  "BigInt",
  "Set",
  "WeakMap",
  "WeakSet",
  "Proxy",
  "Reflect",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "unescape",
  "isFinite",
  "isNaN",
  "URLSearchParams",
  "URL"
];

const safeProps = [
  "performance",
  "queueMicrotask",
  "btoa",
  "atob",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "requestAnimationFrame",
  "cancelAnimationFrame"
];

registerPromiseWorker(
  async (message: Message): Promise<Reply> => {
    const { query, schema, resolvers: code } = message;

    const context: Set<string> = new Set();
    const globalThis = (0, eval)("this");
    for (let name of Object.getOwnPropertyNames(globalThis)) {
      if (!safeNames.includes(name)) {
        context.add(name);
      }
    }
    for (let prop in globalThis) {
      if (!safeProps.includes(prop)) {
        context.add(prop);
      }
    }
    const args = [...context];

    const body = `
      ${code};
      return resolvers;
    `;

    // TODO
    // DANGEROUS
    // UNSAFE
    // Never save user's query.
    // This is only for demonstration
    const resolvers = new Function(...args, body).call({});

    const execSchema = makeExecutableSchema({
      typeDefs: schema,
      resolvers
    });

    const compileStart = performance.now();

    const compiledQuery = compileQuery(execSchema, parse(query));
    if (!isCompiledQuery(compiledQuery)) {
      return {
        compiledQuery: "",
        executionResult: JSON.stringify(compiledQuery, null, 2)
      };
    }
    const compileTime = performance.now() - compileStart;

    const execStart = performance.now();
    const executionResult = await compiledQuery.query({}, {}, {});
    const executeTime = performance.now() - execStart;

    return {
      compiledQuery: prettier.format(
        `function compiledQuery() {
        ${compiledQuery.functionBody}
      }`,
        { parser: "babel", plugins: [babylonParser], printWidth: 80 }
      ),
      executionResult: JSON.stringify(
        {
          ...executionResult,
          compileTime: `${Math.floor(compileTime)} to ${Math.ceil(
            compileTime
          )} ms`,
          executeTime: `${Math.floor(executeTime)} to ${Math.ceil(
            executeTime
          )} ms`
        },
        null,
        2
      )
    };
  }
);

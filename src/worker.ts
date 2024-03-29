import registerPromiseWorker from "./register-promise-worker";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { compileQuery, isCompiledQuery } from "graphql-jit";
import { parse } from "graphql";
import prettier from "prettier/standalone";
import parserBabel from "prettier/parser-babel";

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
  "URL",
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
  "cancelAnimationFrame",
];

function isValidId(id: string) {
  try {
    new Function(id, `let ${id};`);
    return true;
  } catch (e) {
    return false;
  }
}

registerPromiseWorker(async (message: Message): Promise<Reply> => {
  const { query, schema, resolvers: code } = message;

  const context: Set<string> = new Set();
  const globalThis = (0, eval)("this");
  for (let name of Object.getOwnPropertyNames(globalThis)) {
    if (!safeNames.includes(name) && isValidId(name)) {
      context.add(name);
    }
  }
  for (let prop in globalThis) {
    if (!safeProps.includes(prop) && isValidId(prop)) {
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
    compiledQuery: prettier.format(jsCode, {
      parser: "babel",
      plugins: [parserBabel],
      printWidth: 80,
    }),
    executionResult: JSON.stringify(
      {
        ...executionResult,
        compileTime: `${Math.floor(compileTime)} to ${Math.ceil(
          compileTime
        )} ms`,
        executeTime: `${Math.floor(executeTime)} to ${Math.ceil(
          executeTime
        )} ms`,
      },
      null,
      2
    ),
  };
});

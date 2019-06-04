import Codemirror from "codemirror";
import { $ } from "./dom";
import {
  SCHEMA_ELEMENT,
  QUERY_ELEMENT,
  COMPILED_QUERY_ELEMENT,
  EXECUTION_RESULT_ELEMENT,
  RESOLVERS_ELEMENT
} from "./constants";

import "codemirror/mode/javascript/javascript";
import "codemirror/addon/edit/closebrackets";
import "codemirror-graphql/mode";

export function makeEditor(
  el: HTMLElement,
  opts: CodeMirror.EditorConfiguration
) {
  return {
    el,
    editor: Codemirror(el, opts)
  };
}

const defaultSchema = `
type Query {
  product(id: ID!): Product
}

type Product {
  id: ID!
  images: [Image]
}

type Image {
  url: String!
  width: Int
  height: Int
}
`.trim();

const defaultResolvers = `
function getProduct(id) {
  return {
    id,
    images: [
      {
        url: "https://example.com/1.jpg"
      },
      {
        url: "https://example.com/2.jpg"
      }
    ]
  }
}
const resolvers = {
  Query: {
    product(_, {id}) {
      return Promise.resolve(getProduct(id));
    }
  }
}
`.trim();

const defaultQuery = `
query productQuery {
  product(id: "foo") {
    images {
      url
    }
  }
}
`.trim();

export default function makeEditors() {
  const schemaEl = $(SCHEMA_ELEMENT);
  const resolversEl = $(RESOLVERS_ELEMENT);
  const queryEl = $(QUERY_ELEMENT);
  const compiledQueryEl = $(COMPILED_QUERY_ELEMENT);
  const exectionResultEl = $(EXECUTION_RESULT_ELEMENT);

  const theme = "seti";
  const tabSize = 2;

  return {
    schema: makeEditor(schemaEl, {
      value: defaultSchema,
      mode: "graphql",
      tabSize,
      theme,
      autoCloseBrackets: ""
    }),
    resolvers: makeEditor(resolversEl, {
      value: defaultResolvers,
      mode: "javascript",
      tabSize,
      theme,
      autoCloseBrackets: ""
    }),
    query: makeEditor(queryEl, {
      value: defaultQuery,
      mode: "graphql",
      tabSize,
      theme,
      autofocus: true,
      autoCloseBrackets: ""
    }),
    compiledQuery: makeEditor(compiledQueryEl, {
      mode: "javascript",
      tabSize,
      theme
    }),
    exectionResult: makeEditor(exectionResultEl, {
      mode: "javascript",
      tabSize,
      theme
    })
  };
}

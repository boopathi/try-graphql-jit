import makeEditors from "./editor";
import { EXECUTE_BUTTON } from "./constants";
import { $ } from "./dom";
import { executeQuery } from "./execute";
import * as Codemirror from "codemirror";

main();

export default function main() {
  const editors = makeEditors();
  const executeButton = $(EXECUTE_BUTTON);

  executeButton.addEventListener("click", async () => {
    const reply = await executeQuery(
      getValue(editors.schema),
      getValue(editors.resolvers),
      getValue(editors.query)
    );
    editors.compiledQuery.editor.getDoc().setValue(reply.compiledQuery);
    editors.exectionResult.editor.getDoc().setValue(reply.executionResult);
  });

  (window as any).editors = editors;
}

function getValue(e: { editor: Codemirror.Editor }) {
  return e.editor.getValue();
}

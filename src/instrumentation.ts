import * as parserBabel from "prettier/plugins/babel";
import type { BreakpointLocation } from "./debug-protocol";

interface AstNode {
  type: string;
  start?: number;
  end?: number;
  loc?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  [key: string]: unknown;
}

type BreakpointKind = "statement" | "expression";

interface BreakpointCandidate {
  node: AstNode;
  kind: BreakpointKind;
}

interface InstrumentedBreakpoint extends BreakpointLocation {
  start: number;
  end?: number;
  kind: BreakpointKind;
}

interface SourceEdit {
  offset: number;
  text: string;
}

/**
 * Adds synchronous checkpoint calls to statements and selected expressions
 * without changing their line numbers. The generated executor always receives
 * `__context`, which carries the playground's debug controller at execution
 * time.
 */
export function instrumentGeneratedSource(source: string): {
  source: string;
  breakpoints: BreakpointLocation[];
} {
  // This parser supplies defaults for all omitted Prettier options. Its public
  // type is shared with Prettier's internal parser pipeline, where those
  // options are required, so retain the precise parser-options type here.
  const ast = parserBabel.parsers.babel.parse(
    source,
    {} as Parameters<typeof parserBabel.parsers.babel.parse>[1],
  );
  const candidates: BreakpointCandidate[] = [];
  visitNode(ast, candidates, new Set());

  const breakpoints: InstrumentedBreakpoint[] = candidates
    .filter(
      ({ node, kind }) =>
        node.start !== undefined &&
        node.loc !== undefined &&
        (kind !== "expression" || node.end !== undefined),
    )
    // A statement and its expression can start at the same source location.
    // One checkpoint is sufficient there; statement candidates are visited
    // first, so they win over their duplicate expression candidate.
    .filter(
      ({ node }, index, allCandidates) =>
        allCandidates.findIndex(
          (candidate) => candidate.node.start === node.start,
        ) === index,
    )
    .map(({ node, kind }, index) => ({
      id: index + 1,
      line: node.loc!.start.line,
      column: node.loc!.start.column,
      endLine: node.loc!.end.line,
      endColumn: node.loc!.end.column,
      start: node.start!,
      end: node.end,
      kind,
    }));

  const edits = breakpoints
    .reduce<SourceEdit[]>(
      (allEdits, breakpoint) => allEdits.concat(createSourceEdits(breakpoint)),
      [],
    )
    .sort((a, b) => b.offset - a.offset);
  const instrumentedSource = edits.reduce<string>(
    (result, edit) =>
      result.slice(0, edit.offset) + edit.text + result.slice(edit.offset),
    source,
  );

  return {
    source: instrumentedSource,
    breakpoints: breakpoints.map(
      ({ id, line, column, endLine, endColumn }) => ({
        id,
        line,
        column,
        endLine,
        endColumn,
      }),
    ),
  };
}

function createSourceEdits(breakpoint: InstrumentedBreakpoint): SourceEdit[] {
  // The evaluator is created at the source position, so its direct eval sees
  // the same lexical scope as the paused expression. The Error is likewise
  // created lazily at the call site, giving the UI a useful virtual-source
  // stack without constructing an Error at every unchecked expression.
  const checkpoint = `__context.context.__graphqlJitDebug.checkpoint(${breakpoint.id}, __graphqlJitWatchExpression => eval(__graphqlJitWatchExpression), () => new Error().stack)`;

  if (breakpoint.kind === "statement") {
    return [{ offset: breakpoint.start, text: `${checkpoint}; ` }];
  }

  // The outer parentheses preserve the expression's value in every supported
  // expression position, including an assignment or arrow-function return.
  return [
    { offset: breakpoint.end!, text: "))" },
    { offset: breakpoint.start, text: `(void ${checkpoint} || (` },
  ];
}

function visitNode(
  node: unknown,
  candidates: BreakpointCandidate[],
  expressionCandidates: Set<AstNode>,
) {
  if (!isAstNode(node)) return;

  if (node.type === "Program" || node.type === "BlockStatement") {
    visitStatementList(node.body, candidates, expressionCandidates);
    return;
  }

  if (node.type === "SwitchCase") {
    visitNode(node.test, candidates, expressionCandidates);
    visitStatementList(node.consequent, candidates, expressionCandidates);
    return;
  }

  if (isInterestingExpression(node)) {
    addExpressionCandidate(node, candidates, expressionCandidates);
  }

  // An expression-bodied arrow has no statement list. Its returned expression
  // is always useful to pause at, even when it is only an identifier or value.
  if (
    node.type === "ArrowFunctionExpression" &&
    isAstNode(node.body) &&
    node.body.type !== "BlockStatement"
  ) {
    addExpressionCandidate(node.body, candidates, expressionCandidates);
  }

  Object.values(node).forEach((value) => {
    if (Array.isArray(value)) {
      value.forEach((item) =>
        visitNode(item, candidates, expressionCandidates),
      );
      return;
    }

    visitNode(value, candidates, expressionCandidates);
  });
}

function visitStatementList(
  value: unknown,
  candidates: BreakpointCandidate[],
  expressionCandidates: Set<AstNode>,
) {
  if (!Array.isArray(value)) return;

  value.forEach((statement) => {
    if (!isAstNode(statement)) return;

    if (isBreakableStatement(statement)) {
      candidates.push({ node: statement, kind: "statement" });
    }
    visitNode(statement, candidates, expressionCandidates);
  });
}

function addExpressionCandidate(
  node: AstNode,
  candidates: BreakpointCandidate[],
  expressionCandidates: Set<AstNode>,
) {
  if (expressionCandidates.has(node)) return;

  expressionCandidates.add(node);
  candidates.push({ node, kind: "expression" });
}

function isInterestingExpression(node: AstNode) {
  return (
    node.type === "ArrayExpression" ||
    node.type === "AssignmentExpression" ||
    node.type === "AwaitExpression" ||
    node.type === "BinaryExpression" ||
    node.type === "CallExpression" ||
    node.type === "ConditionalExpression" ||
    node.type === "LogicalExpression" ||
    node.type === "NewExpression" ||
    node.type === "ObjectExpression" ||
    node.type === "OptionalCallExpression" ||
    node.type === "SequenceExpression" ||
    node.type === "TaggedTemplateExpression" ||
    node.type === "TemplateLiteral" ||
    node.type === "UpdateExpression"
  );
}

function isBreakableStatement(statement: AstNode) {
  return (
    (statement.type === "VariableDeclaration" ||
      statement.type.endsWith("Statement")) &&
    statement.type !== "EmptyStatement" &&
    statement.type !== "DebuggerStatement" &&
    statement.directive === undefined
  );
}

function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

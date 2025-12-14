import * as t from "@babel/types";
import type { NodePath } from "../babel-traverse";
import type { SymbolInfo } from "./symbol-analysis";
import type { SymbolDossier, SymbolUsageSummary } from "./types";

export function buildSymbolDossier(
  symbol: SymbolInfo,
  { contextWindowSize }: { contextWindowSize: number },
): SymbolDossier {
  const declarationSnippet = truncate(getDeclarationSnippet(symbol), Math.min(400, contextWindowSize));

  const usageSummary = buildUsageSummary(symbol);
  const typeHints = buildTypeHints(symbol, usageSummary);

  return {
    symbolId: symbol.id,
    originalName: symbol.originalName,
    declarationKind: symbol.declarationKind,
    nameStyle: symbol.nameStyle,

    isConstant: symbol.isConstant,
    isExported: symbol.isExported,
    isImported: symbol.isImported,
    isUnsafeToRename: symbol.isUnsafeToRename,

    declarationSnippet,
    usageSummary,
    typeHints,
  };
}

function getDeclarationSnippet(symbol: SymbolInfo): string {
  const bindingPath = symbol.binding.path as unknown as NodePath;
  const stmt = bindingPath.getStatementParent?.();
  const raw = stmt?.toString?.() ?? bindingPath.toString?.() ?? symbol.bindingIdentifierPath.toString();
  return raw ?? "";
}

function buildUsageSummary(symbol: SymbolInfo): SymbolUsageSummary {
  const unaryOperators = new Set<string>();
  const binaryOperators = new Set<string>();
  const comparedWith = new Set<string>();

  const memberReads = new Set<string>();
  const memberWrites = new Set<string>();
  const calledMethods = new Set<string>();

  let isCalled = false;
  let isConstructed = false;
  let isAwaited = false;
  let isIterated = false;
  let isReturned = false;
  let isAssignedTo = false;

  const refs = symbol.binding.referencePaths ?? [];

  for (const ref of refs) {
    const parent = ref.parentPath;
    if (!parent) continue;

    // direct call: foo(...)
    if (parent.isCallExpression() && parent.get("callee") === ref) {
      isCalled = true;
      continue;
    }

    // new Foo(...)
    if (parent.isNewExpression() && parent.get("callee") === ref) {
      isConstructed = true;
      continue;
    }

    // await foo
    if (parent.isAwaitExpression() && parent.get("argument") === ref) {
      isAwaited = true;
      continue;
    }

    // return foo
    if (parent.isReturnStatement() && parent.get("argument") === ref) {
      isReturned = true;
      continue;
    }

    // assignment target: foo = ...
    if (parent.isAssignmentExpression() && parent.get("left") === ref) {
      isAssignedTo = true;
      continue;
    }

    // update: foo++
    if (parent.isUpdateExpression() && parent.get("argument") === ref) {
      isAssignedTo = true;
      continue;
    }

    // unary operators: typeof foo, !foo
    if (parent.isUnaryExpression() && parent.get("argument") === ref) {
      unaryOperators.add(parent.node.operator);
      continue;
    }

    // binary operators: foo + 1, foo === null
    if (parent.isBinaryExpression()) {
      binaryOperators.add(parent.node.operator);
      const leftIsRef = parent.get("left") === ref;
      const other = leftIsRef ? parent.node.right : parent.node.left;

      if (isComparisonOperator(parent.node.operator)) {
        const lit = literalToCompactString(other);
        if (lit) comparedWith.add(lit);
      }

      continue;
    }

    // logical operators: foo && bar
    if (parent.isLogicalExpression()) {
      binaryOperators.add(parent.node.operator);
      continue;
    }

    // for (const x of foo)
    if (parent.isForOfStatement() && parent.get("right") === ref) {
      isIterated = true;
      continue;
    }

    // foo.bar / foo.bar(...)
    if (
      (parent.isMemberExpression() ||
        // Optional chaining (Babel node type exists in modern parsers)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (parent as any).isOptionalMemberExpression?.()) &&
      parent.get("object") === ref
    ) {
      const propertyName = getStaticMemberName(parent);
      if (!propertyName) continue;

      const memberExprPath = parent;

      // foo.bar(...)   => bar in calledMethods
      const memberExprParent = memberExprPath.parentPath;
      if (
        memberExprParent?.isCallExpression() &&
        memberExprParent.get("callee") === memberExprPath
      ) {
        calledMethods.add(propertyName);

        // Capture chained calls:
        //   arr.map(cb).filter(cb)
        // should attribute both `map` and `filter` to `arr` for better type hints.
        collectChainedCalledMethods(memberExprParent, calledMethods);

        continue;
      }

      // foo.bar = ...  => bar in memberWrites
      if (
        memberExprParent?.isAssignmentExpression() &&
        memberExprParent.get("left") === memberExprPath
      ) {
        memberWrites.add(propertyName);
        continue;
      }

      // foo.bar++ => memberWrites
      if (
        memberExprParent?.isUpdateExpression() &&
        memberExprParent.get("argument") === memberExprPath
      ) {
        memberWrites.add(propertyName);
        continue;
      }

      // default: foo.bar => memberReads
      memberReads.add(propertyName);
      continue;
    }
  }

  return {
    referenceCount: refs.length,
    isCalled,
    isConstructed,
    isAwaited,
    isIterated,
    isReturned,
    isAssignedTo,
    unaryOperators: [...unaryOperators].sort(),
    binaryOperators: [...binaryOperators].sort(),
    comparedWith: [...comparedWith].sort(),
    memberReads: [...memberReads].sort(),
    memberWrites: [...memberWrites].sort(),
    calledMethods: [...calledMethods].sort(),
  };
}

function buildTypeHints(symbol: SymbolInfo, usage: SymbolUsageSummary): string[] {
  const hints = new Set<string>();

  if (usage.isConstructed) hints.add("constructed with `new`");
  if (usage.isCalled && !usage.isConstructed) hints.add("called like a function");
  if (usage.isAwaited) hints.add("awaited (promise-like)");

  const arrayMethods = new Set([
    "map",
    "filter",
    "reduce",
    "forEach",
    "some",
    "every",
    "find",
    "findIndex",
    "includes",
    "push",
    "pop",
    "shift",
    "unshift",
    "slice",
    "splice",
    "concat",
    "join",
  ]);
  if (usage.calledMethods.some((m) => arrayMethods.has(m))) {
    hints.add("array-like (uses common Array methods)");
  }

  const promiseMethods = new Set(["then", "catch", "finally"]);
  if (usage.calledMethods.some((m) => promiseMethods.has(m)) || usage.isAwaited) {
    hints.add("promise-like");
  }

  if (usage.memberReads.includes("length")) {
    hints.add("has `.length` (string/array-like)");
  }

  if (usage.comparedWith.includes("null") || usage.comparedWith.includes("undefined")) {
    hints.add("nullable-ish (compared with null/undefined)");
  }

  // Parameters are often values, indices, callbacks etc.
  if (symbol.declarationKind === "param" && usage.isCalled) {
    hints.add("parameter used as callback/function");
  }

  return [...hints].sort();
}

function collectChainedCalledMethods(callPath: NodePath, calledMethods: Set<string>) {
  // Walk chains like:
  //   <call>.filter(...) -> adds "filter"
  //   <call>.filter(...).map(...) -> adds "map" etc.
  let current: NodePath | null = callPath;

  while (current) {
    const parent = current.parentPath;
    if (!parent) break;

    const isMemberExpression =
      parent.isMemberExpression() ||
      // Optional chaining support (Babel provides OptionalMemberExpression)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (parent as any).isOptionalMemberExpression?.();

    if (!isMemberExpression) break;
    if (parent.get("object") !== current) break;

    const propertyName = getStaticMemberName(parent);
    if (!propertyName) break;

    const maybeCall = parent.parentPath;
    if (maybeCall?.isCallExpression() && maybeCall.get("callee") === parent) {
      calledMethods.add(propertyName);
      current = maybeCall;
      continue;
    }

    break;
  }
}

function isComparisonOperator(op: string): boolean {
  return (
    op === "==" ||
    op === "!=" ||
    op === "===" ||
    op === "!==" ||
    op === "<" ||
    op === "<=" ||
    op === ">" ||
    op === ">=" ||
    op === "in" ||
    op === "instanceof"
  );
}

function literalToCompactString(node: t.Node): string | null {
  if (t.isNullLiteral(node)) return "null";
  if (t.isIdentifier(node, { name: "undefined" })) return "undefined";
  if (t.isBooleanLiteral(node)) return node.value ? "true" : "false";
  if (t.isNumericLiteral(node)) return String(node.value);
  if (t.isStringLiteral(node)) return JSON.stringify(node.value);
  if (t.isBigIntLiteral(node)) return node.value;
  return null;
}

function getStaticMemberName(memberPath: NodePath): string | null {
  // memberPath.node is MemberExpression | OptionalMemberExpression (same shape)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const node: any = memberPath.node;
  if (node.computed) return null;
  if (t.isIdentifier(node.property)) return node.property.name;
  if (t.isStringLiteral(node.property)) return node.property.value;
  return null;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return `${str.slice(0, Math.max(0, max - 1))}…`;
}
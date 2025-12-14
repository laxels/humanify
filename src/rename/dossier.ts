import * as t from "@babel/types";
import type { NodePath } from "../babel-traverse";
import type {
  ChunkId,
  RenamingAnalysis,
  SymbolDossier,
  SymbolInfo,
} from "./types";

export function buildDossiersByChunk(
  analysis: RenamingAnalysis,
  contextWindowSize: number,
): Map<ChunkId, SymbolDossier[]> {
  const byChunk = new Map<ChunkId, SymbolDossier[]>();

  for (const symbol of analysis.symbols.values()) {
    const dossier = buildSymbolDossier(symbol, contextWindowSize);
    const list = byChunk.get(symbol.chunkId) ?? [];
    list.push(dossier);
    byChunk.set(symbol.chunkId, list);
  }

  for (const [chunkId, list] of byChunk) {
    // Stable ordering for deterministic prompts and easier debugging.
    list.sort((a, b) => a.originalName.localeCompare(b.originalName));
    byChunk.set(chunkId, list);
  }

  return byChunk;
}

export function buildSymbolDossier(
  symbol: SymbolInfo,
  contextWindowSize: number,
): SymbolDossier {
  const declarationSnippet = getDeclarationSnippet(symbol, contextWindowSize);
  const { usageSummary, typeHints } = summarizeUsages(symbol);

  return {
    id: symbol.id,
    originalName: symbol.originalName,
    kind: symbol.kind,
    isExported: symbol.isExported,
    declarationSnippet,
    usageSummary,
    typeHints,
  };
}

function getDeclarationSnippet(
  symbol: SymbolInfo,
  contextWindowSize: number,
): string {
  if (symbol.kind === "param") {
    const fn = symbol.declIdPath.getFunctionParent();
    if (fn) {
      return truncate(
        extractHeader(fn.toString()),
        Math.min(400, contextWindowSize),
      );
    }
  }

  const statement = symbol.declIdPath.getStatementParent();
  const raw = (statement ?? symbol.binding.path).toString();
  return truncate(raw, Math.min(400, contextWindowSize));
}

function extractHeader(code: string): string {
  const trimmed = code.trim();
  const braceIndex = trimmed.indexOf("{");
  if (braceIndex !== -1) {
    return `${trimmed.slice(0, braceIndex).trim()} { … }`;
  }
  const arrowIndex = trimmed.indexOf("=>");
  if (arrowIndex !== -1) {
    return `${trimmed.slice(0, arrowIndex + 2).trim()} …`;
  }
  return trimmed;
}

function truncate(str: string, maxChars: number): string {
  const s = str.replace(/\s+/g, " ").trim();
  return s.length <= maxChars ? s : `${s.slice(0, maxChars)}…`;
}

type UsageAgg = {
  refs: number;
  reads: number;
  writes: number;
  called: number;
  calledArgCounts: Map<number, number>;
  constructed: number;
  awaited: number;
  returned: number;
  thrown: number;
  inCondition: number;
  inTemplate: number;
  memberAccesses: Map<string, number>;
  methodCalls: Map<string, number>;
  comparisons: Map<string, number>;
};

function summarizeUsages(symbol: SymbolInfo): {
  usageSummary: string;
  typeHints: string[];
} {
  const binding = symbol.binding;
  const refPaths = binding.referencePaths as Array<NodePath<t.Identifier>>;

  const agg: UsageAgg = {
    refs: refPaths.length,
    reads: 0,
    writes: 0,
    called: 0,
    calledArgCounts: new Map<number, number>(),
    constructed: 0,
    awaited: 0,
    returned: 0,
    thrown: 0,
    inCondition: 0,
    inTemplate: 0,
    memberAccesses: new Map<string, number>(),
    methodCalls: new Map<string, number>(),
    comparisons: new Map<string, number>(),
  };

  for (const ref of refPaths) {
    classifyReference(ref, agg);
  }

  const typeHints = deriveTypeHints(symbol, agg);

  const parts: string[] = [];
  parts.push(`refs: ${agg.refs}`);

  if (agg.writes > 0) parts.push(`writes: ${agg.writes}`);
  if (agg.called > 0) {
    const argCounts = [...agg.calledArgCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([argc, n]) => `${argc} args (${n}x)`)
      .join(", ");
    parts.push(
      argCounts
        ? `called: ${agg.called} (${argCounts})`
        : `called: ${agg.called}`,
    );
  }
  if (agg.constructed > 0) parts.push(`new: ${agg.constructed}`);
  if (agg.awaited > 0) parts.push(`awaited: ${agg.awaited}`);
  if (agg.returned > 0) parts.push(`returned: ${agg.returned}`);
  if (agg.thrown > 0) parts.push(`thrown: ${agg.thrown}`);
  if (agg.inCondition > 0) parts.push(`in conditions: ${agg.inCondition}`);
  if (agg.inTemplate > 0) parts.push(`in template literals: ${agg.inTemplate}`);

  const members = topKeys(agg.memberAccesses, 6).map((k) => `.${k}`);
  const methods = topKeys(agg.methodCalls, 6).map((k) => `.${k}()`);
  if (methods.length > 0) parts.push(`methods: ${methods.join(", ")}`);
  if (members.length > 0) parts.push(`members: ${members.join(", ")}`);

  const comparisons = topKeys(agg.comparisons, 4);
  if (comparisons.length > 0)
    parts.push(`compared to: ${comparisons.join(", ")}`);

  const summary = parts.join(" • ");

  return { usageSummary: summary, typeHints };
}

function increment(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function incrementNum(map: Map<number, number>, key: number) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function topKeys(map: Map<string, number>, max: number): string[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([k]) => k);
}

function classifyReference(ref: NodePath<t.Identifier>, agg: UsageAgg) {
  const parent = ref.parentPath;
  if (!parent) {
    agg.reads++;
    return;
  }

  // Writes
  if (parent.isAssignmentExpression() && parent.node.left === ref.node) {
    agg.writes++;
  } else if (parent.isUpdateExpression() && parent.node.argument === ref.node) {
    agg.writes++;
  } else if (
    (parent.isForInStatement() || parent.isForOfStatement()) &&
    (parent.node as any).left === ref.node
  ) {
    agg.writes++;
  } else {
    agg.reads++;
  }

  // Called / constructed
  if (parent.isCallExpression() && parent.node.callee === ref.node) {
    agg.called++;
    incrementNum(agg.calledArgCounts, parent.node.arguments.length);
  } else if (parent.isNewExpression() && parent.node.callee === ref.node) {
    agg.constructed++;
  }

  // Awaited
  if (parent.isAwaitExpression() && parent.node.argument === ref.node) {
    agg.awaited++;
  }

  // Returned / thrown
  if (parent.isReturnStatement() && parent.node.argument === ref.node) {
    agg.returned++;
  }
  if (parent.isThrowStatement() && parent.node.argument === ref.node) {
    agg.thrown++;
  }

  // Conditions
  if (isInCondition(ref)) {
    agg.inCondition++;
  }

  // Template literal
  if (parent.isTemplateLiteral()) {
    agg.inTemplate++;
  }

  // Member access: x.foo
  if (parent.isMemberExpression() && parent.node.object === ref.node) {
    const propName = getStaticPropertyName(parent.node);
    if (propName) increment(agg.memberAccesses, propName);

    const callParent = parent.parentPath;
    if (
      callParent?.isCallExpression() &&
      callParent.node.callee === parent.node
    ) {
      if (propName) increment(agg.methodCalls, propName);
    }
  }

  // Optional chaining: x?.foo / x?.()
  if (
    (parent as any).isOptionalMemberExpression?.() &&
    (parent.node as any).object === ref.node
  ) {
    const propName = getStaticPropertyName(parent.node as any);
    if (propName) increment(agg.memberAccesses, propName);

    const callParent = parent.parentPath;
    if (
      (callParent as any)?.isOptionalCallExpression?.() &&
      (callParent!.node as any).callee === parent.node
    ) {
      if (propName) increment(agg.methodCalls, propName);
    }
  }

  // Comparisons
  if (
    parent.isBinaryExpression() &&
    isComparisonOperator(parent.node.operator)
  ) {
    const other =
      parent.node.left === ref.node ? parent.node.right : parent.node.left;
    const literal = literalToString(other);
    if (literal) increment(agg.comparisons, literal);
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
    op === ">="
  );
}

function literalToString(node: t.Node): string | undefined {
  if (t.isNullLiteral(node)) return "null";
  if (t.isIdentifier(node, { name: "undefined" })) return "undefined";
  if (t.isBooleanLiteral(node)) return String(node.value);
  if (t.isNumericLiteral(node)) return String(node.value);
  if (t.isStringLiteral(node)) return JSON.stringify(node.value);
  return undefined;
}

function getStaticPropertyName(
  node: t.MemberExpression | any,
): string | undefined {
  if (node.computed) {
    if (t.isStringLiteral(node.property)) return node.property.value;
    if (t.isNumericLiteral(node.property)) return String(node.property.value);
    return undefined;
  }
  if (t.isIdentifier(node.property)) return node.property.name;
  return undefined;
}

function isInCondition(path: NodePath<t.Identifier>): boolean {
  const parent = path.parentPath;
  if (!parent) return false;

  // if (x) / while(x) / for(;x;)
  if (parent.isIfStatement() && parent.node.test === path.node) return true;
  if (parent.isWhileStatement() && parent.node.test === path.node) return true;
  if (parent.isDoWhileStatement() && parent.node.test === path.node)
    return true;
  if (parent.isForStatement() && parent.node.test === path.node) return true;

  // ternary condition
  if (parent.isConditionalExpression() && parent.node.test === path.node)
    return true;

  // logical expression in test positions (we only do shallow)
  if (parent.isLogicalExpression()) return true;

  return false;
}

function deriveTypeHints(symbol: SymbolInfo, agg: UsageAgg): string[] {
  const hints = new Set<string>();

  const members = new Set(agg.memberAccesses.keys());
  const methods = new Set(agg.methodCalls.keys());

  const hasAny = (set: Set<string>, names: string[]) =>
    names.some((n) => set.has(n));

  if (agg.called > 0 && symbol.kind !== "class") hints.add("callable");
  if (agg.constructed > 0 || symbol.kind === "class")
    hints.add("constructor/class");

  if (agg.awaited > 0 || hasAny(members, ["then", "catch", "finally"])) {
    hints.add("promise-like");
  }

  if (
    hasAny(methods, [
      "map",
      "filter",
      "reduce",
      "forEach",
      "some",
      "every",
      "find",
    ]) ||
    hasAny(members, ["length"]) ||
    hasAny(methods, ["push", "pop", "shift", "unshift", "slice", "splice"])
  ) {
    hints.add("array-like");
  }

  if (
    hasAny(methods, [
      "substring",
      "substr",
      "slice",
      "toLowerCase",
      "toUpperCase",
      "trim",
      "split",
      "replace",
      "charCodeAt",
    ])
  ) {
    hints.add("string-like");
  }

  if (hasAny(methods, ["get", "set", "has"]) && hasAny(members, ["size"])) {
    hints.add("map/set-like");
  }

  if (
    hasAny(methods, [
      "addEventListener",
      "removeEventListener",
      "dispatchEvent",
    ])
  ) {
    hints.add("event-target-like");
  }

  return [...hints];
}

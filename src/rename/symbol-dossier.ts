import type { NodePath } from "@babel/core";
import generate from "@babel/generator";
import type { Node } from "@babel/types";
import type { DeclarationKind, SymbolInfo, SymbolTable } from "./symbol-table";

export type UseSiteInfo = {
  type: UseSiteType;
  context: string;
};

export type UseSiteType =
  | "property_access"
  | "method_call"
  | "function_call"
  | "array_access"
  | "assignment"
  | "comparison"
  | "arithmetic"
  | "logical"
  | "return"
  | "await"
  | "typeof"
  | "instanceof"
  | "spread"
  | "template_literal"
  | "object_shorthand"
  | "destructure"
  | "export"
  | "other";

export type SymbolDossier = {
  symbolId: string;
  originalName: string;
  declarationKind: DeclarationKind;
  declarationContext: string;
  useSites: UseSiteInfo[];
  typeHints: string[];
  usedAsObjectShorthand: boolean;
  isExported: boolean;
};

function getStatementContext(path: NodePath<Node>, maxLength = 200): string {
  // Find the closest statement-level ancestor
  let current: NodePath<Node> | null = path;
  while (current && !current.isStatement() && !current.isProgram()) {
    current = current.parentPath;
  }

  if (!current || current.isProgram()) {
    current = path;
  }

  try {
    const code = generate(current.node, { compact: true }).code;
    if (code.length <= maxLength) {
      return code;
    }
    return code.slice(0, maxLength) + "...";
  } catch {
    return "";
  }
}

function analyzeUseSite(refPath: NodePath<Node>): UseSiteInfo {
  const parent = refPath.parentPath;
  if (!parent) {
    return { type: "other", context: getStatementContext(refPath) };
  }

  const parentNode = parent.node;

  // Property access: a.b or a?.b
  if (parent.isMemberExpression() && parent.get("object") === refPath) {
    const property =
      parentNode.type === "MemberExpression" && "property" in parentNode
        ? parentNode.property
        : null;
    const propName =
      property && property.type === "Identifier" ? property.name : "?";
    return {
      type: parent.parentPath?.isCallExpression()
        ? "method_call"
        : "property_access",
      context: `.${propName}`,
    };
  }

  // Function call: a()
  if (parent.isCallExpression() && parent.get("callee") === refPath) {
    return {
      type: "function_call",
      context: getStatementContext(parent),
    };
  }

  // Array access: a[i]
  if (
    parent.isMemberExpression() &&
    parent.node.computed &&
    parent.get("object") === refPath
  ) {
    return { type: "array_access", context: getStatementContext(parent) };
  }

  // Assignment: a = x
  if (parent.isAssignmentExpression() && parent.get("left") === refPath) {
    return { type: "assignment", context: getStatementContext(parent) };
  }

  // Comparison: a == b, a === b, etc.
  if (
    parent.isBinaryExpression() &&
    ["==", "===", "!=", "!==", "<", ">", "<=", ">="].includes(
      parent.node.operator,
    )
  ) {
    return { type: "comparison", context: getStatementContext(parent) };
  }

  // Arithmetic: a + b, a * b, etc.
  if (
    parent.isBinaryExpression() &&
    ["+", "-", "*", "/", "%", "**"].includes(parent.node.operator)
  ) {
    return { type: "arithmetic", context: getStatementContext(parent) };
  }

  // Logical: a && b, a || b
  if (parent.isLogicalExpression()) {
    return { type: "logical", context: getStatementContext(parent) };
  }

  // Return statement
  if (parent.isReturnStatement()) {
    return { type: "return", context: getStatementContext(parent) };
  }

  // Await expression
  if (parent.isAwaitExpression()) {
    return { type: "await", context: getStatementContext(parent) };
  }

  // Typeof
  if (parent.isUnaryExpression() && parent.node.operator === "typeof") {
    return { type: "typeof", context: getStatementContext(parent) };
  }

  // Instanceof
  if (parent.isBinaryExpression() && parent.node.operator === "instanceof") {
    return { type: "instanceof", context: getStatementContext(parent) };
  }

  // Spread
  if (parent.isSpreadElement()) {
    return { type: "spread", context: getStatementContext(parent) };
  }

  // Template literal
  if (parent.isTemplateLiteral() || parent.isTaggedTemplateExpression()) {
    return { type: "template_literal", context: getStatementContext(parent) };
  }

  // Object shorthand: { a }
  if (parent.isObjectProperty() && parent.node.shorthand) {
    return { type: "object_shorthand", context: getStatementContext(parent) };
  }

  // Destructure
  if (
    parent.isArrayPattern() ||
    parent.isObjectPattern() ||
    (parent.isObjectProperty() && parent.parentPath?.isObjectPattern())
  ) {
    return { type: "destructure", context: getStatementContext(parent) };
  }

  // Export
  if (parent.isExportSpecifier() || parent.isExportDefaultDeclaration()) {
    return { type: "export", context: getStatementContext(parent) };
  }

  return { type: "other", context: getStatementContext(refPath) };
}

function extractTypeHints(symbol: SymbolInfo): string[] {
  const hints: string[] = [];
  const methodCalls = new Set<string>();
  const propertyAccesses = new Set<string>();

  for (const ref of symbol.references) {
    const parent = ref.parentPath;
    if (!parent) continue;

    // Check for method calls like .map(), .filter(), etc.
    if (parent.isMemberExpression() && parent.get("object") === ref) {
      const property = parent.node.property;
      if (property.type === "Identifier") {
        if (parent.parentPath?.isCallExpression()) {
          methodCalls.add(property.name);
        } else {
          propertyAccesses.add(property.name);
        }
      }
    }

    // Check for await
    if (parent.isAwaitExpression()) {
      hints.push("async/Promise");
    }

    // Check for typeof comparisons
    if (
      parent.isBinaryExpression() &&
      ["==", "==="].includes(parent.node.operator)
    ) {
      const sibling =
        parent.get("left") === ref ? parent.get("right") : parent.get("left");
      if (
        sibling.isStringLiteral() &&
        [
          "string",
          "number",
          "boolean",
          "object",
          "function",
          "undefined",
        ].includes(sibling.node.value)
      ) {
        hints.push(`typeof === "${sibling.node.value}"`);
      }
    }
  }

  // Add array-like hints
  const arrayMethods = [
    "map",
    "filter",
    "reduce",
    "forEach",
    "find",
    "some",
    "every",
    "push",
    "pop",
    "slice",
    "splice",
  ];
  for (const method of methodCalls) {
    if (arrayMethods.includes(method)) {
      hints.push("array-like");
      break;
    }
  }

  // Add string-like hints
  const stringMethods = [
    "split",
    "substring",
    "substr",
    "charAt",
    "indexOf",
    "includes",
    "replace",
    "trim",
    "toLowerCase",
    "toUpperCase",
  ];
  for (const method of methodCalls) {
    if (stringMethods.includes(method)) {
      hints.push("string-like");
      break;
    }
  }

  // Add object-like hints based on property access
  if (propertyAccesses.size > 0) {
    hints.push(
      `has properties: ${Array.from(propertyAccesses).slice(0, 5).join(", ")}`,
    );
  }

  // Check if used as a function
  for (const ref of symbol.references) {
    if (
      ref.parentPath?.isCallExpression() &&
      ref.parentPath.get("callee") === ref
    ) {
      hints.push("called as function");
      break;
    }
  }

  return [...new Set(hints)];
}

function checkObjectShorthand(symbol: SymbolInfo): boolean {
  for (const ref of symbol.references) {
    const parent = ref.parentPath;
    if (parent?.isObjectProperty() && parent.node.shorthand) {
      return true;
    }
  }
  return false;
}

function checkExported(symbol: SymbolInfo): boolean {
  for (const ref of symbol.references) {
    const parent = ref.parentPath;
    if (parent?.isExportSpecifier() || parent?.isExportDefaultDeclaration()) {
      return true;
    }
  }

  // Also check the declaration path
  const declParent = symbol.declarationPath.parentPath;
  if (
    declParent?.isExportNamedDeclaration() ||
    declParent?.isExportDefaultDeclaration()
  ) {
    return true;
  }

  return false;
}

export function extractSymbolDossier(
  symbol: SymbolInfo,
  _table: SymbolTable,
): SymbolDossier {
  const useSites: UseSiteInfo[] = [];

  // Analyze all reference sites
  for (const ref of symbol.references) {
    useSites.push(analyzeUseSite(ref));
  }

  // Get declaration context
  const declarationContext = getStatementContext(symbol.declarationPath, 300);

  return {
    symbolId: symbol.id,
    originalName: symbol.name,
    declarationKind: symbol.declarationKind,
    declarationContext,
    useSites,
    typeHints: extractTypeHints(symbol),
    usedAsObjectShorthand: checkObjectShorthand(symbol),
    isExported: checkExported(symbol),
  };
}

export function formatDossierForLLM(dossier: SymbolDossier): string {
  const lines: string[] = [];

  lines.push(`**${dossier.originalName}** (${dossier.declarationKind})`);
  lines.push(`Declaration: ${dossier.declarationContext}`);

  if (dossier.typeHints.length > 0) {
    lines.push(`Type hints: ${dossier.typeHints.join(", ")}`);
  }

  // Summarize use sites by type
  const useSiteCounts = new Map<UseSiteType, number>();
  const useSiteExamples = new Map<UseSiteType, string[]>();

  for (const site of dossier.useSites) {
    useSiteCounts.set(site.type, (useSiteCounts.get(site.type) || 0) + 1);
    const examples = useSiteExamples.get(site.type) || [];
    if (examples.length < 2) {
      examples.push(site.context);
    }
    useSiteExamples.set(site.type, examples);
  }

  if (useSiteCounts.size > 0) {
    lines.push("Usage:");
    for (const [type, count] of useSiteCounts) {
      const examples = useSiteExamples.get(type) || [];
      lines.push(`  - ${type} (${count}x): ${examples.join("; ")}`);
    }
  }

  if (dossier.usedAsObjectShorthand) {
    lines.push("⚠️ Used in object shorthand (renaming may affect object shape)");
  }

  if (dossier.isExported) {
    lines.push("⚠️ Exported (renaming may affect public API)");
  }

  return lines.join("\n");
}

export function extractDossiersForSymbols(
  symbols: SymbolInfo[],
  table: SymbolTable,
): SymbolDossier[] {
  return symbols.map((s) => extractSymbolDossier(s, table));
}

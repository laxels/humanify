import type { NodePath } from "@babel/core";
import generate from "@babel/generator";
import type { Binding } from "@babel/traverse";
import * as babelTraverse from "@babel/traverse";
import type { File, Identifier, Node } from "@babel/types";
import {
  type AnalyzeResult,
  createBindingId,
  hasUnsafeConstructs,
  isBindingExported,
} from "./scope-analyzer";
import type {
  BindingId,
  SymbolDossier,
  TypeHints,
  UseSite,
  UseSiteKind,
} from "./types";

const traverse = (
  typeof (babelTraverse as unknown as { default?: unknown }).default ===
  "function"
    ? (babelTraverse as unknown as { default: typeof babelTraverse.default })
        .default
    : (
        babelTraverse as unknown as {
          default: { default: typeof babelTraverse.default };
        }
      ).default.default
) as typeof babelTraverse.default;

const MAX_CONTEXT_LENGTH = 150;

/**
 * Truncates a string to a maximum length, adding ellipsis if needed.
 */
export function truncateContext(
  code: string,
  maxLength = MAX_CONTEXT_LENGTH,
): string {
  const trimmed = code.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return trimmed.slice(0, maxLength - 3) + "...";
}

/**
 * Gets a string representation of a node, truncated if necessary.
 */
export function nodeToString(
  node: Node,
  maxLength = MAX_CONTEXT_LENGTH,
): string {
  try {
    const { code } = generate(node, { compact: true });
    return truncateContext(code, maxLength);
  } catch {
    return "<unparseable>";
  }
}

/**
 * Determines the kind of use site from an identifier path.
 */
export function getUseSiteKind(path: NodePath<Identifier>): UseSiteKind {
  const parent = path.parentPath;
  if (!parent) return "other";

  const _parentNode = parent.node;

  // Call expression: foo() or foo.bar()
  if (parent.isCallExpression()) {
    if (parent.node.callee === path.node) {
      return "call";
    }
    // foo is an argument
    return "other";
  }

  // Member expression: foo.bar or foo[bar]
  if (parent.isMemberExpression()) {
    if (parent.node.object === path.node) {
      // foo.bar or foo[bar] - foo is the object
      if (parent.node.computed) {
        return "computed_access";
      }
      // Check if this is a method call
      const grandparent = parent.parentPath;
      if (
        grandparent?.isCallExpression() &&
        grandparent.node.callee === parent.node
      ) {
        return "method_call";
      }
      return "property_access";
    }
    // foo is the property in computed access - we're being accessed
    return "other";
  }

  // Assignment: foo = x or x = foo
  if (parent.isAssignmentExpression()) {
    if (parent.node.left === path.node) {
      return "assignment";
    }
    return "other";
  }

  // Binary expressions
  if (parent.isBinaryExpression()) {
    const op = parent.node.operator;
    if (["+", "-", "*", "/", "%", "**"].includes(op)) {
      return "arithmetic";
    }
    if (["===", "!==", "==", "!=", "<", ">", "<=", ">="].includes(op)) {
      return "comparison";
    }
    if (op === "instanceof") {
      return "instanceof";
    }
    return "other";
  }

  // Logical expressions
  if (parent.isLogicalExpression()) {
    return "logical";
  }

  // Await expression
  if (parent.isAwaitExpression()) {
    return "await";
  }

  // Typeof
  if (parent.isUnaryExpression() && parent.node.operator === "typeof") {
    return "typeof";
  }

  // Spread
  if (parent.isSpreadElement()) {
    return "spread";
  }

  // Template literal
  if (parent.isTemplateLiteral() || parent.isTemplateElement()) {
    return "template";
  }

  // Return statement
  if (parent.isReturnStatement()) {
    return "return";
  }

  // Throw statement
  if (parent.isThrowStatement()) {
    return "throw";
  }

  // Conditional expression
  if (parent.isConditionalExpression()) {
    if (parent.node.test === path.node) {
      return "conditional";
    }
    return "other";
  }

  // New expression
  if (parent.isNewExpression()) {
    if (parent.node.callee === path.node) {
      return "new";
    }
    return "other";
  }

  // Object property shorthand: { foo }
  if (parent.isObjectProperty()) {
    if (parent.node.shorthand && parent.node.value === path.node) {
      return "shorthand_property";
    }
  }

  return "other";
}

/**
 * Extracts detailed use site information from an identifier reference.
 */
export function extractUseSite(path: NodePath<Identifier>): UseSite {
  const kind = getUseSiteKind(path);
  const parent = path.parentPath;

  const useSite: UseSite = {
    kind,
    context: nodeToString(parent?.node || path.node),
  };

  // Extract additional context based on kind
  if (kind === "property_access" || kind === "method_call") {
    if (parent?.isMemberExpression() && !parent.node.computed) {
      const prop = parent.node.property;
      if (prop.type === "Identifier") {
        if (kind === "method_call") {
          useSite.methodName = prop.name;
        } else {
          useSite.propertyName = prop.name;
        }
      }
    }
  }

  if (kind === "call") {
    const callExpr = parent?.node;
    if (callExpr && callExpr.type === "CallExpression") {
      useSite.argCount = callExpr.arguments.length;
    }
  }

  return useSite;
}

/**
 * Builds type hints from a collection of use sites.
 */
export function buildTypeHints(useSites: UseSite[]): TypeHints {
  const hints: TypeHints = {
    methodsCalled: [],
    propertiesAccessed: [],
    isCalledAsFunction: false,
    isConstructed: false,
    isAwaited: false,
    hasTypeofCheck: false,
    hasInstanceofCheck: false,
  };

  const methodsSet = new Set<string>();
  const propsSet = new Set<string>();

  for (const site of useSites) {
    switch (site.kind) {
      case "call":
        hints.isCalledAsFunction = true;
        break;
      case "new":
        hints.isConstructed = true;
        break;
      case "await":
        hints.isAwaited = true;
        break;
      case "typeof":
        hints.hasTypeofCheck = true;
        break;
      case "instanceof":
        hints.hasInstanceofCheck = true;
        break;
      case "method_call":
        if (site.methodName) {
          methodsSet.add(site.methodName);
        }
        break;
      case "property_access":
        if (site.propertyName) {
          propsSet.add(site.propertyName);
        }
        break;
    }
  }

  hints.methodsCalled = Array.from(methodsSet);
  hints.propertiesAccessed = Array.from(propsSet);

  // Infer type based on patterns
  hints.inferredType = inferType(hints);

  return hints;
}

/**
 * Infers a likely type based on usage patterns.
 */
export function inferType(hints: TypeHints): TypeHints["inferredType"] {
  const arrayMethods = [
    "map",
    "filter",
    "reduce",
    "forEach",
    "find",
    "some",
    "every",
    "flat",
    "flatMap",
    "slice",
    "splice",
    "push",
    "pop",
    "shift",
    "unshift",
    "indexOf",
    "includes",
  ];
  const stringMethods = [
    "split",
    "substring",
    "substr",
    "slice",
    "charAt",
    "charCodeAt",
    "toLowerCase",
    "toUpperCase",
    "trim",
    "replace",
    "match",
    "startsWith",
    "endsWith",
    "includes",
    "indexOf",
    "padStart",
    "padEnd",
  ];
  const promiseMethods = ["then", "catch", "finally"];

  const methods = hints.methodsCalled;
  const props = hints.propertiesAccessed;

  // Check for array indicators
  if (
    methods.some((m) => arrayMethods.includes(m)) ||
    props.includes("length")
  ) {
    const hasStringMethods = methods.some((m) => stringMethods.includes(m));
    if (!hasStringMethods) {
      return "array";
    }
  }

  // Check for string indicators
  if (
    methods.some((m) => stringMethods.includes(m) && !arrayMethods.includes(m))
  ) {
    return "string";
  }

  // Check for promise indicators
  if (hints.isAwaited || methods.some((m) => promiseMethods.includes(m))) {
    return "promise";
  }

  // Check for function indicators
  if (hints.isCalledAsFunction && !hints.isConstructed) {
    return "function";
  }

  // Check for class/constructor indicators
  if (hints.isConstructed) {
    return "class";
  }

  // Check for boolean indicators (commonly used in conditionals)
  // This is a weak signal, so we don't set it

  // Default: if it has properties/methods, it's likely an object
  if (props.length > 0 || methods.length > 0) {
    return "object";
  }

  return undefined;
}

/**
 * Gets the declaration context for a binding.
 */
export function getDeclarationContext(
  binding: Binding,
  maxLength = 300,
): string {
  const declPath = binding.path;

  // Try to get the containing statement
  const statementPath = declPath.getStatementParent();
  if (statementPath) {
    return nodeToString(statementPath.node, maxLength);
  }

  return nodeToString(declPath.node, maxLength);
}

/**
 * Extracts all symbol dossiers from an analyzed code result.
 */
export function extractSymbolDossiers(
  ast: File,
  analyzeResult: AnalyzeResult,
): Map<BindingId, SymbolDossier> {
  const { symbolTable, bindingInfos } = analyzeResult;
  const dossiers = new Map<BindingId, SymbolDossier>();

  // Process each binding
  traverse(ast, {
    Scope(scopePath) {
      const scope = scopePath.scope;
      const scopeUid = String(scope.uid);
      const unsafeCheck = hasUnsafeConstructs(scope);

      // Get all bindings in this scope
      for (const [name, binding] of Object.entries(scope.bindings)) {
        // Only process bindings that are declared in this exact scope
        if (String(binding.scope.uid) !== scopeUid) continue;

        const bindingId = createBindingId(scopeUid, name);

        // Skip if we already processed this binding
        if (dossiers.has(bindingId)) continue;

        const bindingInfo = bindingInfos.get(bindingId);
        if (!bindingInfo) continue;

        // Collect use sites from reference paths
        const useSites: UseSite[] = [];
        for (const refPath of binding.referencePaths) {
          if (refPath.isIdentifier()) {
            useSites.push(extractUseSite(refPath));
          }
        }

        // Build type hints
        const typeHints = buildTypeHints(useSites);

        // Create the dossier
        const dossier: SymbolDossier = {
          id: bindingId,
          originalName: name,
          declarationKind: bindingInfo.declarationKind,
          declarationContext: getDeclarationContext(binding),
          useSites,
          typeHints,
          scopeId: scopeUid,
          isExported: isBindingExported(binding),
          isUnsafe: unsafeCheck.unsafe,
          unsafeReason: unsafeCheck.reason,
        };

        dossiers.set(bindingId, dossier);
      }
    },
  });

  // Add dossiers to symbol table
  for (const [id, dossier] of dossiers) {
    symbolTable.bindings.set(id, dossier);
  }

  return dossiers;
}

/**
 * Formats a symbol dossier as a compact string for LLM context.
 */
export function formatDossierForLLM(dossier: SymbolDossier): string {
  const lines: string[] = [];

  lines.push(`### \`${dossier.originalName}\` (${dossier.declarationKind})`);
  lines.push(`Declaration: ${dossier.declarationContext}`);

  if (dossier.useSites.length > 0) {
    // Group use sites by kind
    const usageByKind = new Map<UseSiteKind, UseSite[]>();
    for (const site of dossier.useSites) {
      const existing = usageByKind.get(site.kind) ?? [];
      existing.push(site);
      usageByKind.set(site.kind, existing);
    }

    lines.push("Usage patterns:");
    for (const [kind, sites] of usageByKind) {
      if (kind === "method_call") {
        const methods = [
          ...new Set(sites.map((s) => s.methodName).filter(Boolean)),
        ];
        if (methods.length > 0) {
          lines.push(`  - Methods called: ${methods.join(", ")}`);
        }
      } else if (kind === "property_access") {
        const props = [
          ...new Set(sites.map((s) => s.propertyName).filter(Boolean)),
        ];
        if (props.length > 0) {
          lines.push(`  - Properties accessed: ${props.join(", ")}`);
        }
      } else if (kind === "call") {
        lines.push(`  - Called as function ${sites.length} time(s)`);
      } else {
        const firstSite = sites[0];
        if (firstSite) {
          lines.push(`  - ${kind}: ${firstSite.context}`);
        }
      }
    }
  }

  if (dossier.typeHints.inferredType) {
    lines.push(`Inferred type: ${dossier.typeHints.inferredType}`);
  }

  if (dossier.isExported) {
    lines.push("⚠️ This binding is exported");
  }

  if (dossier.isUnsafe) {
    lines.push(`⚠️ Unsafe: ${dossier.unsafeReason}`);
  }

  return lines.join("\n");
}

/**
 * Formats multiple dossiers for a batch LLM call.
 */
export function formatDossiersForBatch(dossiers: SymbolDossier[]): string {
  return dossiers.map(formatDossierForLLM).join("\n\n---\n\n");
}

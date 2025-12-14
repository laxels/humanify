import { parseAsync } from "@babel/core";
import type { NodePath, Scope } from "@babel/traverse";
import * as babelTraverse from "@babel/traverse";
import * as t from "@babel/types";
import type {
  BindingId,
  BindingKind,
  Reference,
  ReferenceType,
  ScopeId,
  ScopeInfo,
  SymbolAnalysisOptions,
  SymbolAnalysisResult,
  SymbolBinding,
  UsageHint,
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

const DEFAULT_CONTEXT_LINES = 10;

/**
 * Analyzes code to build a complete symbol table with scope information.
 */
export async function analyzeSymbols(
  code: string,
  options: SymbolAnalysisOptions = {},
): Promise<SymbolAnalysisResult> {
  const ast = await parseAsync(code, { sourceType: "unambiguous" });

  if (!ast) {
    throw new Error("Failed to parse code");
  }

  const scopes = new Map<ScopeId, ScopeInfo>();
  const bindings = new Map<BindingId, SymbolBinding>();
  const scopeToIdMap = new Map<Scope, ScopeId>();
  let scopeCounter = 0;
  let bindingCounter = 0;
  let hasDynamicFeatures = false;

  // First pass: build scope tree
  traverse(ast, {
    Scope(path) {
      const scope = path.scope;
      if (scopeToIdMap.has(scope)) return;

      const scopeId = createScopeId(scopeCounter++);
      scopeToIdMap.set(scope, scopeId);

      const parentScope = scope.parent;
      const parentId = parentScope
        ? (scopeToIdMap.get(parentScope) ?? null)
        : null;

      const kind = getScopeKind(path);
      const node = path.node;

      scopes.set(scopeId, {
        id: scopeId,
        parentId,
        kind,
        bindingIds: [],
        childScopeIds: [],
        node,
        start: node.start ?? 0,
        end: node.end ?? 0,
      });

      // Update parent's child list
      if (parentId) {
        const parentInfo = scopes.get(parentId);
        if (parentInfo) {
          parentInfo.childScopeIds.push(scopeId);
        }
      }
    },
  });

  // Second pass: collect bindings and check for dynamic features
  traverse(ast, {
    CallExpression(path) {
      if (
        t.isIdentifier(path.node.callee) &&
        (path.node.callee.name === "eval" ||
          path.node.callee.name === "Function")
      ) {
        hasDynamicFeatures = true;
      }
    },
    WithStatement() {
      hasDynamicFeatures = true;
    },
    BindingIdentifier(path: NodePath<t.Identifier>) {
      const binding = path.scope.getBinding(path.node.name);
      if (!binding) return;

      // Skip if we've already processed this binding
      const scopeId = scopeToIdMap.get(binding.scope);
      if (!scopeId) return;

      const existingBindingId = findExistingBindingId(
        bindings,
        binding,
        scopeId,
      );
      if (existingBindingId) return;

      const bindingId = createBindingId(scopeId, bindingCounter++);
      const kind = getBindingKind(binding);
      const declarationNode = binding.path.node;

      const symbolBinding: SymbolBinding = {
        id: bindingId,
        name: path.node.name,
        kind,
        scopeId,
        declarationNode,
        references: [],
        usageHints: [],
        surroundingCode: "",
        isExported: isBindingExported(binding),
        hasDynamicAccess: false,
      };

      bindings.set(bindingId, symbolBinding);

      // Update scope's binding list
      const scopeInfo = scopes.get(scopeId);
      if (scopeInfo) {
        scopeInfo.bindingIds.push(bindingId);
      }
    },
  });

  // Third pass: collect references and build usage hints
  traverse(ast, {
    Identifier(path) {
      if (isBindingIdentifier(path)) return;

      const binding = path.scope.getBinding(path.node.name);
      if (!binding) return;

      const scopeId = scopeToIdMap.get(binding.scope);
      if (!scopeId) return;

      const bindingId = findExistingBindingId(bindings, binding, scopeId);
      if (!bindingId) return;

      const symbolBinding = bindings.get(bindingId);
      if (!symbolBinding) return;

      const reference = createReference(path);
      symbolBinding.references.push(reference);
    },
  });

  // Build usage hints for each binding
  for (const binding of bindings.values()) {
    binding.usageHints = buildUsageHints(binding.references);
    binding.surroundingCode = extractSurroundingCode(
      binding,
      scopes,
      code,
      options.contextLines ?? DEFAULT_CONTEXT_LINES,
    );
    binding.hasDynamicAccess =
      hasDynamicFeatures && couldBeAffectedByDynamic(binding, scopes);
  }

  // Find root scope
  let rootScopeId: ScopeId | undefined;
  for (const [id, scope] of scopes) {
    if (scope.parentId === null) {
      rootScopeId = id;
      break;
    }
  }

  if (!rootScopeId) {
    throw new Error("No root scope found");
  }

  return {
    scopes,
    bindings,
    rootScopeId,
    hasDynamicFeatures,
    ast,
  };
}

function createScopeId(index: number): ScopeId {
  return `scope_${index}`;
}

function createBindingId(scopeId: ScopeId, index: number): BindingId {
  return `${scopeId}_binding_${index}`;
}

function getScopeKind(path: NodePath): ScopeInfo["kind"] {
  if (path.isProgram()) return "program";
  if (path.isFunction()) return "function";
  if (path.isClass()) return "class";
  if (path.isBlockStatement() || path.isFor() || path.isCatchClause())
    return "block";
  return "block";
}

function getBindingKind(binding: babelTraverse.Binding): BindingKind {
  const path = binding.path;

  if (path.isVariableDeclarator()) {
    const parent = path.parentPath;
    if (parent?.isVariableDeclaration()) {
      const kind = parent.node.kind;
      if (kind === "const") return "const";
      if (kind === "let") return "let";
      return "var";
    }
  }

  if (path.isFunctionDeclaration() || path.isFunctionExpression())
    return "function";
  if (path.isClassDeclaration() || path.isClassExpression()) return "class";
  if (path.isCatchClause()) return "catch";
  if (
    path.isImportSpecifier() ||
    path.isImportDefaultSpecifier() ||
    path.isImportNamespaceSpecifier()
  ) {
    return "import";
  }

  // Function parameters
  if (binding.kind === "param") return "param";

  return "var";
}

function findExistingBindingId(
  bindings: Map<BindingId, SymbolBinding>,
  binding: babelTraverse.Binding,
  scopeId: ScopeId,
): BindingId | undefined {
  for (const [id, symbolBinding] of bindings) {
    if (
      symbolBinding.name === binding.identifier.name &&
      symbolBinding.scopeId === scopeId &&
      symbolBinding.declarationNode === binding.path.node
    ) {
      return id;
    }
  }
  return undefined;
}

function isBindingIdentifier(path: NodePath<t.Identifier>): boolean {
  const parent = path.parent;

  // Declaration sites
  if (t.isVariableDeclarator(parent) && parent.id === path.node) return true;
  if (t.isFunctionDeclaration(parent) && parent.id === path.node) return true;
  if (t.isFunctionExpression(parent) && parent.id === path.node) return true;
  if (t.isClassDeclaration(parent) && parent.id === path.node) return true;
  if (t.isClassExpression(parent) && parent.id === path.node) return true;
  if (t.isCatchClause(parent) && parent.param === path.node) return true;

  // Function parameters
  if (t.isFunction(parent) && parent.params.includes(path.node)) return true;

  // Import specifiers
  if (t.isImportSpecifier(parent) && parent.local === path.node) return true;
  if (t.isImportDefaultSpecifier(parent)) return true;
  if (t.isImportNamespaceSpecifier(parent)) return true;

  // Rest/spread patterns
  if (t.isRestElement(parent) && parent.argument === path.node) return true;

  // Assignment patterns (default values in destructuring)
  if (t.isAssignmentPattern(parent) && parent.left === path.node) return true;

  // Array/object pattern elements
  if (t.isArrayPattern(path.parentPath?.parent)) return true;
  if (t.isObjectPattern(path.parentPath?.parent)) return true;
  if (
    t.isObjectProperty(parent) &&
    parent.value === path.node &&
    t.isObjectPattern(path.parentPath?.parent)
  ) {
    return true;
  }

  return false;
}

function createReference(path: NodePath<t.Identifier>): Reference {
  const parent = path.parent;
  let type: ReferenceType = "read";
  let context: string | undefined;

  // Call expression
  if (t.isCallExpression(parent) && parent.callee === path.node) {
    type = "call";
  }
  // Member expression (property access)
  else if (t.isMemberExpression(parent) && parent.object === path.node) {
    type = "property-access";
    if (t.isIdentifier(parent.property)) {
      context = parent.property.name;
    }
  }
  // Assignment
  else if (t.isAssignmentExpression(parent) && parent.left === path.node) {
    type = "write";
  }
  // Update expression (++, --)
  else if (t.isUpdateExpression(parent)) {
    type = "write";
  }
  // Object shorthand property
  else if (
    t.isObjectProperty(parent) &&
    parent.shorthand &&
    parent.key === path.node
  ) {
    type = "shorthand";
  }
  // Export specifier
  else if (t.isExportSpecifier(parent)) {
    type = "export";
  }

  return {
    node: path.node,
    type,
    context,
  };
}

function buildUsageHints(references: Reference[]): UsageHint[] {
  const hintCounts = new Map<string, number>();

  for (const ref of references) {
    let hint: string;

    switch (ref.type) {
      case "call":
        hint = "called as function";
        break;
      case "property-access":
        hint = ref.context ? `accessed .${ref.context}` : "property accessed";
        break;
      case "write":
        hint = "reassigned";
        break;
      case "shorthand":
        hint = "used in object shorthand";
        break;
      case "export":
        hint = "exported";
        break;
      default:
        hint = "read";
    }

    hintCounts.set(hint, (hintCounts.get(hint) ?? 0) + 1);
  }

  // Group property accesses
  const propertyAccesses = new Map<string, number>();
  for (const ref of references) {
    if (ref.type === "property-access" && ref.context) {
      propertyAccesses.set(
        ref.context,
        (propertyAccesses.get(ref.context) ?? 0) + 1,
      );
    }
  }

  const hints: UsageHint[] = [];

  // Add general hints
  for (const [hint, count] of hintCounts) {
    if (!hint.startsWith("accessed .")) {
      hints.push({ hint, count });
    }
  }

  // Add property access hints (grouped)
  if (propertyAccesses.size > 0) {
    const topProperties = [...propertyAccesses.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    for (const [prop, count] of topProperties) {
      hints.push({ hint: `used with .${prop}`, count });
    }
  }

  return hints.sort((a, b) => b.count - a.count);
}

function extractSurroundingCode(
  binding: SymbolBinding,
  scopes: Map<ScopeId, ScopeInfo>,
  fullCode: string,
  contextLines: number,
): string {
  const scope = scopes.get(binding.scopeId);
  if (!scope) return "";

  // Get the scope's code
  const scopeCode = fullCode.slice(scope.start, scope.end);

  // If scope is small enough, return it all
  const lines = scopeCode.split("\n");
  if (lines.length <= contextLines * 2) {
    return scopeCode;
  }

  // Otherwise, extract around the declaration
  const declarationStart = binding.declarationNode.start ?? scope.start;
  const declarationLine =
    fullCode.slice(scope.start, declarationStart).split("\n").length - 1;

  const startLine = Math.max(0, declarationLine - contextLines);
  const endLine = Math.min(lines.length, declarationLine + contextLines + 1);

  return lines.slice(startLine, endLine).join("\n");
}

function isBindingExported(binding: babelTraverse.Binding): boolean {
  const path = binding.path;

  // Check if directly exported (e.g., export function foo() {})
  if (path.parentPath?.isExportNamedDeclaration()) return true;
  if (path.parentPath?.isExportDefaultDeclaration()) return true;

  // Check for variable declarations (e.g., export const a = 1)
  // Structure: ExportNamedDeclaration > VariableDeclaration > VariableDeclarator
  if (path.isVariableDeclarator()) {
    const grandparent = path.parentPath?.parentPath;
    if (grandparent?.isExportNamedDeclaration()) return true;
  }

  // Check for function/class declarations
  // Structure: ExportNamedDeclaration > FunctionDeclaration/ClassDeclaration
  if (path.isFunctionDeclaration() || path.isClassDeclaration()) {
    if (path.parentPath?.isExportNamedDeclaration()) return true;
    if (path.parentPath?.isExportDefaultDeclaration()) return true;
  }

  // Check if referenced in export specifier (e.g., export { a })
  for (const ref of binding.referencePaths) {
    if (ref.parentPath?.isExportSpecifier()) return true;
    if (ref.parentPath?.isExportDefaultDeclaration()) return true;
  }

  return false;
}

function couldBeAffectedByDynamic(
  binding: SymbolBinding,
  scopes: Map<ScopeId, ScopeInfo>,
): boolean {
  // In presence of eval/with, only local variables that are proven
  // not reachable are safe. For simplicity, we mark all as potentially affected.
  // A more sophisticated analysis could track which scopes contain eval/with.
  const scope = scopes.get(binding.scopeId);
  if (!scope) return true;

  // Program-level bindings are most likely to be affected
  if (scope.kind === "program") return true;

  // Block-scoped variables in nested functions are safer
  if (binding.kind === "let" || binding.kind === "const") {
    return scope.kind !== "function";
  }

  return true;
}

/**
 * Gets all bindings sorted by scope size (largest first).
 * This ensures outer scopes are processed before inner scopes.
 */
export function getBindingsSortedByScopeSize(
  result: SymbolAnalysisResult,
): SymbolBinding[] {
  const bindingsWithScopeSize: [SymbolBinding, number][] = [];

  for (const binding of result.bindings.values()) {
    const scope = result.scopes.get(binding.scopeId);
    if (scope) {
      const scopeSize = scope.end - scope.start;
      bindingsWithScopeSize.push([binding, scopeSize]);
    }
  }

  // Sort by scope size descending
  bindingsWithScopeSize.sort((a, b) => b[1] - a[1]);

  return bindingsWithScopeSize.map(([binding]) => binding);
}

/**
 * Groups bindings by their scope for batched processing.
 */
export function groupBindingsByScope(
  result: SymbolAnalysisResult,
): Map<ScopeId, SymbolBinding[]> {
  const groups = new Map<ScopeId, SymbolBinding[]>();

  for (const binding of result.bindings.values()) {
    const existing = groups.get(binding.scopeId) ?? [];
    existing.push(binding);
    groups.set(binding.scopeId, existing);
  }

  return groups;
}

/**
 * Gets scopes in order from largest to smallest (for processing order).
 */
export function getScopesBySize(result: SymbolAnalysisResult): ScopeInfo[] {
  const scopesWithSize = [...result.scopes.values()].map((scope) => ({
    scope,
    size: scope.end - scope.start,
  }));

  scopesWithSize.sort((a, b) => b.size - a.size);

  return scopesWithSize.map(({ scope }) => scope);
}

import { type NodePath, parseAsync } from "@babel/core";
import type { Binding, Scope } from "@babel/traverse";
import * as babelTraverse from "@babel/traverse";
import type { File, Identifier, Node } from "@babel/types";
import type {
  BindingId,
  BindingInfo,
  DeclarationKind,
  ScopeInfo,
  SymbolTable,
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

/**
 * Creates a unique binding ID from scope UID and binding name.
 */
export function createBindingId(scopeUid: string, name: string): BindingId {
  return `${scopeUid}:${name}`;
}

/**
 * Parses the binding ID back into scope UID and name.
 */
export function parseBindingId(id: BindingId): {
  scopeUid: string;
  name: string;
} {
  const colonIndex = id.indexOf(":");
  if (colonIndex === -1) {
    throw new Error(`Invalid binding ID: ${id}`);
  }
  return {
    scopeUid: id.slice(0, colonIndex),
    name: id.slice(colonIndex + 1),
  };
}

/**
 * Determines the declaration kind from a Babel binding.
 * Note: binding.path is NOT always an Identifier - for class/function declarations,
 * it's the ClassDeclaration/FunctionDeclaration node itself.
 */
export function getDeclarationKind(binding: Binding): DeclarationKind {
  const { kind, path } = binding;
  const parentPath = path.parentPath;

  // First check if binding.path itself is a class/function declaration
  // This is how Babel handles class and function declarations
  if (path.isClassDeclaration() || path.isClassExpression()) {
    return "class";
  }
  if (path.isFunctionDeclaration()) {
    return "function";
  }

  // Handle binding kind
  switch (kind) {
    case "var":
      return "var";
    case "const":
      return "const";
    case "param":
      return "param";
    case "module":
      return "import";
    case "hoisted":
      return "function";
    case "let":
      return "let";
    case "local":
      // Check if it's a class or function expression
      if (path.isFunctionExpression()) {
        return "function";
      }
      return "var";
    default:
      // Check for catch clause
      if (parentPath?.isCatchClause()) {
        return "catch";
      }
      return "var";
  }
}

/**
 * Gets the scope kind from a Babel scope.
 */
export function getScopeKind(
  scope: Scope,
): "program" | "function" | "class" | "block" | "module" {
  const { path } = scope;

  if (path.isProgram()) {
    // Check if it's a module
    const program = path.node;
    if (program.sourceType === "module") {
      return "module";
    }
    return "program";
  }

  if (
    path.isFunction() ||
    path.isFunctionDeclaration() ||
    path.isFunctionExpression() ||
    path.isArrowFunctionExpression()
  ) {
    return "function";
  }

  if (path.isClassDeclaration() || path.isClassExpression()) {
    return "class";
  }

  return "block";
}

/**
 * Gets a human-readable summary of a scope.
 */
export function getScopeSummary(scope: Scope): string {
  const { path } = scope;

  if (path.isProgram()) {
    return "Program";
  }

  if (path.isFunctionDeclaration()) {
    const id = path.node.id;
    return id ? `function ${id.name}` : "anonymous function";
  }

  if (path.isFunctionExpression() || path.isArrowFunctionExpression()) {
    // Try to get name from parent
    const parent = path.parentPath;
    if (parent?.isVariableDeclarator()) {
      const id = parent.node.id;
      if (id.type === "Identifier") {
        return `function ${id.name}`;
      }
    }
    if (parent?.isProperty() || parent?.isObjectProperty()) {
      const key = parent.node.key;
      if (key.type === "Identifier") {
        return `method ${key.name}`;
      }
    }
    return "anonymous function";
  }

  if (path.isClassDeclaration() || path.isClassExpression()) {
    const id = (path.node as { id?: Identifier }).id;
    return id ? `class ${id.name}` : "anonymous class";
  }

  if (path.isBlockStatement()) {
    const parent = path.parentPath;
    if (parent?.isIfStatement()) {
      return "if block";
    }
    if (
      parent?.isForStatement() ||
      parent?.isForInStatement() ||
      parent?.isForOfStatement()
    ) {
      return "for block";
    }
    if (parent?.isWhileStatement() || parent?.isDoWhileStatement()) {
      return "while block";
    }
    if (parent?.isTryStatement()) {
      return "try block";
    }
    if (parent?.isCatchClause()) {
      return "catch block";
    }
  }

  return "block";
}

/**
 * Checks if a scope contains potentially unsafe constructs like eval or with.
 */
export function hasUnsafeConstructs(scope: Scope): {
  unsafe: boolean;
  reason?: string;
} {
  let unsafe = false;
  let reason: string | undefined;

  const checkPath = scope.path;

  // Walk the AST within this scope to find eval/with
  traverse(
    checkPath.node as Node,
    {
      CallExpression(path) {
        const callee = path.node.callee;
        if (callee.type === "Identifier" && callee.name === "eval") {
          unsafe = true;
          reason = "eval() call in scope";
          path.stop();
        }
      },
      WithStatement() {
        unsafe = true;
        reason = "with statement in scope";
      },
      // Also check for Function constructor which can be used like eval
      NewExpression(path) {
        const callee = path.node.callee;
        if (callee.type === "Identifier" && callee.name === "Function") {
          unsafe = true;
          reason = "new Function() in scope";
          path.stop();
        }
      },
    },
    scope,
    undefined,
    checkPath,
  );

  return { unsafe, reason };
}

/**
 * Gets the code string for a scope, truncated if necessary.
 */
export function getScopeCode(scope: Scope, maxLength = 5000): string {
  const code = scope.path.toString();
  if (code.length <= maxLength) {
    return code;
  }
  return code.slice(0, maxLength) + "\n// ... truncated";
}

/**
 * Checks if a binding is exported.
 */
export function isBindingExported(binding: Binding): boolean {
  // Check if the binding's declaration is part of an export
  const declarationPath = binding.path;

  // Direct export: export const x = 1
  // The path structure is: ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > Identifier
  // So we need to check multiple levels up
  let currentPath = declarationPath.parentPath;
  while (currentPath) {
    if (
      currentPath.isExportNamedDeclaration() ||
      currentPath.isExportDefaultDeclaration()
    ) {
      return true;
    }
    // Don't go up past function/class/program boundaries
    if (
      currentPath.isFunction() ||
      currentPath.isClass() ||
      currentPath.isProgram()
    ) {
      break;
    }
    currentPath = currentPath.parentPath;
  }

  // Check all reference paths for export specifiers
  for (const refPath of binding.referencePaths) {
    if (refPath.parentPath?.isExportSpecifier()) {
      return true;
    }
  }

  return false;
}

export type AnalyzeResult = {
  ast: File;
  symbolTable: SymbolTable;
  bindingInfos: Map<BindingId, BindingInfo>;
};

/**
 * Analyzes code and builds a complete symbol table with scope information.
 */
export async function analyzeCode(code: string): Promise<AnalyzeResult> {
  const ast = await parseAsync(code, { sourceType: "unambiguous" });

  if (!ast) {
    throw new Error("Failed to parse code");
  }

  const symbolTable: SymbolTable = {
    bindings: new Map(),
    scopes: new Map(),
    rootScopeId: "",
  };

  const bindingInfos = new Map<BindingId, BindingInfo>();
  const scopeToBindings = new Map<string, BindingId[]>();

  // First pass: collect all scopes and their bindings
  traverse(ast, {
    Scope(path) {
      const scope = path.scope;
      const scopeId = String(scope.uid);

      // Track root scope
      if (path.isProgram()) {
        symbolTable.rootScopeId = scopeId;
      }

      // Get parent scope ID
      const parentId = scope.parent ? String(scope.parent.uid) : null;

      // Create scope info
      const scopeInfo: ScopeInfo = {
        id: scopeId,
        parentId,
        kind: getScopeKind(scope),
        summary: getScopeSummary(scope),
        bindingIds: [],
        code: getScopeCode(scope),
        size: scope.path.node.end! - scope.path.node.start!,
      };

      symbolTable.scopes.set(scopeId, scopeInfo);
      scopeToBindings.set(scopeId, []);
    },
  });

  // Second pass: collect all bindings
  traverse(ast, {
    BindingIdentifier(path: NodePath<Identifier>) {
      const binding = path.scope.getBinding(path.node.name);
      if (!binding) return;

      // Skip if this isn't the actual declaration
      if (binding.identifier !== path.node) return;

      const scopeUid = String(binding.scope.uid);
      const bindingId = createBindingId(scopeUid, path.node.name);

      // Skip if we've already processed this binding
      if (bindingInfos.has(bindingId)) return;

      const info: BindingInfo = {
        path,
        declarationKind: getDeclarationKind(binding),
        scopeUid,
      };

      bindingInfos.set(bindingId, info);

      // Add to scope's binding list
      const scopeBindings = scopeToBindings.get(scopeUid);
      if (scopeBindings) {
        scopeBindings.push(bindingId);
      }
    },
  });

  // Update scope infos with their binding IDs
  for (const [scopeId, bindingIds] of scopeToBindings) {
    const scopeInfo = symbolTable.scopes.get(scopeId);
    if (scopeInfo) {
      scopeInfo.bindingIds = bindingIds;
    }
  }

  return { ast, symbolTable, bindingInfos };
}

/**
 * Gets all scopes sorted by size (largest first).
 * This ensures outer scopes are processed before inner scopes.
 */
export function getScopesSortedBySize(symbolTable: SymbolTable): ScopeInfo[] {
  return Array.from(symbolTable.scopes.values()).sort(
    (a, b) => b.size - a.size,
  );
}

/**
 * Gets all ancestor scope IDs for a given scope.
 */
export function getAncestorScopeIds(
  scopeId: string,
  symbolTable: SymbolTable,
): string[] {
  const ancestors: string[] = [];
  let currentId: string | null = scopeId;

  while (currentId) {
    const scope = symbolTable.scopes.get(currentId);
    if (!scope || !scope.parentId) break;
    ancestors.push(scope.parentId);
    currentId = scope.parentId;
  }

  return ancestors;
}

/**
 * Gets all bindings visible in a scope (including from ancestor scopes).
 */
export function getVisibleBindings(
  scopeId: string,
  symbolTable: SymbolTable,
): BindingId[] {
  const visible: BindingId[] = [];
  const scope = symbolTable.scopes.get(scopeId);

  if (scope) {
    visible.push(...scope.bindingIds);
  }

  const ancestors = getAncestorScopeIds(scopeId, symbolTable);
  for (const ancestorId of ancestors) {
    const ancestorScope = symbolTable.scopes.get(ancestorId);
    if (ancestorScope) {
      visible.push(...ancestorScope.bindingIds);
    }
  }

  return visible;
}

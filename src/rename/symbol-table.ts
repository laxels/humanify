import { type NodePath, parseAsync } from "@babel/core";
import type { ParseResult } from "@babel/parser";
import type { Binding, Scope } from "@babel/traverse";
import * as babelTraverse from "@babel/traverse";
import type { File, Identifier, Node } from "@babel/types";

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

export type DeclarationKind =
  | "var"
  | "let"
  | "const"
  | "function"
  | "class"
  | "param"
  | "catch"
  | "import"
  | "unknown";

export type SymbolId = string;
export type ScopeId = string;

export type SymbolInfo = {
  id: SymbolId;
  name: string;
  declarationKind: DeclarationKind;
  scopeId: ScopeId;
  declarationPath: NodePath<Identifier>;
  binding: Binding;
  references: NodePath<Identifier>[];
  scopeSize: number;
};

export type ScopeInfo = {
  id: ScopeId;
  parentId: ScopeId | null;
  path: NodePath<Node>;
  symbols: SymbolId[];
  childScopes: ScopeId[];
  hasEval: boolean;
  hasWith: boolean;
};

export type SymbolTable = {
  ast: ParseResult<File>;
  symbols: Map<SymbolId, SymbolInfo>;
  scopes: Map<ScopeId, ScopeInfo>;
  rootScopeId: ScopeId;
};

let symbolIdCounter = 0;
let scopeIdCounter = 0;

function generateSymbolId(): SymbolId {
  return `sym_${symbolIdCounter++}`;
}

function generateScopeId(): ScopeId {
  return `scope_${scopeIdCounter++}`;
}

export function resetIdCounters(): void {
  symbolIdCounter = 0;
  scopeIdCounter = 0;
}

export function getDeclarationKind(binding: Binding): DeclarationKind {
  const { kind } = binding;

  // Check the path type first for special declarations
  if (binding.path.isClassDeclaration()) {
    return "class";
  }
  if (binding.path.isFunctionDeclaration()) {
    return "function";
  }

  switch (kind) {
    case "var":
    case "let":
    case "const":
      return kind;
    case "hoisted":
      return "function";
    case "param":
      return "param";
    case "local":
      return "unknown";
    case "module":
      return "import";
    default:
      return "unknown";
  }
}

function getScopeSize(scope: Scope): number {
  const block = scope.block;
  if (block.start != null && block.end != null) {
    return block.end - block.start;
  }
  return 0;
}

function checkForDangerousFeatures(scopePath: NodePath<Node>): {
  hasEval: boolean;
  hasWith: boolean;
} {
  let hasEval = false;
  let hasWith = false;

  // We need to check for eval/with in the immediate scope only,
  // not in nested function/class scopes (those are separate scopes)
  scopePath.traverse({
    CallExpression(path) {
      const callee = path.node.callee;
      if (callee.type === "Identifier" && callee.name === "eval") {
        hasEval = true;
      }
    },
    WithStatement() {
      hasWith = true;
    },
    // Stop traversal when entering a new scope (function/class)
    // because those will be checked separately
    Function(path) {
      path.skip();
    },
    Class(path) {
      path.skip();
    },
  });

  return { hasEval, hasWith };
}

export async function buildSymbolTable(code: string): Promise<SymbolTable> {
  resetIdCounters();

  const ast = await parseAsync(code, { sourceType: "unambiguous" });

  if (!ast) {
    throw new Error("Failed to parse code");
  }

  const symbols = new Map<SymbolId, SymbolInfo>();
  const scopes = new Map<ScopeId, ScopeInfo>();
  const scopePathToId = new Map<NodePath<Node>, ScopeId>();
  const processedBindings = new Set<Binding>(); // Track processed bindings to avoid duplicates
  let rootScopeId: ScopeId | null = null;

  // First pass: collect all scopes
  traverse(ast, {
    Scope(path) {
      const scopeId = generateScopeId();
      scopePathToId.set(path, scopeId);

      if (path.isProgram()) {
        rootScopeId = scopeId;
      }
    },
  });

  // Second pass: build scope tree and collect symbols
  traverse(ast, {
    Scope(path) {
      const scopeId = scopePathToId.get(path);
      if (!scopeId) return;

      const parentPath = path.parentPath?.scope?.path;
      const parentId = parentPath
        ? (scopePathToId.get(parentPath) ?? null)
        : null;

      const { hasEval, hasWith } = checkForDangerousFeatures(path);

      const scopeInfo: ScopeInfo = {
        id: scopeId,
        parentId,
        path,
        symbols: [],
        childScopes: [],
        hasEval,
        hasWith,
      };

      scopes.set(scopeId, scopeInfo);

      if (parentId) {
        const parentScope = scopes.get(parentId);
        if (parentScope) {
          parentScope.childScopes.push(scopeId);
        }
      }

      // Collect bindings for this scope
      const bindings = path.scope.bindings;
      for (const [name, binding] of Object.entries(bindings)) {
        // Skip 'arguments' which is a special binding
        if (name === "arguments") continue;

        // Skip bindings we've already processed (e.g., class names appear in both outer and class scope)
        if (processedBindings.has(binding)) continue;
        processedBindings.add(binding);

        const declarationPath = binding.path;
        let identifierPath: NodePath<Identifier> | null = null;

        if (declarationPath.isIdentifier()) {
          // Direct identifier binding (params, catch clause, etc.)
          identifierPath = declarationPath as NodePath<Identifier>;
        } else if (
          declarationPath.isFunctionDeclaration() ||
          declarationPath.isClassDeclaration()
        ) {
          // Function/class declarations have an `id` property
          const idPath = declarationPath.get("id");
          if (!Array.isArray(idPath) && idPath.isIdentifier()) {
            identifierPath = idPath;
          }
        } else if (declarationPath.isVariableDeclarator()) {
          // Variable declarator - the `id` might be an identifier or a pattern
          const idPath = declarationPath.get("id");
          if (!Array.isArray(idPath) && idPath.isIdentifier()) {
            identifierPath = idPath;
          }
          // For destructuring patterns, we need to find the specific identifier
          // binding.identifier gives us the actual identifier node
        }

        // If we couldn't find the identifier path through the declaration,
        // use the binding's identifier property
        if (!identifierPath && binding.identifier) {
          // We need to find the path to this identifier in the AST
          // The binding.path might be pointing to a pattern, but we can create
          // a temporary reference to the identifier
          const identNode = binding.identifier;
          if (identNode.type === "Identifier") {
            // Try to get the path from the identifier's location
            // For destructuring, binding.path points to the identifier within the pattern
            if (declarationPath.node === identNode) {
              identifierPath = declarationPath as NodePath<Identifier>;
            }
          }
        }

        // Still no path? This can happen with complex patterns
        // In this case, we'll still create the symbol but with a less precise path
        const symbolId = generateSymbolId();
        const symbolInfo: SymbolInfo = {
          id: symbolId,
          name,
          declarationKind: getDeclarationKind(binding),
          scopeId,
          declarationPath:
            identifierPath ||
            (declarationPath as unknown as NodePath<Identifier>),
          binding,
          references: binding.referencePaths.filter(
            (p): p is NodePath<Identifier> => p.isIdentifier(),
          ),
          scopeSize: getScopeSize(path.scope),
        };
        symbols.set(symbolId, symbolInfo);
        scopeInfo.symbols.push(symbolId);
      }
    },
  });

  if (!rootScopeId) {
    throw new Error("No root scope found");
  }

  return {
    ast,
    symbols,
    scopes,
    rootScopeId,
  };
}

export function getSymbolsForScope(
  table: SymbolTable,
  scopeId: ScopeId,
): SymbolInfo[] {
  const scope = table.scopes.get(scopeId);
  if (!scope) return [];

  return scope.symbols
    .map((id) => table.symbols.get(id))
    .filter((s): s is SymbolInfo => s !== undefined);
}

export function getAllSymbolsSortedByScope(table: SymbolTable): SymbolInfo[] {
  const symbols = Array.from(table.symbols.values());
  // Sort by scope size descending (largest first) so outer scopes are processed before inner
  return symbols.sort((a, b) => b.scopeSize - a.scopeSize);
}

export function isSymbolSafeToRename(
  table: SymbolTable,
  symbolId: SymbolId,
): boolean {
  const symbol = table.symbols.get(symbolId);
  if (!symbol) return false;

  // Check if any ancestor scope has eval or with
  let currentScopeId: ScopeId | null = symbol.scopeId;
  while (currentScopeId) {
    const scope = table.scopes.get(currentScopeId);
    if (!scope) break;

    if (scope.hasEval || scope.hasWith) {
      return false;
    }

    currentScopeId = scope.parentId;
  }

  return true;
}

export function getScopeChain(
  table: SymbolTable,
  scopeId: ScopeId,
): ScopeInfo[] {
  const chain: ScopeInfo[] = [];
  let currentId: ScopeId | null = scopeId;

  while (currentId) {
    const scope = table.scopes.get(currentId);
    if (!scope) break;
    chain.push(scope);
    currentId = scope.parentId;
  }

  return chain;
}

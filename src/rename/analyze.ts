import { parseAsync } from "@babel/core";
import * as t from "@babel/types";
import type { Node } from "@babel/types";
import type { Binding, NodePath, Scope } from "../babel-traverse";
import { traverse } from "../babel-traverse";
import type {
  ChunkId,
  ChunkInfo,
  ChunkKind,
  RenamingAnalysis,
  ScopeId,
  SymbolId,
  SymbolInfo,
  SymbolKind,
} from "./types";

export const BABEL_PARSER_PLUGINS: Array<
  | "jsx"
  | "typescript"
  | "classProperties"
  | "classPrivateProperties"
  | "classPrivateMethods"
  | "decorators-legacy"
  | "dynamicImport"
  | "importMeta"
  | "optionalChaining"
  | "nullishCoalescingOperator"
  | "objectRestSpread"
  | "topLevelAwait"
  | "numericSeparator"
  | "bigInt"
  | "privateIn"
  | "logicalAssignment"
  | "exportDefaultFrom"
  | "exportNamespaceFrom"
> = [
  "jsx",
  "typescript",
  "classProperties",
  "classPrivateProperties",
  "classPrivateMethods",
  "decorators-legacy",
  "dynamicImport",
  "importMeta",
  "optionalChaining",
  "nullishCoalescingOperator",
  "objectRestSpread",
  "topLevelAwait",
  "numericSeparator",
  "bigInt",
  "privateIn",
  "logicalAssignment",
  "exportDefaultFrom",
  "exportNamespaceFrom",
];

export function getBabelParseOptions() {
  return {
    sourceType: "unambiguous" as const,
    parserOpts: {
      plugins: BABEL_PARSER_PLUGINS as unknown as any[],
    },
  };
}

export async function analyzeRenaming(
  code: string,
  contextWindowSize: number,
): Promise<RenamingAnalysis> {
  const ast = (await parseAsync(code, getBabelParseOptions())) as Node | null;
  if (!ast) {
    throw new Error("Failed to parse code");
  }

  const taintedScopeIds = findTaintedScopes(ast);

  const symbols = new Map<SymbolId, SymbolInfo>();
  const chunks = new Map<ChunkId, ChunkInfo>();
  const bindingToSymbolId = new Map<Binding, SymbolId>();
  const usedSymbolIds = new Set<string>();

  traverse(ast, {
    BindingIdentifier(path: NodePath<t.Identifier>) {
      const binding = path.scope.getBinding(path.node.name);
      if (!binding) return;
      if (bindingToSymbolId.has(binding)) return;

      const id = computeSymbolId(binding, usedSymbolIds);
      bindingToSymbolId.set(binding, id);

      const declScope = binding.scope;
      const declScopeId = getScopeId(declScope);

      const chunkScope = getChunkRootScope(declScope);
      const chunkId = getChunkId(chunkScope);

      if (!chunks.has(chunkId)) {
        chunks.set(chunkId, {
          id: chunkId,
          kind: getChunkKind(chunkScope),
          scopeId: getScopeId(chunkScope),
          summary: summarizeScope(chunkScope, contextWindowSize),
          symbolIds: [],
        });
      }

      const isTainted = taintedScopeIds.has(declScopeId);
      const exportMeta = getExportMeta(path);

      const symbol: SymbolInfo = {
        id,
        originalName: binding.identifier.name,
        kind: classifySymbolKind(binding),
        binding,
        declIdPath: path,
        declScope,
        declScopeId,
        chunkId,
        isTainted,
        isExported: exportMeta.isExported,
        isDirectlyExportedDeclaration: exportMeta.isDirectlyExportedDeclaration,
        referenceCount: binding.referencePaths.length,
      };

      symbols.set(id, symbol);
      chunks.get(chunkId)!.symbolIds.push(id);
    },
  });

  // Mark symbols that are exported via specifiers (e.g. `export { foo }`)
  traverse(ast, {
    ExportNamedDeclaration(path) {
      if (path.node.declaration) return;
      if (path.node.source) return;

      for (const specifier of path.node.specifiers) {
        if (!t.isExportSpecifier(specifier)) continue;
        if (!t.isIdentifier(specifier.local)) continue;

        const binding = path.scope.getBinding(specifier.local.name);
        if (!binding) continue;

        const symbolId = bindingToSymbolId.get(binding);
        if (!symbolId) continue;

        const sym = symbols.get(symbolId);
        if (sym) {
          sym.isExported = true;
        }
      }
    },
  });

  return {
    ast,
    code,
    symbols,
    chunks,
    bindingToSymbolId,
    taintedScopeIds,
  };
}

function findTaintedScopes(ast: Node): Set<ScopeId> {
  const taintedScopeIds = new Set<ScopeId>();

  const taint = (scope: Scope) => {
    let current: Scope | null = scope;
    while (current) {
      taintedScopeIds.add(getScopeId(current));
      current = current.parent;
    }
  };

  traverse(ast, {
    WithStatement(path) {
      taint(path.scope);
    },
    CallExpression(path) {
      if (isDirectEvalCall(path) || isFunctionConstructorCall(path)) {
        // For `eval`, taint the current scope chain.
        // For `Function(...)`, taint program scope (string code runs in the global scope).
        const scopeToTaint = isFunctionConstructorCall(path)
          ? path.scope.getProgramParent()
          : path.scope;
        taint(scopeToTaint);
      }
    },
    NewExpression(path) {
      if (isFunctionConstructorNew(path)) {
        taint(path.scope.getProgramParent());
      }
    },
  });

  return taintedScopeIds;
}

function isDirectEvalCall(path: NodePath<t.CallExpression>): boolean {
  if (!t.isIdentifier(path.node.callee, { name: "eval" })) return false;
  // If `eval` is locally bound, it's not the global direct-eval.
  return path.scope.getBinding("eval") == null;
}

function isFunctionConstructorCall(path: NodePath<t.CallExpression>): boolean {
  if (!t.isIdentifier(path.node.callee, { name: "Function" })) return false;
  return path.scope.getBinding("Function") == null;
}

function isFunctionConstructorNew(path: NodePath<t.NewExpression>): boolean {
  if (!t.isIdentifier(path.node.callee, { name: "Function" })) return false;
  return path.scope.getBinding("Function") == null;
}

function getExportMeta(path: NodePath<t.Identifier>): {
  isExported: boolean;
  isDirectlyExportedDeclaration: boolean;
} {
  const exportNamed = path.findParent((p) => p.isExportNamedDeclaration());
  if (exportNamed?.isExportNamedDeclaration() && exportNamed.node.declaration) {
    return { isExported: true, isDirectlyExportedDeclaration: true };
  }

  const exportDefault = path.findParent((p) => p.isExportDefaultDeclaration());
  if (exportDefault?.isExportDefaultDeclaration()) {
    return { isExported: true, isDirectlyExportedDeclaration: false };
  }

  return { isExported: false, isDirectlyExportedDeclaration: false };
}

function classifySymbolKind(binding: Binding): SymbolKind {
  if (binding.kind === "param") return "param";
  if (binding.kind === "module") return "import";
  if (binding.kind === "const") return "const";
  if (binding.kind === "let") return "let";
  if (binding.kind === "var") return "var";

  if (
    binding.path.isFunctionDeclaration() ||
    binding.path.isFunctionExpression() ||
    binding.path.isArrowFunctionExpression()
  ) {
    return "function";
  }

  if (binding.path.isClassDeclaration() || binding.path.isClassExpression()) {
    return "class";
  }

  if (binding.path.isCatchClause()) return "catch";

  return "unknown";
}

function getScopeId(scope: Scope): ScopeId {
  return `s${scope.uid}`;
}

function getChunkRootScope(scope: Scope): Scope {
  // Prefer the nearest function scope. If none, fall back to the program scope.
  return scope.getFunctionParent() ?? scope.getProgramParent();
}

function getChunkId(scope: Scope): ChunkId {
  return `c${scope.uid}`;
}

function getChunkKind(scope: Scope): ChunkKind {
  if (scope.path.isProgram()) return "program";
  if (scope.path.isFunction()) return "function";
  if (scope.path.isClassDeclaration() || scope.path.isClassExpression())
    return "class";
  return "program";
}

function summarizeScope(scope: Scope, contextWindowSize: number): string {
  const path = scope.path;
  let header = "Scope";
  if (path.isProgram()) {
    header = "Program scope (top-level)";
  } else if (path.isFunction()) {
    const fn: any = path.node as any;
    const name = typeof fn?.id?.name === "string" ? fn.id.name : undefined;
    header = name ? `Function scope: ${name}` : "Function scope";
  } else if (path.isClassDeclaration() || path.isClassExpression()) {
    const cls: any = path.node as any;
    const name = typeof cls?.id?.name === "string" ? cls.id.name : undefined;
    header = name ? `Class scope: ${name}` : "Class scope";
  }

  const raw = path.toString();
  const truncated =
    raw.length <= contextWindowSize
      ? raw
      : `${raw.slice(0, contextWindowSize)}…`;

  return `${header}\n\n${truncated}`;
}

function computeSymbolId(binding: Binding, used: Set<string>): SymbolId {
  const start = binding.identifier.start ?? -1;
  const end = binding.identifier.end ?? -1;

  let id = `b${binding.scope.uid}:${start}:${end}:${binding.kind}`;
  if (!used.has(id)) {
    used.add(id);
    return id;
  }

  let i = 1;
  while (used.has(`${id}:${i}`)) i++;
  id = `${id}:${i}`;
  used.add(id);
  return id;
}
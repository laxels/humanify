import { parseAsync } from "@babel/core";
import type { Identifier, Node } from "@babel/types";
import * as t from "@babel/types";
import {
  type Binding,
  type NodePath,
  type Scope,
  traverse,
} from "../babel-traverse";
import type {
  DeclarationKind,
  NameStyle,
  ScopeChunkId,
  SymbolId,
} from "./types";

export type ScopeChunk = {
  id: ScopeChunkId;
  scopeUid: number;
  type: "program" | "function" | "class";
  path: NodePath<Node>;
  start: number;
};

export type ExportedDeclarationRecord = {
  exportNode: t.ExportNamedDeclaration;
  exportedBindings: Array<{
    identifier: Identifier; // node identity is stable across renames
    exportedName: string; // original exported name (must be preserved)
  }>;
};

export type SymbolInfo = {
  id: SymbolId;
  originalName: string;

  binding: Binding;
  bindingIdentifierPath: NodePath<t.Identifier>;
  bindingIdentifier: Identifier;

  declarationKind: DeclarationKind;
  nameStyle: NameStyle;

  declaringScope: Scope;
  declaringScopeUid: number;

  chunkId: ScopeChunkId;

  isConstant: boolean;
  isExported: boolean;
  isImported: boolean;
  isUnsafeToRename: boolean;

  start: number;
};

export type AnalyzedCode = {
  ast: Node;
  symbols: SymbolInfo[];
  chunks: ScopeChunk[];

  // For reference-resolution lookups during AST safety rewrites:
  bindingToSymbolId: WeakMap<Binding, SymbolId>;
  bindingIdentifierToSymbolId: WeakMap<Identifier, SymbolId>;

  // Needed to preserve named-export interfaces:
  exportDeclarationRecords: ExportedDeclarationRecord[];

  // Useful for diagnostics/tests:
  unsafeScopeUids: Set<number>;
};

export async function analyzeCode(code: string): Promise<AnalyzedCode> {
  const ast = await parseAsync(code, { sourceType: "unambiguous" });
  if (!ast) {
    throw new Error("Failed to parse code");
  }

  const unsafeScopeUids = findUnsafeScopeUids(ast);

  const {
    exportDeclarationRecords,
    exportedBindingIdentifiers,
    exportedBindings,
  } = analyzeExports(ast);

  const symbols: SymbolInfo[] = [];
  const bindingToSymbolId = new WeakMap<Binding, SymbolId>();
  const bindingIdentifierToSymbolId = new WeakMap<Identifier, SymbolId>();
  const chunksByUid = new Map<number, ScopeChunk>();

  let nextSymbolId = 1;

  traverse(ast, {
    Program(path) {
      // Ensure the root Program chunk always exists, even if there are no top-level bindings.
      // The renaming job planner starts from this Program chunk.
      ensureChunk(path.scope, chunksByUid);
    },

    BindingIdentifier(path: NodePath<t.Identifier>) {
      const binding = resolveBindingForIdentifierPath(path);
      if (!binding) return;

      if (bindingToSymbolId.has(binding)) return;

      const id: SymbolId = `sym_${nextSymbolId++}`;
      bindingToSymbolId.set(binding, id);
      bindingIdentifierToSymbolId.set(binding.identifier, id);

      const declaringScope = binding.scope;
      const declaringScopeUid = declaringScope.uid;

      const chunkScope = getChunkScope(declaringScope);
      const chunk = ensureChunk(chunkScope, chunksByUid);

      const declarationKind = inferDeclarationKind(binding);
      const isImported = isImportBinding(binding);
      const isExported =
        exportedBindings.has(binding) ||
        exportedBindingIdentifiers.has(binding.identifier);

      const isUnsafeToRename = unsafeScopeUids.has(declaringScopeUid);
      const isConstant = Boolean(binding.constant);

      const nameStyle = inferNameStyle({
        binding,
        isConstant,
        isClass: isClassBinding(binding),
        declarationKind,
        declaringScope,
      });

      const start = binding.identifier.start ?? path.node.start ?? 0;

      symbols.push({
        id,
        originalName: binding.identifier.name,

        binding,
        bindingIdentifierPath: path,
        bindingIdentifier: binding.identifier,

        declarationKind,
        nameStyle,

        declaringScope,
        declaringScopeUid,

        chunkId: chunk.id,

        isConstant,
        isExported,
        isImported,
        isUnsafeToRename,

        start,
      });
    },
  });

  // Deterministic ordering for repeatable test expectations.
  symbols.sort((a, b) => a.start - b.start);

  const chunks = [...chunksByUid.values()].sort((a, b) => a.start - b.start);

  return {
    ast,
    symbols,
    chunks,
    bindingToSymbolId,
    bindingIdentifierToSymbolId,
    exportDeclarationRecords,
    unsafeScopeUids,
  };
}

function ensureChunk(
  scope: Scope,
  chunksByUid: Map<number, ScopeChunk>,
): ScopeChunk {
  const existing = chunksByUid.get(scope.uid);
  if (existing) return existing;

  const type = scope.path.isProgram()
    ? "program"
    : scope.path.isFunction()
      ? "function"
      : scope.path.isClass()
        ? "class"
        : "function";

  const start = scope.path.node.start ?? 0;

  const chunk: ScopeChunk = {
    id: `chunk_${scope.uid}`,
    scopeUid: scope.uid,
    type,
    path: scope.path as unknown as NodePath<Node>,
    start,
  };
  chunksByUid.set(scope.uid, chunk);
  return chunk;
}

function isChunkScopePath(path: NodePath<Node>): boolean {
  return path.isProgram() || path.isFunction() || path.isClass();
}

function getChunkScope(scope: Scope): Scope {
  let current: Scope = scope;
  while (
    current.parent &&
    !isChunkScopePath(current.path as unknown as NodePath<Node>)
  ) {
    current = current.parent;
  }
  return current;
}

function isClassBinding(binding: Binding): boolean {
  return binding.path.isClassDeclaration() || binding.path.isClassExpression();
}

function isImportBinding(binding: Binding): boolean {
  return (
    binding.kind === "module" ||
    binding.path.isImportSpecifier() ||
    binding.path.isImportDefaultSpecifier() ||
    binding.path.isImportNamespaceSpecifier()
  );
}

function inferDeclarationKind(binding: Binding): DeclarationKind {
  if (binding.kind === "param") return "param";
  if (binding.kind === "module") return "import";

  if (
    binding.path.isFunctionDeclaration() ||
    binding.path.isFunctionExpression()
  ) {
    return "function";
  }
  if (binding.path.isClassDeclaration() || binding.path.isClassExpression()) {
    return "class";
  }

  // Variable declarators: determine const/let/var from parent VariableDeclaration.
  if (binding.path.isVariableDeclarator()) {
    const parent = binding.path.parentPath;
    if (parent?.isVariableDeclaration()) {
      if (parent.node.kind === "const") return "const";
      if (parent.node.kind === "let") return "let";
      if (parent.node.kind === "var") return "var";
    }
  }

  // Catch clause bindings (catch (e) { ... })
  if (binding.path.isCatchClause()) {
    return "catch";
  }

  return "unknown";
}

function isPrimitiveConstLiteral(binding: Binding): boolean {
  if (!binding.path.isVariableDeclarator()) return false;

  const decl = binding.path.parentPath;
  if (!decl?.isVariableDeclaration() || decl.node.kind !== "const")
    return false;

  const init = binding.path.node.init;
  if (!init) return false;

  if (
    t.isStringLiteral(init) ||
    t.isNumericLiteral(init) ||
    t.isBooleanLiteral(init) ||
    t.isNullLiteral(init) ||
    t.isBigIntLiteral(init)
  ) {
    return true;
  }

  if (t.isTemplateLiteral(init) && init.expressions.length === 0) {
    return true;
  }

  return false;
}

function inferNameStyle({
  binding,
  isConstant,
  isClass,
  declarationKind,
  declaringScope,
}: {
  binding: Binding;
  isConstant: boolean;
  isClass: boolean;
  declarationKind: DeclarationKind;
  declaringScope: Scope;
}): NameStyle {
  if (isClass || declarationKind === "class") return "pascal";

  // Conservative "constant" detection:
  // - only top-level primitive-literal consts
  // - and only when they are directly exported as a declaration (`export const ...`)
  //
  // This avoids forcing ALL_CAPS for values that are exported via specifiers
  // (`const a = 1; export { a };`) where the intent is less clear.
  const isTopLevel = declaringScope.path.isProgram();
  const looksLikeConstant =
    isTopLevel &&
    isConstant &&
    isPrimitiveConstLiteral(binding) &&
    isDirectlyExportedDeclaration(binding);

  if (looksLikeConstant) return "upper_snake";
  return "camel";
}

function isDirectlyExportedDeclaration(binding: Binding): boolean {
  // `export const a = ...`
  if (binding.path.isVariableDeclarator()) {
    const varDecl = binding.path.parentPath;
    const exportDecl = varDecl?.parentPath;

    if (
      varDecl?.isVariableDeclaration() &&
      exportDecl?.isExportNamedDeclaration() &&
      exportDecl.node.declaration === varDecl.node
    ) {
      return true;
    }
  }

  // `export function foo() {}` / `export class Foo {}`
  if (
    binding.path.isFunctionDeclaration() ||
    binding.path.isClassDeclaration()
  ) {
    const exportDecl = binding.path.parentPath;

    if (
      exportDecl?.isExportNamedDeclaration() &&
      exportDecl.node.declaration === binding.path.node
    ) {
      return true;
    }
  }

  return false;
}

function resolveBindingForIdentifierPath(
  path: NodePath<t.Identifier>,
): Binding | null {
  const name = path.node.name;

  // Try the most likely binding first.
  const direct = path.scope.getBinding(name);
  if (direct && isSameIdentifierNode(direct.identifier, path.node)) {
    return direct;
  }

  // Be defensive: walk parents and match by node identity/range if needed.
  let scope: Scope | null = path.scope;
  while (scope) {
    const binding = scope.getBinding(name);
    if (binding && isSameIdentifierNode(binding.identifier, path.node)) {
      return binding;
    }
    scope = scope.parent;
  }

  return direct ?? null;
}

function isSameIdentifierNode(a: Identifier, b: Identifier): boolean {
  if (a === b) return true;
  if (a.start != null && b.start != null && a.end != null && b.end != null) {
    return a.start === b.start && a.end === b.end;
  }
  return false;
}

function analyzeExports(ast: Node): {
  exportDeclarationRecords: ExportedDeclarationRecord[];
  exportedBindingIdentifiers: WeakSet<Identifier>;
  exportedBindings: WeakSet<Binding>;
} {
  const exportDeclarationRecords: ExportedDeclarationRecord[] = [];
  const exportedBindingIdentifiers = new WeakSet<Identifier>();
  const exportedBindings = new WeakSet<Binding>();

  traverse(ast, {
    ExportNamedDeclaration(path) {
      // `export const a = ...` / `export function a() {}` / `export class A {}`
      if (path.node.declaration) {
        const declPath = path.get("declaration") as NodePath<t.Declaration>;
        const outer = declPath.getOuterBindingIdentifiers();
        const ids = Object.values(outer).filter((n): n is Identifier =>
          t.isIdentifier(n),
        );

        const exportedBindingsForNode = ids.map((identifier) => {
          exportedBindingIdentifiers.add(identifier);
          return { identifier, exportedName: identifier.name };
        });

        exportDeclarationRecords.push({
          exportNode: path.node,
          exportedBindings: exportedBindingsForNode,
        });

        return;
      }

      // `export { local as exported }` (local export)
      if (path.node.source == null) {
        const specifierPaths = path.get("specifiers");
        for (const sp of specifierPaths) {
          if (!sp.isExportSpecifier()) continue;
          const local = sp.get("local");
          if (!local.isIdentifier()) continue;

          const binding = path.scope.getBinding(local.node.name);
          if (binding) {
            exportedBindings.add(binding);
          }
        }
      }
    },
  });

  return {
    exportDeclarationRecords,
    exportedBindingIdentifiers,
    exportedBindings,
  };
}

function findUnsafeScopeUids(ast: Node): Set<number> {
  const unsafe = new Set<number>();

  const markScopeAndParents = (scope: Scope) => {
    let current: Scope | null = scope;
    while (current) {
      unsafe.add(current.uid);
      current = current.parent;
    }
  };

  traverse(ast, {
    WithStatement(path) {
      markScopeAndParents(path.scope);
    },

    CallExpression(path) {
      // Direct eval is the classic "renaming unsafe" footgun.
      if (t.isIdentifier(path.node.callee, { name: "eval" })) {
        // If `eval` is locally bound, it's not the global eval.
        const isLocallyBound = path.scope.getBinding("eval") != null;
        if (!isLocallyBound) {
          markScopeAndParents(path.scope);
        }
      }

      // setTimeout("...") / setInterval("...") are also string-eval in many runtimes.
      if (
        t.isIdentifier(path.node.callee, { name: "setTimeout" }) ||
        t.isIdentifier(path.node.callee, { name: "setInterval" })
      ) {
        const arg0 = path.node.arguments[0];
        if (t.isStringLiteral(arg0)) {
          const isLocallyBound =
            path.scope.getBinding(path.node.callee.name) != null;
          if (!isLocallyBound) {
            markScopeAndParents(path.scope);
          }
        }
      }
    },
  });

  return unsafe;
}

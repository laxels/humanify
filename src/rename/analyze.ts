import { type NodePath, parseAsync } from "@babel/core";
import * as babelTraverse from "@babel/traverse";
import type { Identifier, Node } from "@babel/types";
import * as t from "@babel/types";
import { verbose } from "../verbose";
import type { NamingUnit, RenameSymbol, ScopeMeta, SymbolKind } from "./types";

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

export type RenameAnalysis = {
  ast: Node;
  symbols: RenameSymbol[];
  units: NamingUnit[];
  scopeMetaById: Map<string, ScopeMeta>;
  unsafeScopeIds: Set<string>;
};

export async function analyzeCodeForRenaming(
  code: string,
  contextWindowSize: number,
): Promise<RenameAnalysis> {
  const ast = await parseAsync(code, { sourceType: "unambiguous" });
  if (!ast) {
    throw new Error("Failed to parse code");
  }

  // Prepass 1: Expand object/destucturing shorthand so renaming can't change runtime keys.
  // `{a}`      -> `{a: a}`
  // `{a} = obj` -> `{a: a} = obj`
  traverse(ast, {
    ObjectProperty(path) {
      const node = path.node;
      if (!node.shorthand) return;
      if (node.computed) return;
      if (!t.isIdentifier(node.key)) return;

      node.shorthand = false;
      // Ensure the key is a fresh node so renaming the value identifier does not
      // mutate the printed key.
      node.key = t.identifier(node.key.name);
    },
  });

  // Prepass 2: Split exported declarations so local renames keep the public export name.
  // `export const a = 1;` -> `const a = 1; export { a };`
  traverse(ast, {
    ExportNamedDeclaration(path) {
      if (!path.node.declaration) return;

      const decl = path.node.declaration;
      const bindings = t.getBindingIdentifiers(decl);
      const names = Object.keys(bindings);

      if (names.length === 0) return;

      const specifiers = names.map((name) =>
        t.exportSpecifier(t.identifier(name), t.identifier(name)),
      );

      const exportDecl = t.exportNamedDeclaration(null, specifiers, null);
      exportDecl.exportKind = path.node.exportKind;

      path.replaceWithMultiple([decl as any, exportDecl]);
      path.skip();
    },
  });

  // Re-crawl scopes after structural transformations.
  let programPath: NodePath<any> | undefined;
  traverse(ast, {
    Program(path) {
      programPath = path;
      path.stop();
    },
  });

  if (!programPath) {
    throw new Error("Failed to locate Program path");
  }

  programPath.scope.crawl();

  // Scope ID registry + metadata (used by the constraint solver).
  const scopeMetaById = new Map<string, ScopeMeta>();
  const scopeIds = new WeakMap<any, string>();
  let scopeCounter = 0;

  const getScopeId = (scope: any): string => {
    const existing = scopeIds.get(scope);
    if (existing) return existing;

    const id = `S${scopeCounter++}`;
    scopeIds.set(scope, id);

    const parent = scope.parent;
    const parentId = parent ? getScopeId(parent) : undefined;
    const depth = parentId ? (scopeMetaById.get(parentId)?.depth ?? 0) + 1 : 0;

    scopeMetaById.set(id, { id, scope, parentId, depth });
    return id;
  };

  const unsafeScopeIds = new Set<string>();
  const programScopeId = getScopeId(programPath.scope);

  const markUnsafeScopeChain = (scope: any) => {
    let s: any | null | undefined = scope;
    while (s) {
      unsafeScopeIds.add(getScopeId(s));
      s = s.parent;
    }
  };

  const sourceType: "module" | "script" | undefined = (ast as any).program
    ?.sourceType;

  traverse(ast, {
    WithStatement(path) {
      verbose.log(`Detected 'with' statement; marking scope chain unsafe`);
      markUnsafeScopeChain(path.scope);
    },
    CallExpression(path) {
      const callee = path.node.callee;

      // Direct eval: `eval("...")` and `eval` is not shadowed by a local binding.
      if (t.isIdentifier(callee, { name: "eval" })) {
        const shadowed = path.scope.getBinding("eval") != null;
        if (!shadowed) {
          verbose.log(`Detected direct eval(); marking scope chain unsafe`);
          markUnsafeScopeChain(path.scope);
        }
      }

      // `Function("...")` constructor call evaluates strings in the global scope.
      // It can't see module scope (sourceType=module), but for scripts this may
      // reference globals by name. Be conservative for scripts.
      if (t.isIdentifier(callee, { name: "Function" })) {
        const shadowed = path.scope.getBinding("Function") != null;
        if (!shadowed && sourceType === "script") {
          unsafeScopeIds.add(programScopeId);
        }
      }
    },
    NewExpression(path) {
      const callee = path.node.callee;

      // `new Function("...")` evaluates strings in the global scope (not module scope).
      if (t.isIdentifier(callee, { name: "Function" })) {
        const shadowed = path.scope.getBinding("Function") != null;
        if (!shadowed && sourceType === "script") {
          unsafeScopeIds.add(programScopeId);
        }
      }
    },
  });

  const bindingPaths: NodePath<Identifier>[] = [];
  traverse(ast, {
    BindingIdentifier(path: NodePath<Identifier>) {
      bindingPaths.push(path);
    },
  });

  bindingPaths.sort((a, b) => {
    const sa = a.node.start ?? 0;
    const sb = b.node.start ?? 0;
    if (sa !== sb) return sa - sb;

    const ea = a.node.end ?? 0;
    const eb = b.node.end ?? 0;
    return ea - eb;
  });

  const unitsById = new Map<string, NamingUnit>();
  const symbols: RenameSymbol[] = [];

  for (let i = 0; i < bindingPaths.length; i++) {
    const bindingPath = bindingPaths[i]!;
    const originalName = bindingPath.node.name;

    const binding = bindingPath.scope.getBinding(originalName);
    const kind: SymbolKind = inferSymbolKind(binding);

    const unitPath = findNamingUnitPath(bindingPath);
    const unitKind = inferUnitKind(unitPath);
    const unitId = nodeKey(unitPath.node);

    const scopeId = getScopeId(bindingPath.scope);

    const refCount =
      (binding?.referencePaths?.length as number | undefined) ?? 0;
    const writeCount =
      (binding?.constantViolations?.length as number | undefined) ?? 0;

    let importance = refCount + writeCount * 2;
    if (kind === "function" || kind === "class") importance += 5;
    if (kind === "param") importance += 1;

    const symbol: RenameSymbol = {
      id: `sym_${i}`,
      originalName,
      kind,
      bindingPath,
      binding,
      scope: bindingPath.scope,
      scopeId,
      unitId,
      unitKind,
      unitPath,
      importance,
    };

    symbols.push(symbol);

    if (!unitsById.has(unitId)) {
      const snippet = truncate(
        unitPath.toString(),
        Math.max(200, contextWindowSize),
      );
      unitsById.set(unitId, {
        id: unitId,
        kind: unitKind,
        displayName: getUnitDisplayName(unitPath),
        snippet,
        symbols: [],
      });
    }
    unitsById.get(unitId)!.symbols.push(symbol);
  }

  const units = Array.from(unitsById.values()).sort((a, b) => {
    const pa = a.symbols[0]?.unitPath?.node?.start ?? 0;
    const pb = b.symbols[0]?.unitPath?.node?.start ?? 0;
    return pa - pb;
  });

  for (const unit of units) {
    unit.symbols.sort((a, b) => {
      const sa = a.bindingPath.node.start ?? 0;
      const sb = b.bindingPath.node.start ?? 0;
      if (sa !== sb) return sa - sb;
      return a.id.localeCompare(b.id);
    });
  }

  return {
    ast: ast as unknown as Node,
    symbols,
    units,
    scopeMetaById,
    unsafeScopeIds,
  };
}

function inferSymbolKind(binding: any): SymbolKind {
  if (!binding) return "unknown";

  const p = binding.path;

  if (p?.isFunctionDeclaration?.() || p?.isFunctionExpression?.())
    return "function";
  if (p?.isClassDeclaration?.() || p?.isClassExpression?.()) return "class";
  if (p?.isCatchClause?.()) return "catch";

  switch (binding.kind) {
    case "param":
      return "param";
    case "module":
      return "import";
    case "const":
      return "const";
    case "let":
      return "let";
    case "var":
      return "var";
    case "hoisted":
      // Usually function declarations.
      return "function";
    default:
      return "unknown";
  }
}

function findNamingUnitPath(path: NodePath<Identifier>): NodePath<Node> {
  const unit = path.findParent((p) => {
    return (
      p.isProgram() ||
      p.isFunction() ||
      p.isClassDeclaration() ||
      p.isClassExpression()
    );
  }) as NodePath<Node> | null;

  return (unit ?? path.scope.path) as NodePath<Node>;
}

function inferUnitKind(unitPath: NodePath<Node>): NamingUnit["kind"] {
  if (unitPath.isProgram()) return "program";
  if (unitPath.isClassDeclaration() || unitPath.isClassExpression())
    return "class";
  return "function";
}

function getUnitDisplayName(unitPath: NodePath<Node>): string | undefined {
  if (unitPath.isProgram()) return undefined;

  if (unitPath.isClassDeclaration() || unitPath.isClassExpression()) {
    const id = (unitPath.node as any).id;
    return t.isIdentifier(id) ? id.name : undefined;
  }

  if (unitPath.isFunctionDeclaration() || unitPath.isFunctionExpression()) {
    const id = (unitPath.node as any).id;
    return t.isIdentifier(id) ? id.name : undefined;
  }

  if (unitPath.isArrowFunctionExpression()) {
    const parent = unitPath.parentPath;
    if (parent?.isVariableDeclarator() && t.isIdentifier(parent.node.id)) {
      return parent.node.id.name;
    }
    if (parent?.isAssignmentExpression() && t.isIdentifier(parent.node.left)) {
      return parent.node.left.name;
    }
    return undefined;
  }

  if (
    (unitPath as any).isObjectMethod?.() ||
    (unitPath as any).isClassMethod?.()
  ) {
    const key = (unitPath.node as any).key;
    if (t.isIdentifier(key)) return key.name;
    if (t.isStringLiteral(key)) return key.value;
    return undefined;
  }

  return undefined;
}

function nodeKey(node: t.Node): string {
  return `${node.type}:${node.start ?? "?"}:${node.end ?? "?"}`;
}

function truncate(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n/* …truncated… */`;
}

import { transformFromAstAsync } from "@babel/core";
import * as t from "@babel/types";
import type { Node } from "@babel/types";
import { traverse } from "../babel-traverse";
import type { RenamingAnalysis, RenamePlan, SymbolId } from "./types";

export async function applyRenamePlan(
  analysis: RenamingAnalysis,
  plan: RenamePlan,
): Promise<string> {
  // 1) Fix shorthand object properties/patterns for any symbol that will be renamed.
  const renamedSymbolIds = new Set<SymbolId>();
  for (const [id, newName] of plan.entries()) {
    const sym = analysis.symbols.get(id);
    if (!sym) continue;
    if (newName !== sym.originalName && !sym.isTainted) {
      renamedSymbolIds.add(id);
    }
  }

  if (renamedSymbolIds.size > 0) {
    preserveObjectShorthandKeys(analysis, plan);
  }

  // 2) Apply renames via Babel scope.rename (binding-aware rename).
  for (const sym of analysis.symbols.values()) {
    const newName = plan.get(sym.id);
    if (!newName) continue;
    if (sym.isTainted) continue;
    if (newName === sym.originalName) continue;

    sym.binding.scope.rename(sym.originalName, newName);
  }

  // 3) Preserve module export names for `export <declaration>` when we renamed the local binding.
  preserveDirectExportDeclarationNames(analysis, plan);

  // 4) Generate code.
  return await stringifyAst(analysis.ast, analysis.code);
}

function preserveObjectShorthandKeys(analysis: RenamingAnalysis, plan: RenamePlan) {
  traverse(analysis.ast, {
    ObjectProperty(path) {
      if (!path.node.shorthand) return;

      // Handle:
      //   - ObjectExpression shorthand: { a }
      //   - ObjectPattern shorthand:   const { a } = obj;
      //   - ObjectPattern default:    const { a = 1 } = obj;
      const valueNode = path.node.value;

      let bindingName: string | undefined;
      if (t.isIdentifier(valueNode)) {
        bindingName = valueNode.name;
      } else if (t.isAssignmentPattern(valueNode) && t.isIdentifier(valueNode.left)) {
        bindingName = valueNode.left.name;
      } else {
        return;
      }

      const binding = path.scope.getBinding(bindingName);
      if (!binding) return;

      const symbolId = analysis.bindingToSymbolId.get(binding);
      if (!symbolId) return;

      const sym = analysis.symbols.get(symbolId);
      if (!sym) return;

      const newName = plan.get(symbolId);
      if (!newName) return;
      if (sym.isTainted) return;
      if (newName === sym.originalName) return;

      // Important: In `{ a }` and `{ a } = obj` (object pattern), the property key is the identifier name.
      // If we rename `a -> userId` and keep shorthand, we change the runtime property key.
      // Fix: rewrite to `{ a: userId }` by cloning the key node and disabling shorthand.
      path.node.shorthand = false;
      path.node.key = t.identifier(bindingName);
      // value stays as-is and will be renamed by scope.rename.
    },
  });
}

function preserveDirectExportDeclarationNames(
  analysis: RenamingAnalysis,
  plan: RenamePlan,
) {
  traverse(analysis.ast, {
    ExportNamedDeclaration(path) {
      if (!path.node.declaration) return;

      // Only rewrite if at least one declared symbol was renamed.
      const declared = t.getBindingIdentifiers(path.node.declaration);
      const specifiers: t.ExportSpecifier[] = [];
      let needsRewrite = false;

      for (const [currentLocalName] of Object.entries(declared)) {
        const binding = path.scope.getBinding(currentLocalName);
        if (!binding) continue;

        const symbolId = analysis.bindingToSymbolId.get(binding);
        if (!symbolId) continue;

        const sym = analysis.symbols.get(symbolId);
        if (!sym) continue;

        const planned = plan.get(symbolId) ?? sym.originalName;
        const exportedName = sym.originalName;

        specifiers.push(
          t.exportSpecifier(t.identifier(planned), t.identifier(exportedName)),
        );

        if (planned !== exportedName) {
          needsRewrite = true;
        }
      }

      if (!needsRewrite) return;

      const decl = path.node.declaration;
      const exportSpec = t.exportNamedDeclaration(null, specifiers, null);

      path.replaceWithMultiple([decl, exportSpec]);
      path.skip();
    },
  });
}

async function stringifyAst(ast: Node, code: string): Promise<string> {
  const result = await transformFromAstAsync(ast, code, {
    babelrc: false,
    configFile: false,
    compact: false,
    minified: false,
    comments: false,
    sourceMaps: false,
    retainLines: false,
  });

  if (!result?.code) {
    throw new Error("Failed to stringify code");
  }
  return result.code;
}
import * as t from "@babel/types";
import type { Identifier, Node } from "@babel/types";
import { traverse, type Binding, type NodePath } from "../babel-traverse";
import type { ExportedDeclarationRecord } from "./symbol-analysis";
import type { ScopeId, SymbolId } from "./types";

/**
 * Make imported/exported *names* robust against accidental renaming if the parser
 * ever shares Identifier node objects between local/exported/imported fields.
 *
 * This does not change semantics.
 */
export function detachModuleInterfaceNames(ast: Node) {
  traverse(ast, {
    ImportSpecifier(path: NodePath<t.ImportSpecifier>) {
      // imported: Identifier | StringLiteral (for some syntaxes)
      if (t.isIdentifier(path.node.imported)) {
        path.node.imported = t.identifier(path.node.imported.name);
      }
    },

    ExportSpecifier(path: NodePath<t.ExportSpecifier>) {
      // exported: Identifier | StringLiteral
      if (t.isIdentifier(path.node.exported)) {
        path.node.exported = t.identifier(path.node.exported.name);
      }
    },
  });
}

/**
 * Renaming a binding used in object shorthand changes runtime object shapes:
 *   {a} becomes {userId} after renaming a -> userId.
 *
 * Fix by expanding shorthand to preserve the original key:
 *   {a} -> {a: userId}
 *   const {a} = obj -> const {a: userId} = obj
 */
export function expandRenamedObjectShorthands({
  ast,
  bindingToSymbolId,
  bindingIdentifierToSymbolId,
  renamePlan,
  originalNameBySymbolId,
}: {
  ast: Node;
  bindingToSymbolId: WeakMap<Binding, SymbolId>;
  bindingIdentifierToSymbolId: WeakMap<Identifier, SymbolId>;
  renamePlan: Map<SymbolId, string>;
  originalNameBySymbolId: Map<SymbolId, string>;
}) {
  traverse(ast, {
    ObjectProperty(path) {
      if (!path.node.shorthand) return;
      if (!t.isIdentifier(path.node.key)) return;
      if (!t.isIdentifier(path.node.value)) return;

      const keyName = path.node.key.name;

      let symbolId: SymbolId | undefined;

      // In patterns, the value Identifier is a binding identifier.
      if (path.parentPath?.isObjectPattern()) {
        symbolId = bindingIdentifierToSymbolId.get(path.node.value);
      } else {
        // In expressions, the value Identifier is a reference.
        const valuePath = path.get("value");
        if (valuePath.isIdentifier()) {
          const binding = valuePath.scope.getBinding(valuePath.node.name);
          if (binding) {
            symbolId = bindingToSymbolId.get(binding);
          }
        }
      }

      if (!symbolId) return;

      const original = originalNameBySymbolId.get(symbolId);
      const finalName = renamePlan.get(symbolId);
      if (!original || !finalName) return;
      if (finalName === original) return;

      // Expand shorthand: create a fresh key node so it won't be renamed.
      path.node.shorthand = false;
      path.node.key = t.identifier(keyName);
      // Keep value identifier node as-is; it will be renamed via scope.rename.
    },
  });
}

/**
 * Preserve named export interfaces across files.
 *
 * If we rename an exported declaration:
 *   export function a() {}
 * becomes:
 *   function betterName() {}
 *   export { betterName as a };
 *
 * This keeps the module's public API stable without requiring cross-file edits.
 */
export function preserveExportedDeclarations(
  ast: Node,
  records: ExportedDeclarationRecord[],
) {
  const recordByNode = new WeakMap<t.ExportNamedDeclaration, ExportedDeclarationRecord>();
  for (const r of records) {
    recordByNode.set(r.exportNode, r);
  }

  traverse(ast, {
    ExportNamedDeclaration(path: NodePath<t.ExportNamedDeclaration>) {
      const record = recordByNode.get(path.node);
      if (!record) return;

      const declaration = path.node.declaration;
      if (!declaration) return;

      const specifiers = record.exportedBindings.map(({ identifier, exportedName }) =>
        t.exportSpecifier(t.identifier(identifier.name), t.identifier(exportedName)),
      );

      const exportStmt = t.exportNamedDeclaration(null, specifiers, null);
      exportStmt.exportKind = path.node.exportKind;

      path.replaceWithMultiple([declaration, exportStmt]);
      path.skip();
    },
  });
}

export function scopeIdFromUid(uid: number): ScopeId {
  return `scope_${uid}`;
}
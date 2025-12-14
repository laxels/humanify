import { transformFromAstAsync } from "@babel/core";
import type { NodePath, Scope } from "@babel/traverse";
import * as babelTraverse from "@babel/traverse";
import * as t from "@babel/types";
import type {
  BindingId,
  ResolvedRename,
  SymbolAnalysisResult,
  SymbolBinding,
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
 * Applies resolved renames to the AST and returns the transformed code.
 */
export async function applyRenames(
  analysisResult: SymbolAnalysisResult,
  resolvedRenames: ResolvedRename[],
): Promise<string> {
  const ast = analysisResult.ast;

  // Build a map from original name + scope to new name
  const renameMap = buildRenameMap(resolvedRenames, analysisResult);

  // Build a map to track which scopes have which bindings
  const scopeBindingMap = buildScopeBindingMap(analysisResult);

  // First pass: handle object shorthand properties that need to be expanded
  handleShorthandProperties(ast, renameMap, scopeBindingMap);

  // Second pass: apply renames using Babel's scope.rename()
  applyRenamesWithBabel(ast, renameMap, scopeBindingMap);

  // Generate code from the modified AST
  const result = await transformFromAstAsync(ast);
  if (!result?.code) {
    throw new Error("Failed to generate code from AST");
  }

  return result.code;
}

type RenameEntry = {
  originalName: string;
  newName: string;
  bindingId: BindingId;
  scopeId: string;
};

/**
 * Builds a map from (originalName, scopePath) to RenameEntry.
 */
function buildRenameMap(
  resolvedRenames: ResolvedRename[],
  analysisResult: SymbolAnalysisResult,
): Map<string, RenameEntry> {
  const map = new Map<string, RenameEntry>();

  for (const rename of resolvedRenames) {
    const binding = analysisResult.bindings.get(rename.bindingId);
    if (!binding) continue;

    const key = makeRenameKey(rename.originalName, binding.scopeId);
    map.set(key, {
      originalName: rename.originalName,
      newName: rename.newName,
      bindingId: rename.bindingId,
      scopeId: binding.scopeId,
    });
  }

  return map;
}

function makeRenameKey(name: string, scopeId: string): string {
  return `${scopeId}:${name}`;
}

type ScopeBindingEntry = {
  binding: SymbolBinding;
  babelScope?: Scope;
};

/**
 * Builds a map from scopeId to bindings in that scope.
 */
function buildScopeBindingMap(
  analysisResult: SymbolAnalysisResult,
): Map<string, ScopeBindingEntry[]> {
  const map = new Map<string, ScopeBindingEntry[]>();

  for (const binding of analysisResult.bindings.values()) {
    const entries = map.get(binding.scopeId) ?? [];
    entries.push({ binding });
    map.set(binding.scopeId, entries);
  }

  return map;
}

/**
 * Handles object shorthand properties that need to be expanded when renamed.
 * Example: { a } -> { a: newName } when 'a' is renamed to 'newName'
 */
function handleShorthandProperties(
  ast: t.Node,
  renameMap: Map<string, RenameEntry>,
  scopeBindingMap: Map<string, ScopeBindingEntry[]>,
): void {
  traverse(ast, {
    ObjectProperty(path) {
      if (!path.node.shorthand) return;
      if (!t.isIdentifier(path.node.key)) return;
      if (!t.isIdentifier(path.node.value)) return;

      const keyName = path.node.key.name;
      const binding = path.scope.getBinding(keyName);
      if (!binding) return;

      // Find if this binding is being renamed
      const scopeId = findScopeIdForBinding(binding, scopeBindingMap);
      if (!scopeId) return;

      const renameKey = makeRenameKey(keyName, scopeId);
      const renameEntry = renameMap.get(renameKey);
      if (!renameEntry) return;

      // Expand the shorthand: { a } -> { a: a }
      // The value identifier will be renamed by Babel later
      path.node.shorthand = false;
    },
  });
}

/**
 * Applies renames using Babel's scope.rename() method.
 */
function applyRenamesWithBabel(
  ast: t.Node,
  renameMap: Map<string, RenameEntry>,
  scopeBindingMap: Map<string, ScopeBindingEntry[]>,
): void {
  // Collect all scopes and their corresponding scopeIds
  const scopeToIdMap = new Map<Scope, string>();
  let scopeCounter = 0;

  traverse(ast, {
    Scope(path) {
      const scopeId = `scope_${scopeCounter++}`;
      scopeToIdMap.set(path.scope, scopeId);
    },
  });

  // Now apply renames
  traverse(ast, {
    BindingIdentifier(path: NodePath<t.Identifier>) {
      const name = path.node.name;
      const binding = path.scope.getBinding(name);
      if (!binding) return;

      // Find the scopeId for this binding
      const scopeId = scopeToIdMap.get(binding.scope);
      if (!scopeId) return;

      const renameKey = makeRenameKey(name, scopeId);
      const renameEntry = renameMap.get(renameKey);
      if (!renameEntry) return;

      // Use Babel's scope.rename to safely rename all references
      try {
        binding.scope.rename(name, renameEntry.newName);
        // Remove from map to prevent double-renaming
        renameMap.delete(renameKey);
      } catch (error) {
        // Rename failed, skip this binding
        console.warn(
          `Failed to rename ${name} to ${renameEntry.newName}:`,
          error,
        );
      }
    },
  });
}

/**
 * Finds the scopeId for a Babel binding.
 */
function findScopeIdForBinding(
  binding: babelTraverse.Binding,
  scopeBindingMap: Map<string, ScopeBindingEntry[]>,
): string | undefined {
  const bindingName = binding.identifier.name;
  const bindingNode = binding.path.node;

  for (const [scopeId, entries] of scopeBindingMap) {
    for (const entry of entries) {
      if (
        entry.binding.name === bindingName &&
        entry.binding.declarationNode === bindingNode
      ) {
        return scopeId;
      }
    }
  }

  return undefined;
}

/**
 * Alternative implementation that applies renames directly without relying on scope matching.
 * This is more robust for cases where scope tracking might differ.
 */
export async function applyRenamesDirect(
  analysisResult: SymbolAnalysisResult,
  resolvedRenames: ResolvedRename[],
): Promise<string> {
  const ast = analysisResult.ast;

  // Build a map from binding declaration node to new name
  const nodeToNewName = new Map<t.Node, string>();

  for (const rename of resolvedRenames) {
    const binding = analysisResult.bindings.get(rename.bindingId);
    if (!binding) continue;
    nodeToNewName.set(binding.declarationNode, rename.newName);
  }

  // Build a set of names being renamed for shorthand detection
  const _renamedNames = new Set(resolvedRenames.map((r) => r.originalName));

  // First pass: expand shorthands for renamed bindings
  traverse(ast, {
    ObjectProperty(path) {
      if (!path.node.shorthand) return;
      if (!t.isIdentifier(path.node.key)) return;

      const keyName = path.node.key.name;
      const binding = path.scope.getBinding(keyName);
      if (!binding) return;

      // Check if this binding is being renamed
      if (nodeToNewName.has(binding.path.node)) {
        path.node.shorthand = false;
      }
    },
  });

  // Second pass: apply renames
  const processedBindings = new Set<babelTraverse.Binding>();

  traverse(ast, {
    BindingIdentifier(path: NodePath<t.Identifier>) {
      const name = path.node.name;
      const binding = path.scope.getBinding(name);
      if (!binding) return;
      if (processedBindings.has(binding)) return;

      const newName = nodeToNewName.get(binding.path.node);
      if (!newName) return;

      try {
        binding.scope.rename(name, newName);
        processedBindings.add(binding);
      } catch (error) {
        console.warn(`Failed to rename ${name} to ${newName}:`, error);
      }
    },
  });

  // Generate code
  const result = await transformFromAstAsync(ast);
  if (!result?.code) {
    throw new Error("Failed to generate code from AST");
  }

  return result.code;
}

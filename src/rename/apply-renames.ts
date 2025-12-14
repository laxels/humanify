import { transformFromAstAsync } from "@babel/core";
import * as babelTraverse from "@babel/traverse";
import type { File } from "@babel/types";
import { parseBindingId } from "../analysis/scope-analyzer";
import type { ResolvedRename, SymbolTable } from "../analysis/types";
import { verbose } from "../verbose";

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
 * Groups renames by scope for efficient processing.
 */
export function groupRenamesByScope(
  renames: ResolvedRename[],
): Map<string, Map<string, string>> {
  const byScope = new Map<string, Map<string, string>>();

  for (const rename of renames) {
    // Skip if name didn't change
    if (rename.originalName === rename.newName) continue;

    const { scopeUid, name } = parseBindingId(rename.bindingId);

    let scopeRenames = byScope.get(scopeUid);
    if (!scopeRenames) {
      scopeRenames = new Map();
      byScope.set(scopeUid, scopeRenames);
    }

    scopeRenames.set(name, rename.newName);
  }

  return byScope;
}

/**
 * Creates a lookup function for renames by scope UID.
 */
export function createRenameLookup(
  renames: ResolvedRename[],
): (scopeUid: string, name: string) => string | undefined {
  const byScope = groupRenamesByScope(renames);

  return (scopeUid: string, name: string): string | undefined => {
    const scopeRenames = byScope.get(scopeUid);
    if (!scopeRenames) return undefined;
    return scopeRenames.get(name);
  };
}

export type ApplyRenamesOptions = {
  /** If true, handle object shorthand properties correctly */
  handleShorthandProperties?: boolean;
  /** If true, handle export specifiers correctly */
  handleExportSpecifiers?: boolean;
};

const DEFAULT_OPTIONS: ApplyRenamesOptions = {
  handleShorthandProperties: true,
  handleExportSpecifiers: true,
};

/**
 * Applies all renames to the AST using Babel's scope.rename() method.
 * This ensures all references are correctly updated and handles shadowing.
 */
export async function applyRenames(
  ast: File,
  renames: ResolvedRename[],
  _symbolTable: SymbolTable,
  options: ApplyRenamesOptions = DEFAULT_OPTIONS,
): Promise<string> {
  const { handleShorthandProperties = true, handleExportSpecifiers = true } =
    options;

  // Group renames by scope
  const renamesByScope = groupRenamesByScope(renames);

  // Track which renames we've applied (to avoid double-renaming)
  const appliedRenames = new Set<string>();

  // Apply renames scope by scope
  traverse(ast, {
    Scope(path) {
      const scopeUid = String(path.scope.uid);
      const scopeRenames = renamesByScope.get(scopeUid);

      if (!scopeRenames) return;

      for (const [oldName, newName] of scopeRenames) {
        const renameKey = `${scopeUid}:${oldName}`;

        // Skip if already applied
        if (appliedRenames.has(renameKey)) continue;

        // Check if this binding exists in this scope
        const binding = path.scope.getOwnBinding(oldName);
        if (!binding) continue;

        verbose.log(`Renaming ${oldName} -> ${newName} in scope ${scopeUid}`);

        // Handle object shorthand properties before renaming
        if (handleShorthandProperties) {
          expandShorthandProperties(binding);
        }

        // Handle export specifiers before renaming
        if (handleExportSpecifiers) {
          handleExportsBeforeRename(binding, oldName);
        }

        // Use Babel's scope.rename which handles all references
        path.scope.rename(oldName, newName);

        appliedRenames.add(renameKey);
      }
    },
  });

  // Generate code from AST
  const result = await transformFromAstAsync(ast);

  if (result?.code == null) {
    throw new Error("Failed to generate code from AST");
  }

  return result.code;
}

/**
 * Expands object shorthand properties for a binding.
 * { foo } becomes { foo: foo } so that renaming foo doesn't change the object key.
 */
function expandShorthandProperties(binding: babelTraverse.Binding): void {
  for (const refPath of binding.referencePaths) {
    // Check if this reference is used in an object shorthand property
    const parentPath = refPath.parentPath;
    if (!parentPath?.isObjectProperty()) continue;

    const propNode = parentPath.node;
    if (!propNode.shorthand) continue;

    // Expand the shorthand: { foo } -> { foo: foo }
    propNode.shorthand = false;
  }
}

/**
 * Handles export specifiers before renaming to preserve the exported name.
 * export { foo } should become export { newName as foo } after renaming.
 */
function handleExportsBeforeRename(
  binding: babelTraverse.Binding,
  originalName: string,
): void {
  for (const refPath of binding.referencePaths) {
    const parentPath = refPath.parentPath;

    // Check for export specifier: export { foo }
    if (parentPath?.isExportSpecifier()) {
      const specifier = parentPath.node;

      // If the exported name equals the local name, we need to preserve it
      // After renaming, it should be: export { newName as foo }
      // Babel's rename will update the local, but we need to ensure exported stays the same
      if (
        specifier.exported.type === "Identifier" &&
        specifier.local.type === "Identifier" &&
        specifier.exported.name === specifier.local.name
      ) {
        // Set exported to the original name (will be preserved after rename)
        specifier.exported = {
          type: "Identifier",
          name: originalName,
        };
      }
    }
  }
}

/**
 * Applies renames and returns detailed results including any issues encountered.
 */
export async function applyRenamesWithDiagnostics(
  ast: File,
  renames: ResolvedRename[],
  symbolTable: SymbolTable,
  options: ApplyRenamesOptions = DEFAULT_OPTIONS,
): Promise<{
  code: string;
  appliedCount: number;
  skippedCount: number;
  issues: string[];
}> {
  const issues: string[] = [];
  let appliedCount = 0;
  let skippedCount = 0;

  // Group renames by scope
  const renamesByScope = groupRenamesByScope(renames);
  const appliedRenames = new Set<string>();

  const { handleShorthandProperties = true, handleExportSpecifiers = true } =
    options;

  traverse(ast, {
    Scope(path) {
      const scopeUid = String(path.scope.uid);
      const scopeRenames = renamesByScope.get(scopeUid);

      if (!scopeRenames) return;

      for (const [oldName, newName] of scopeRenames) {
        const renameKey = `${scopeUid}:${oldName}`;

        if (appliedRenames.has(renameKey)) continue;

        const binding = path.scope.getOwnBinding(oldName);
        if (!binding) {
          issues.push(`Binding "${oldName}" not found in scope ${scopeUid}`);
          skippedCount++;
          continue;
        }

        try {
          if (handleShorthandProperties) {
            expandShorthandProperties(binding);
          }

          if (handleExportSpecifiers) {
            handleExportsBeforeRename(binding, oldName);
          }

          path.scope.rename(oldName, newName);
          appliedRenames.add(renameKey);
          appliedCount++;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          issues.push(
            `Failed to rename "${oldName}" -> "${newName}": ${message}`,
          );
          skippedCount++;
        }
      }
    },
  });

  const result = await transformFromAstAsync(ast);

  if (!result?.code) {
    throw new Error("Failed to generate code from AST");
  }

  return {
    code: result.code,
    appliedCount,
    skippedCount,
    issues,
  };
}

/**
 * Creates a summary of the renames that will be applied.
 */
export function createRenameSummary(renames: ResolvedRename[]): string {
  const changed = renames.filter((r) => r.originalName !== r.newName);
  const unchanged = renames.filter((r) => r.originalName === r.newName);

  const lines: string[] = [];
  lines.push(`Total bindings: ${renames.length}`);
  lines.push(`Changed: ${changed.length}`);
  lines.push(`Unchanged: ${unchanged.length}`);

  if (changed.length > 0) {
    lines.push("\nChanges:");
    for (const rename of changed.slice(0, 20)) {
      lines.push(
        `  ${rename.originalName} -> ${rename.newName} (${(rename.confidence * 100).toFixed(0)}%)`,
      );
    }
    if (changed.length > 20) {
      lines.push(`  ... and ${changed.length - 20} more`);
    }
  }

  return lines.join("\n");
}

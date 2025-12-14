import { transformFromAstAsync } from "@babel/core";
import type * as babelTraverse from "@babel/traverse";
import type { RenameDecision } from "./constraint-solver";
import type { SymbolTable } from "./symbol-table";

const traverse = (
  typeof (require("@babel/traverse") as unknown as { default?: unknown })
    .default === "function"
    ? (
        require("@babel/traverse") as unknown as {
          default: typeof babelTraverse.default;
        }
      ).default
    : (
        require("@babel/traverse") as unknown as {
          default: { default: typeof babelTraverse.default };
        }
      ).default.default
) as typeof babelTraverse.default;

export type ApplyResult = {
  code: string;
  appliedRenames: number;
  skippedRenames: number;
  errors: string[];
};

export function applyRenames(
  table: SymbolTable,
  decisions: RenameDecision[],
): void {
  // Create a map of symbol ID to new name for quick lookup
  const renameMap = new Map<string, string>();
  for (const decision of decisions) {
    renameMap.set(decision.symbolId, decision.newName);
  }

  // Apply renames using Babel's scope.rename()
  // We need to process from outer scopes to inner to avoid issues
  const sortedDecisions = [...decisions].sort((a, b) => {
    const symbolA = table.symbols.get(a.symbolId);
    const symbolB = table.symbols.get(b.symbolId);
    if (!symbolA || !symbolB) return 0;
    return symbolB.scopeSize - symbolA.scopeSize;
  });

  for (const decision of sortedDecisions) {
    const symbol = table.symbols.get(decision.symbolId);
    if (!symbol) continue;

    try {
      // Use the binding's scope to rename
      symbol.binding.scope.rename(decision.originalName, decision.newName);
    } catch (error) {
      // Log but continue with other renames
      console.warn(
        `Failed to rename ${decision.originalName} to ${decision.newName}:`,
        error,
      );
    }
  }
}

export async function generateCode(table: SymbolTable): Promise<string> {
  const result = await transformFromAstAsync(table.ast);

  if (!result?.code) {
    throw new Error("Failed to generate code from AST");
  }

  return result.code;
}

export async function applyRenamesAndGenerate(
  table: SymbolTable,
  decisions: RenameDecision[],
): Promise<ApplyResult> {
  const errors: string[] = [];
  let appliedRenames = 0;
  let skippedRenames = 0;

  // Create a map of symbol ID to new name for quick lookup
  const renameMap = new Map<string, string>();
  for (const decision of decisions) {
    renameMap.set(decision.symbolId, decision.newName);
  }

  // Sort decisions by scope size (largest first)
  const sortedDecisions = [...decisions].sort((a, b) => {
    const symbolA = table.symbols.get(a.symbolId);
    const symbolB = table.symbols.get(b.symbolId);
    if (!symbolA || !symbolB) return 0;
    return symbolB.scopeSize - symbolA.scopeSize;
  });

  // Apply renames
  for (const decision of sortedDecisions) {
    const symbol = table.symbols.get(decision.symbolId);
    if (!symbol) {
      errors.push(`Symbol not found: ${decision.symbolId}`);
      skippedRenames++;
      continue;
    }

    try {
      symbol.binding.scope.rename(decision.originalName, decision.newName);
      appliedRenames++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(
        `Failed to rename ${decision.originalName} to ${decision.newName}: ${message}`,
      );
      skippedRenames++;
    }
  }

  // Generate code
  const code = await generateCode(table);

  return {
    code,
    appliedRenames,
    skippedRenames,
    errors,
  };
}

export function handleObjectShorthand(
  table: SymbolTable,
  decisions: RenameDecision[],
): void {
  // Find all object shorthand usages that need to be expanded
  // When renaming `a` to `userId` in `{ a }`, we need to change it to `{ a: userId }`

  for (const decision of decisions) {
    const symbol = table.symbols.get(decision.symbolId);
    if (!symbol) continue;

    for (const ref of symbol.references) {
      const parent = ref.parentPath;
      if (!parent?.isObjectProperty()) continue;

      const prop = parent.node;
      if (!prop.shorthand) continue;

      // This is a shorthand property that will be affected by renaming
      // We need to expand it: { a } -> { a: userId }
      // The key should stay as the original name, value will be the new identifier

      // After Babel's rename, both key and value will have the new name
      // We need to restore the key to the original name

      // We'll handle this by traversing after rename and fixing up
    }
  }
}

export async function applyRenamesWithShorthandHandling(
  table: SymbolTable,
  decisions: RenameDecision[],
): Promise<ApplyResult> {
  // First, collect all shorthand properties that will be affected
  const shorthandFixups: Array<{
    path: babelTraverse.NodePath<babelTraverse.Node>;
    originalKey: string;
  }> = [];

  for (const decision of decisions) {
    const symbol = table.symbols.get(decision.symbolId);
    if (!symbol) continue;

    for (const ref of symbol.references) {
      const parent = ref.parentPath;
      if (!parent?.isObjectProperty()) continue;

      const prop = parent.node;
      if (!prop.shorthand) continue;

      shorthandFixups.push({
        path: parent,
        originalKey: decision.originalName,
      });
    }
  }

  // Apply renames
  const result = await applyRenamesAndGenerate(table, decisions);

  // Now traverse the AST and fix shorthand properties
  // After rename, they'll have shorthand: true but both key and value
  // will have the new name. We need to set shorthand: false and
  // restore the key to the original name.
  traverse(table.ast, {
    ObjectProperty(path) {
      // Find if this was a shorthand that we need to fix
      const fixup = shorthandFixups.find((f) => f.path.node === path.node);
      if (fixup && path.node.shorthand) {
        // Convert to non-shorthand with original key name
        path.node.shorthand = false;
        if (path.node.key.type === "Identifier") {
          path.node.key.name = fixup.originalKey;
        }
      }
    },
  });

  // Regenerate code after fixups
  const finalCode = await generateCode(table);

  return {
    ...result,
    code: finalCode,
  };
}

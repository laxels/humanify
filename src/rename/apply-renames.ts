import type { Node } from "@babel/types";
import type { RenameSymbol } from "./types";

export function applyRenamesToAst(
  ast: Node,
  symbols: RenameSymbol[],
  finalNameBySymbolId: Map<string, string>,
) {
  // Build rename targets (only changed symbols).
  const targets = symbols
    .map((s) => {
      const finalName = finalNameBySymbolId.get(s.id) ?? s.originalName;
      return { symbol: s, from: s.originalName, to: finalName };
    })
    .filter((t) => t.to !== t.from);

  if (targets.length === 0) return;

  // Ensure temps won't collide with any final names (and are globally unique).
  const finalNames = new Set(targets.map((t) => t.to));
  const usedTemps = new Set<string>();

  const withTemps = targets.map((t, idx) => {
    let temp = `__humanify_tmp_${idx}`;
    while (
      finalNames.has(temp) ||
      usedTemps.has(temp) ||
      t.symbol.bindingPath.scope.hasBinding(temp)
    ) {
      temp = `_${temp}`;
    }
    usedTemps.add(temp);
    return { ...t, temp };
  });

  // Deterministic order: source order.
  withTemps.sort((a, b) => {
    const sa = a.symbol.bindingPath.node.start ?? 0;
    const sb = b.symbol.bindingPath.node.start ?? 0;
    if (sa !== sb) return sa - sb;
    return a.symbol.id.localeCompare(b.symbol.id);
  });

  // Phase 1: rename original -> temp
  for (const t of withTemps) {
    t.symbol.bindingPath.scope.rename(t.from, t.temp);
  }

  // Phase 2: temp -> final
  for (const t of withTemps) {
    t.symbol.bindingPath.scope.rename(t.temp, t.to);
  }

  return ast;
}
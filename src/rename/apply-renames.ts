import type { SymbolInfo } from "./symbol-analysis";
import type { SymbolId } from "./types";

export function applyRenamePlan(
  symbols: SymbolInfo[],
  renamePlan: Map<SymbolId, string>,
) {
  // Group by declaring scope so we can avoid collisions within each scope.
  const byScopeUid = new Map<number, SymbolInfo[]>();
  for (const s of symbols) {
    const list = byScopeUid.get(s.declaringScopeUid) ?? [];
    list.push(s);
    byScopeUid.set(s.declaringScopeUid, list);
  }

  let tmpCounter = 0;

  for (const [, scopeSymbols] of byScopeUid) {
    const renames: Array<{
      bindingNameBefore: string;
      tmpName: string;
      finalName: string;
      scopeRename: (oldName: string, newName: string) => void;
    }> = [];

    for (const s of scopeSymbols) {
      const bindingNameBefore = s.binding.identifier.name;
      const finalName = renamePlan.get(s.id) ?? bindingNameBefore;

      if (finalName === bindingNameBefore) continue;

      const scope = s.binding.scope;
      const scopeRename = scope.rename.bind(scope);

      // Generate a temp name guaranteed to not collide in this scope.
      let tmpName = `__humanify_tmp_${tmpCounter++}`;
      while (scope.hasBinding(tmpName) || scope.hasGlobal(tmpName)) {
        tmpName = `__humanify_tmp_${tmpCounter++}`;
      }

      renames.push({ bindingNameBefore, tmpName, finalName, scopeRename });
    }

    if (renames.length === 0) continue;

    // Phase 1: move every binding to a unique temp name.
    for (const r of renames) {
      r.scopeRename(r.bindingNameBefore, r.tmpName);
    }

    // Phase 2: move temps to final names.
    for (const r of renames) {
      r.scopeRename(r.tmpName, r.finalName);
    }
  }
}
import {
  isValidIdentifier,
  sanitizeIdentifier,
  toCamelCase,
  toPascalCase,
  toUpperSnakeCase,
} from "./llm-naming";
import type {
  BindingId,
  ConstraintSolverOptions,
  ResolvedRename,
  ScopeId,
  SymbolAnalysisResult,
  SymbolBinding,
  SymbolNamingResult,
} from "./types";

const DEFAULT_MIN_CONFIDENCE = 0.0;

/**
 * Resolves naming conflicts and applies constraints to produce final rename decisions.
 */
export function solveConstraints(
  analysisResult: SymbolAnalysisResult,
  namingResults: SymbolNamingResult[],
  options: ConstraintSolverOptions = {},
): ResolvedRename[] {
  const {
    enforceCamelCase = true,
    enforcePascalCase = true,
    enforceConstantCase = false,
    minConfidence = DEFAULT_MIN_CONFIDENCE,
  } = options;

  // Build a map from binding ID to naming results
  const namingMap = new Map<BindingId, SymbolNamingResult>();
  for (const result of namingResults) {
    namingMap.set(result.bindingId, result);
  }

  // Track used names per scope (including inherited names from parent scopes)
  const usedNamesByScope = buildUsedNamesMap(analysisResult);

  // Process bindings in order (largest scope first, as they were analyzed)
  const resolvedRenames: ResolvedRename[] = [];

  // Get bindings sorted by scope size (largest first)
  const sortedBindings = getSortedBindings(analysisResult);

  for (const binding of sortedBindings) {
    const namingResult = namingMap.get(binding.id);
    if (!namingResult) {
      // No naming result, keep original name
      continue;
    }

    const resolvedName = resolveNameForBinding(
      binding,
      namingResult,
      usedNamesByScope,
      analysisResult,
      {
        enforceCamelCase,
        enforcePascalCase,
        enforceConstantCase,
        minConfidence,
      },
    );

    if (resolvedName && resolvedName.newName !== binding.name) {
      resolvedRenames.push(resolvedName);

      // Mark the new name as used in this scope and all child scopes
      markNameAsUsed(
        binding.scopeId,
        resolvedName.newName,
        usedNamesByScope,
        analysisResult,
      );
    }
  }

  return resolvedRenames;
}

/**
 * Builds a map of used names per scope, including names inherited from parent scopes.
 */
function buildUsedNamesMap(
  analysisResult: SymbolAnalysisResult,
): Map<ScopeId, Set<string>> {
  const usedNames = new Map<ScopeId, Set<string>>();

  // Initialize with existing binding names
  for (const scope of analysisResult.scopes.values()) {
    const names = new Set<string>();

    for (const bindingId of scope.bindingIds) {
      const binding = analysisResult.bindings.get(bindingId);
      if (binding) {
        names.add(binding.name);
      }
    }

    usedNames.set(scope.id, names);
  }

  // Add parent scope names (bindings are visible in child scopes)
  for (const scope of analysisResult.scopes.values()) {
    const scopeNames = usedNames.get(scope.id)!;
    let parentId = scope.parentId;

    while (parentId) {
      const parentNames = usedNames.get(parentId);
      if (parentNames) {
        for (const name of parentNames) {
          scopeNames.add(name);
        }
      }
      const parent = analysisResult.scopes.get(parentId);
      parentId = parent?.parentId ?? null;
    }
  }

  return usedNames;
}

/**
 * Gets bindings sorted by scope size (largest first).
 */
function getSortedBindings(
  analysisResult: SymbolAnalysisResult,
): SymbolBinding[] {
  const bindingsWithScopeSize: [SymbolBinding, number][] = [];

  for (const binding of analysisResult.bindings.values()) {
    const scope = analysisResult.scopes.get(binding.scopeId);
    if (scope) {
      const scopeSize = scope.end - scope.start;
      bindingsWithScopeSize.push([binding, scopeSize]);
    }
  }

  // Sort by scope size descending (largest first)
  bindingsWithScopeSize.sort((a, b) => b[1] - a[1]);

  return bindingsWithScopeSize.map(([binding]) => binding);
}

/**
 * Resolves the final name for a single binding.
 */
function resolveNameForBinding(
  binding: SymbolBinding,
  namingResult: SymbolNamingResult,
  usedNamesByScope: Map<ScopeId, Set<string>>,
  analysisResult: SymbolAnalysisResult,
  options: {
    enforceCamelCase: boolean;
    enforcePascalCase: boolean;
    enforceConstantCase: boolean;
    minConfidence: number;
  },
): ResolvedRename | null {
  const _usedNames = usedNamesByScope.get(binding.scopeId) ?? new Set();

  // Get all visible names (this scope + all child scopes)
  const allVisibleNames = getAllVisibleNames(
    binding.scopeId,
    usedNamesByScope,
    analysisResult,
  );

  // Try each candidate in order
  for (const candidate of namingResult.candidates) {
    if (candidate.confidence < options.minConfidence) {
      continue;
    }

    let name = candidate.name;

    // Apply naming conventions
    name = applyNamingConventions(name, binding, options);

    // Sanitize to valid identifier
    if (!isValidIdentifier(name)) {
      name = sanitizeIdentifier(name);
    }

    // Skip if new name equals original name
    if (name === binding.name) {
      continue;
    }

    // Check for collision
    if (!allVisibleNames.has(name)) {
      return {
        bindingId: binding.id,
        originalName: binding.name,
        newName: name,
        confidence: candidate.confidence,
      };
    }

    // Try with underscore prefix
    let prefixedName = `_${name}`;
    let attempts = 0;
    while (allVisibleNames.has(prefixedName) && attempts < 10) {
      prefixedName = `_${prefixedName}`;
      attempts++;
    }

    if (!allVisibleNames.has(prefixedName)) {
      return {
        bindingId: binding.id,
        originalName: binding.name,
        newName: prefixedName,
        confidence: candidate.confidence * 0.9, // Slightly lower confidence for prefixed names
      };
    }
  }

  // No valid candidate found, keep original name
  return null;
}

/**
 * Gets all names visible from a scope (including child scopes).
 */
function getAllVisibleNames(
  scopeId: ScopeId,
  usedNamesByScope: Map<ScopeId, Set<string>>,
  analysisResult: SymbolAnalysisResult,
): Set<string> {
  const visible = new Set<string>();

  // Add names from this scope
  const scopeNames = usedNamesByScope.get(scopeId);
  if (scopeNames) {
    for (const name of scopeNames) {
      visible.add(name);
    }
  }

  // Add names from child scopes (they could shadow our new name)
  const scope = analysisResult.scopes.get(scopeId);
  if (scope) {
    for (const childId of scope.childScopeIds) {
      const childNames = getAllVisibleNames(
        childId,
        usedNamesByScope,
        analysisResult,
      );
      for (const name of childNames) {
        visible.add(name);
      }
    }
  }

  return visible;
}

/**
 * Applies naming conventions based on binding kind.
 */
function applyNamingConventions(
  name: string,
  binding: SymbolBinding,
  options: {
    enforceCamelCase: boolean;
    enforcePascalCase: boolean;
    enforceConstantCase: boolean;
  },
): string {
  const { enforceCamelCase, enforcePascalCase, enforceConstantCase } = options;

  // Classes should be PascalCase
  if (binding.kind === "class" && enforcePascalCase) {
    return toPascalCase(name);
  }

  // Constants that look like constants (all caps) should stay that way
  if (
    binding.kind === "const" &&
    enforceConstantCase &&
    isLikelyConstantValue(binding)
  ) {
    return toUpperSnakeCase(name);
  }

  // Everything else should be camelCase
  if (enforceCamelCase && binding.kind !== "class") {
    return toCamelCase(name);
  }

  return name;
}

/**
 * Determines if a const binding is likely a true constant value.
 */
function isLikelyConstantValue(binding: SymbolBinding): boolean {
  // Check if the original name looks like a constant
  if (/^[A-Z][A-Z0-9_]*$/.test(binding.name)) {
    return true;
  }

  // Check if it's never reassigned (consts can't be, but this is extra safety)
  const hasWrites = binding.references.some((r) => r.type === "write");
  if (hasWrites) {
    return false;
  }

  // Check if it's only used for reads (not called, not property accessed)
  const onlyReads = binding.references.every(
    (r) => r.type === "read" || r.type === "export",
  );

  return onlyReads;
}

/**
 * Marks a name as used in a scope and propagates to child scopes.
 */
function markNameAsUsed(
  scopeId: ScopeId,
  name: string,
  usedNamesByScope: Map<ScopeId, Set<string>>,
  analysisResult: SymbolAnalysisResult,
): void {
  const names = usedNamesByScope.get(scopeId);
  if (names) {
    names.add(name);
  }

  // Propagate to child scopes
  const scope = analysisResult.scopes.get(scopeId);
  if (scope) {
    for (const childId of scope.childScopeIds) {
      markNameAsUsed(childId, name, usedNamesByScope, analysisResult);
    }
  }
}

/**
 * Validates that the resolved renames don't create any conflicts.
 */
export function validateRenames(
  resolvedRenames: ResolvedRename[],
  analysisResult: SymbolAnalysisResult,
): {
  isValid: boolean;
  conflicts: Array<{ name: string; scopeId: ScopeId; bindingIds: BindingId[] }>;
} {
  const conflicts: Array<{
    name: string;
    scopeId: ScopeId;
    bindingIds: BindingId[];
  }> = [];

  // Build a map of new names per scope
  const newNamesByScope = new Map<ScopeId, Map<string, BindingId[]>>();

  for (const rename of resolvedRenames) {
    const binding = analysisResult.bindings.get(rename.bindingId);
    if (!binding) continue;

    const scopeId = binding.scopeId;
    let scopeNames = newNamesByScope.get(scopeId);
    if (!scopeNames) {
      scopeNames = new Map();
      newNamesByScope.set(scopeId, scopeNames);
    }

    const existing = scopeNames.get(rename.newName) ?? [];
    existing.push(rename.bindingId);
    scopeNames.set(rename.newName, existing);
  }

  // Check for conflicts (multiple bindings with same name in same scope)
  for (const [scopeId, scopeNames] of newNamesByScope) {
    for (const [name, bindingIds] of scopeNames) {
      if (bindingIds.length > 1) {
        conflicts.push({ name, scopeId, bindingIds });
      }
    }
  }

  return {
    isValid: conflicts.length === 0,
    conflicts,
  };
}

/**
 * Optimizes renames to maximize total confidence while satisfying constraints.
 * This is a greedy algorithm that processes bindings in order of scope size.
 */
export function optimizeRenames(
  resolvedRenames: ResolvedRename[],
  analysisResult: SymbolAnalysisResult,
): ResolvedRename[] {
  // For now, just validate and return. A more sophisticated implementation
  // could use linear programming or other optimization techniques.
  const validation = validateRenames(resolvedRenames, analysisResult);

  if (!validation.isValid) {
    // Remove conflicting renames (keep the one with highest confidence)
    const filtered = resolvedRenames.filter((rename) => {
      for (const conflict of validation.conflicts) {
        if (conflict.bindingIds.includes(rename.bindingId)) {
          // Keep only the highest confidence one
          const conflictingRenames = resolvedRenames.filter(
            (r) =>
              conflict.bindingIds.includes(r.bindingId) &&
              r.newName === conflict.name,
          );
          const maxConfidence = Math.max(
            ...conflictingRenames.map((r) => r.confidence),
          );
          if (rename.confidence < maxConfidence) {
            return false;
          }
        }
      }
      return true;
    });

    return filtered;
  }

  return resolvedRenames;
}

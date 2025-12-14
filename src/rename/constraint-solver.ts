import { toIdentifier } from "@babel/types";
import {
  getAncestorScopeIds,
  parseBindingId,
} from "../analysis/scope-analyzer";
import type {
  BatchRenameResult,
  BindingId,
  NameCandidate,
  ResolvedRename,
  SymbolDossier,
  SymbolTable,
} from "../analysis/types";

/**
 * JavaScript reserved words that cannot be used as identifiers.
 */
export const RESERVED_WORDS = new Set([
  // Keywords
  "break",
  "case",
  "catch",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "finally",
  "for",
  "function",
  "if",
  "in",
  "instanceof",
  "new",
  "return",
  "switch",
  "this",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  // Future reserved words
  "class",
  "const",
  "enum",
  "export",
  "extends",
  "import",
  "super",
  // Strict mode reserved words
  "implements",
  "interface",
  "let",
  "package",
  "private",
  "protected",
  "public",
  "static",
  "yield",
  // Special identifiers
  "null",
  "true",
  "false",
  "undefined",
  "NaN",
  "Infinity",
  // Common globals that shouldn't be shadowed
  "arguments",
  "eval",
]);

/**
 * Naming convention rules for different declaration kinds.
 */
export type NamingConventions = {
  /** Force PascalCase for classes */
  pascalCaseForClasses: boolean;
  /** Force camelCase for functions and variables */
  camelCaseForVariables: boolean;
  /** Force UPPER_SNAKE_CASE for const declarations with primitive values */
  upperSnakeForConstants: boolean;
  /** Minimum name length */
  minNameLength: number;
  /** Maximum name length */
  maxNameLength: number;
};

export const DEFAULT_CONVENTIONS: NamingConventions = {
  pascalCaseForClasses: true,
  camelCaseForVariables: true,
  upperSnakeForConstants: false, // Disabled by default as it's often not appropriate
  minNameLength: 2,
  maxNameLength: 50,
};

/**
 * Checks if a name is a valid JavaScript identifier.
 */
export function isValidIdentifier(name: string): boolean {
  if (!name || name.length === 0) return false;
  if (RESERVED_WORDS.has(name)) return false;

  // Use a regex to check for valid identifier characters
  // Must start with letter, underscore, or dollar sign
  // Can contain letters, digits, underscores, or dollar signs
  const validIdentifierRegex = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
  return validIdentifierRegex.test(name);
}

/**
 * Converts a string to a valid identifier using Babel's toIdentifier.
 */
export function makeValidIdentifier(name: string): string {
  // Handle empty string
  if (!name || name.trim().length === 0) {
    return "unnamed";
  }

  // Use Babel's toIdentifier to handle most cases
  let result = toIdentifier(name);

  // Handle reserved words
  if (RESERVED_WORDS.has(result)) {
    result = `_${result}`;
  }

  // Ensure it's not empty
  if (!result || result.length === 0) {
    return "unnamed";
  }

  return result;
}

/**
 * Converts a name to PascalCase.
 */
export function toPascalCase(name: string): string {
  return name
    .split(/[_\s-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * Converts a name to camelCase.
 */
export function toCamelCase(name: string): string {
  const pascal = toPascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/**
 * Converts a name to UPPER_SNAKE_CASE.
 */
export function toUpperSnakeCase(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toUpperCase();
}

/**
 * Applies naming conventions to a name based on the binding's declaration kind.
 */
export function applyNamingConventions(
  name: string,
  dossier: SymbolDossier,
  conventions: NamingConventions = DEFAULT_CONVENTIONS,
): string {
  let result = name;

  // Apply case conventions
  if (dossier.declarationKind === "class" && conventions.pascalCaseForClasses) {
    result = toPascalCase(result);
  } else if (conventions.camelCaseForVariables) {
    // Don't force camelCase on already valid names
    if (!isValidIdentifier(result)) {
      result = toCamelCase(result);
    }
  }

  // Apply length constraints
  if (result.length < conventions.minNameLength) {
    // Pad short names
    result = result + "_";
  }
  if (result.length > conventions.maxNameLength) {
    result = result.slice(0, conventions.maxNameLength);
  }

  return result;
}

/**
 * Resolves naming conflicts in a scope by adding prefixes.
 */
export function resolveConflict(
  desiredName: string,
  usedNames: Set<string>,
): string {
  if (!usedNames.has(desiredName)) {
    return desiredName;
  }

  let candidate = desiredName;
  let counter = 1;

  // First try underscore prefix
  candidate = `_${desiredName}`;
  if (!usedNames.has(candidate)) {
    return candidate;
  }

  // Then try numbered suffixes
  while (usedNames.has(candidate)) {
    counter++;
    candidate = `${desiredName}${counter}`;
  }

  return candidate;
}

/**
 * Gets all names that would conflict with a binding in its scope.
 * This includes names in the same scope and all ancestor scopes.
 */
export function getConflictingNames(
  bindingId: BindingId,
  symbolTable: SymbolTable,
  alreadyResolved: Map<BindingId, string>,
): Set<string> {
  const { scopeUid } = parseBindingId(bindingId);
  const conflicting = new Set<string>();

  // Get current scope
  const scope = symbolTable.scopes.get(scopeUid);
  if (!scope) return conflicting;

  // Add names from current scope
  for (const otherId of scope.bindingIds) {
    if (otherId === bindingId) continue;

    // Check if already resolved
    const resolvedName = alreadyResolved.get(otherId);
    if (resolvedName) {
      conflicting.add(resolvedName);
    } else {
      // Use original name if not yet resolved
      const dossier = symbolTable.bindings.get(otherId);
      if (dossier) {
        conflicting.add(dossier.originalName);
      }
    }
  }

  // Add names from ancestor scopes
  const ancestors = getAncestorScopeIds(scopeUid, symbolTable);
  for (const ancestorId of ancestors) {
    const ancestorScope = symbolTable.scopes.get(ancestorId);
    if (!ancestorScope) continue;

    for (const otherId of ancestorScope.bindingIds) {
      const resolvedName = alreadyResolved.get(otherId);
      if (resolvedName) {
        conflicting.add(resolvedName);
      } else {
        const dossier = symbolTable.bindings.get(otherId);
        if (dossier) {
          conflicting.add(dossier.originalName);
        }
      }
    }
  }

  return conflicting;
}

/**
 * Selects the best candidate name for a binding, considering constraints.
 */
export function selectBestCandidate(
  candidates: NameCandidate[],
  dossier: SymbolDossier,
  conflictingNames: Set<string>,
  conventions: NamingConventions = DEFAULT_CONVENTIONS,
): { name: string; confidence: number } {
  // Sort candidates by confidence (highest first)
  const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence);

  // First pass: find a candidate that doesn't conflict
  for (const candidate of sorted) {
    let name = makeValidIdentifier(candidate.name);
    name = applyNamingConventions(name, dossier, conventions);

    // Check if this name conflicts
    if (!conflictingNames.has(name)) {
      return { name, confidence: candidate.confidence };
    }
  }

  // Second pass: resolve conflict for the best candidate
  const firstCandidate = sorted[0];
  if (firstCandidate) {
    let name = makeValidIdentifier(firstCandidate.name);
    name = applyNamingConventions(name, dossier, conventions);
    const resolved = resolveConflict(name, conflictingNames);
    return { name: resolved, confidence: firstCandidate.confidence * 0.8 };
  }

  // Ultimate fallback: keep original name
  return { name: dossier.originalName, confidence: 0 };
}

export type SolverOptions = {
  conventions?: NamingConventions;
  /** Minimum confidence threshold - bindings below this keep original names */
  minConfidence?: number;
};

/**
 * Solves the global constraint satisfaction problem for renaming.
 * Processes bindings in order of scope size (largest first) to ensure
 * outer scope names are resolved before inner scope names.
 */
export function solveConstraints(
  symbolTable: SymbolTable,
  renameResults: BatchRenameResult,
  options: SolverOptions = {},
): ResolvedRename[] {
  const { conventions = DEFAULT_CONVENTIONS, minConfidence = 0 } = options;

  const resolved: ResolvedRename[] = [];
  const resolvedNames = new Map<BindingId, string>();

  // Create a map from binding ID to candidates
  const candidatesMap = new Map<BindingId, NameCandidate[]>();
  for (const { bindingId, candidates } of renameResults.renames) {
    candidatesMap.set(bindingId, candidates);
  }

  // Get all scopes sorted by size (largest first)
  const sortedScopes = Array.from(symbolTable.scopes.values()).sort(
    (a, b) => b.size - a.size,
  );

  // Process each scope's bindings
  for (const scope of sortedScopes) {
    for (const bindingId of scope.bindingIds) {
      const dossier = symbolTable.bindings.get(bindingId);
      if (!dossier) continue;

      // Skip unsafe bindings
      if (dossier.isUnsafe) {
        resolved.push({
          bindingId,
          originalName: dossier.originalName,
          newName: dossier.originalName,
          confidence: 0,
        });
        resolvedNames.set(bindingId, dossier.originalName);
        continue;
      }

      const candidates = candidatesMap.get(bindingId);

      if (!candidates || candidates.length === 0) {
        // No candidates - keep original name
        resolved.push({
          bindingId,
          originalName: dossier.originalName,
          newName: dossier.originalName,
          confidence: 0,
        });
        resolvedNames.set(bindingId, dossier.originalName);
        continue;
      }

      // Get names that would conflict
      const conflicting = getConflictingNames(
        bindingId,
        symbolTable,
        resolvedNames,
      );

      // Select best candidate
      const { name, confidence } = selectBestCandidate(
        candidates,
        dossier,
        conflicting,
        conventions,
      );

      // Apply minimum confidence threshold
      const finalName =
        confidence >= minConfidence ? name : dossier.originalName;
      const finalConfidence = confidence >= minConfidence ? confidence : 0;

      resolved.push({
        bindingId,
        originalName: dossier.originalName,
        newName: finalName,
        confidence: finalConfidence,
      });
      resolvedNames.set(bindingId, finalName);
    }
  }

  return resolved;
}

/**
 * Validates that all resolved renames satisfy the constraints.
 */
export function validateRenames(
  renames: ResolvedRename[],
  symbolTable: SymbolTable,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Group renames by scope
  const renamesByScope = new Map<string, ResolvedRename[]>();
  for (const rename of renames) {
    const { scopeUid } = parseBindingId(rename.bindingId);
    const scopeRenames = renamesByScope.get(scopeUid) || [];
    scopeRenames.push(rename);
    renamesByScope.set(scopeUid, scopeRenames);
  }

  // Check for duplicates in each scope
  for (const [scopeId, scopeRenames] of renamesByScope) {
    const namesInScope = new Set<string>();

    for (const rename of scopeRenames) {
      // Check for valid identifier
      if (!isValidIdentifier(rename.newName)) {
        errors.push(
          `Invalid identifier "${rename.newName}" for binding ${rename.bindingId}`,
        );
      }

      // Check for duplicates
      if (namesInScope.has(rename.newName)) {
        errors.push(`Duplicate name "${rename.newName}" in scope ${scopeId}`);
      }
      namesInScope.add(rename.newName);
    }
  }

  return { valid: errors.length === 0, errors };
}

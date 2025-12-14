import { toIdentifier } from "@babel/types";
import type { NameCandidate, NamingResult } from "./llm-namer";
import type {
  ScopeId,
  SymbolId,
  SymbolInfo,
  SymbolTable,
} from "./symbol-table";
import { getScopeChain } from "./symbol-table";

export type RenameDecision = {
  symbolId: SymbolId;
  originalName: string;
  newName: string;
  confidence: number;
};

export type ConstraintSolverOptions = {
  enforceNamingConventions?: boolean;
  preferConsistentPatterns?: boolean;
  minConfidenceThreshold?: number;
};

const RESERVED_WORDS = new Set([
  "abstract",
  "arguments",
  "await",
  "boolean",
  "break",
  "byte",
  "case",
  "catch",
  "char",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "double",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "final",
  "finally",
  "float",
  "for",
  "function",
  "goto",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "int",
  "interface",
  "let",
  "long",
  "native",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "short",
  "static",
  "super",
  "switch",
  "synchronized",
  "this",
  "throw",
  "throws",
  "transient",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "volatile",
  "while",
  "with",
  "yield",
]);

export function isValidIdentifier(name: string): boolean {
  if (RESERVED_WORDS.has(name)) {
    return false;
  }

  // Basic identifier validation
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) {
    return false;
  }

  return true;
}

export function sanitizeIdentifier(name: string): string {
  // Handle empty input first
  if (!name || name.trim().length === 0) {
    return "unnamed";
  }

  // Use Babel's toIdentifier which handles most cases
  let sanitized = toIdentifier(name);

  // Handle empty result after toIdentifier
  if (!sanitized || sanitized.length === 0 || sanitized === "_") {
    return "unnamed";
  }

  // Handle reserved words
  if (RESERVED_WORDS.has(sanitized)) {
    sanitized = `_${sanitized}`;
  }

  return sanitized;
}

export function applyNamingConvention(
  name: string,
  symbol: SymbolInfo,
): string {
  const kind = symbol.declarationKind;

  // PascalCase for classes
  if (kind === "class") {
    return toPascalCase(name);
  }

  // UPPER_SNAKE_CASE for const primitives
  if (kind === "const") {
    // Check if it's a primitive constant (would need more analysis)
    // For now, keep as-is unless it's all caps
    if (/^[A-Z_]+$/.test(name)) {
      return name;
    }
  }

  // camelCase for everything else
  return toCamelCase(name);
}

function toCamelCase(str: string): string {
  // If already camelCase or single word, return as-is
  if (/^[a-z][a-zA-Z0-9]*$/.test(str)) {
    return str;
  }

  // Handle snake_case, kebab-case, PascalCase
  return str
    .replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""))
    .replace(/^[A-Z]/, (c) => c.toLowerCase());
}

function toPascalCase(str: string): string {
  // If already PascalCase, return as-is
  if (/^[A-Z][a-zA-Z0-9]*$/.test(str)) {
    return str;
  }

  // Convert to camelCase first, then capitalize
  const camel = toCamelCase(str);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

export function collectCandidatesBySymbol(
  results: NamingResult[],
): Map<SymbolId, NameCandidate[]> {
  const candidatesBySymbol = new Map<SymbolId, NameCandidate[]>();

  for (const result of results) {
    for (const candidate of result.candidates) {
      const existing = candidatesBySymbol.get(candidate.symbolId) || [];
      existing.push(candidate);
      candidatesBySymbol.set(candidate.symbolId, existing);
    }
  }

  return candidatesBySymbol;
}

export function getBindingsInScope(
  table: SymbolTable,
  scopeId: ScopeId,
): Set<string> {
  const names = new Set<string>();

  // Get all symbols in this scope
  const scope = table.scopes.get(scopeId);
  if (!scope) return names;

  for (const symbolId of scope.symbols) {
    const symbol = table.symbols.get(symbolId);
    if (symbol) {
      names.add(symbol.name);
    }
  }

  // Also check parent scopes for accessible bindings
  const chain = getScopeChain(table, scopeId);
  for (const s of chain) {
    for (const symbolId of s.symbols) {
      const symbol = table.symbols.get(symbolId);
      if (symbol) {
        names.add(symbol.name);
      }
    }
  }

  return names;
}

export function solveConstraints(
  table: SymbolTable,
  results: NamingResult[],
  options: ConstraintSolverOptions = {},
): RenameDecision[] {
  const { enforceNamingConventions = true, minConfidenceThreshold = 0 } =
    options;

  const decisions: RenameDecision[] = [];
  const candidatesBySymbol = collectCandidatesBySymbol(results);

  // Track used names per scope to avoid collisions
  const usedNamesPerScope = new Map<ScopeId, Set<string>>();

  // Initialize with existing bindings in each scope
  for (const [scopeId] of table.scopes) {
    usedNamesPerScope.set(scopeId, getBindingsInScope(table, scopeId));
  }

  // Track global renames to avoid using the same name in nested scopes
  const globalRenames = new Map<SymbolId, string>();

  // Process symbols in order (sorted by scope size - largest first)
  const sortedSymbols = Array.from(table.symbols.values()).sort(
    (a, b) => b.scopeSize - a.scopeSize,
  );

  for (const symbol of sortedSymbols) {
    const candidates = candidatesBySymbol.get(symbol.id);
    if (!candidates || candidates.length === 0) {
      continue;
    }

    // Sort candidates by confidence
    const sortedCandidates = [...candidates].sort(
      (a, b) => b.confidence - a.confidence,
    );

    // Find the best valid name
    let chosenName: string | null = null;
    let chosenConfidence = 0;

    for (const candidate of sortedCandidates) {
      if (candidate.confidence < minConfidenceThreshold) {
        continue;
      }

      let name = candidate.newName;

      // Apply naming conventions first (camelCase, PascalCase, etc.)
      if (enforceNamingConventions) {
        name = applyNamingConvention(name, symbol);
      }

      // Then sanitize the name (handle reserved words, invalid chars)
      name = sanitizeIdentifier(name);

      // Check for collisions in this scope and parent scopes
      const scopeChain = getScopeChain(table, symbol.scopeId);
      let hasCollision = false;

      for (const scope of scopeChain) {
        const usedNames = usedNamesPerScope.get(scope.id) || new Set();
        // Collision exists if the name is used and it's not the same symbol
        if (usedNames.has(name)) {
          hasCollision = true;
          break;
        }
      }

      if (!hasCollision) {
        chosenName = name;
        chosenConfidence = candidate.confidence;
        break;
      }

      // Try with underscore prefix
      let prefixedName = `_${name}`;
      let attempts = 0;
      while (attempts < 10) {
        hasCollision = false;
        for (const scope of scopeChain) {
          const usedNames = usedNamesPerScope.get(scope.id) || new Set();
          if (usedNames.has(prefixedName)) {
            hasCollision = true;
            break;
          }
        }

        if (!hasCollision) {
          chosenName = prefixedName;
          chosenConfidence = candidate.confidence;
          break;
        }

        prefixedName = `_${prefixedName}`;
        attempts++;
      }

      if (chosenName) break;
    }

    if (chosenName && chosenName !== symbol.name) {
      decisions.push({
        symbolId: symbol.id,
        originalName: symbol.name,
        newName: chosenName,
        confidence: chosenConfidence,
      });

      // Update used names for this scope
      const usedNames = usedNamesPerScope.get(symbol.scopeId) || new Set();
      usedNames.add(chosenName);
      usedNamesPerScope.set(symbol.scopeId, usedNames);

      globalRenames.set(symbol.id, chosenName);
    }
  }

  return decisions;
}

export function validateDecisions(
  table: SymbolTable,
  decisions: RenameDecision[],
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check for duplicate names in the same scope
  const namesByScope = new Map<ScopeId, Map<string, SymbolId[]>>();

  for (const decision of decisions) {
    const symbol = table.symbols.get(decision.symbolId);
    if (!symbol) {
      errors.push(`Unknown symbol ID: ${decision.symbolId}`);
      continue;
    }

    const scopeNames =
      namesByScope.get(symbol.scopeId) || new Map<string, SymbolId[]>();
    const symbolsWithName = scopeNames.get(decision.newName) || [];
    symbolsWithName.push(decision.symbolId);
    scopeNames.set(decision.newName, symbolsWithName);
    namesByScope.set(symbol.scopeId, scopeNames);
  }

  for (const [scopeId, scopeNames] of namesByScope) {
    for (const [name, symbols] of scopeNames) {
      if (symbols.length > 1) {
        errors.push(
          `Duplicate name "${name}" in scope ${scopeId}: ${symbols.join(", ")}`,
        );
      }
    }
  }

  // Check for invalid identifiers
  for (const decision of decisions) {
    if (!isValidIdentifier(decision.newName)) {
      errors.push(
        `Invalid identifier "${decision.newName}" for symbol ${decision.symbolId}`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

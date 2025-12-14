import type {
  NamingBatch,
  ScopeInfo,
  SymbolAnalysisResult,
  SymbolBinding,
  SymbolDossier,
} from "./types";

/**
 * Creates a symbol dossier for a binding, containing all information
 * needed by the LLM to suggest a good name.
 */
export function createSymbolDossier(binding: SymbolBinding): SymbolDossier {
  return {
    id: binding.id,
    name: binding.name,
    kind: binding.kind,
    surroundingCode: binding.surroundingCode,
    useSummary: createUseSummary(binding),
    typeHints: extractTypeHints(binding),
  };
}

/**
 * Creates a human-readable summary of how a symbol is used.
 */
function createUseSummary(binding: SymbolBinding): string {
  const parts: string[] = [];

  // Count reference types
  const readCount = binding.references.filter((r) => r.type === "read").length;
  const writeCount = binding.references.filter(
    (r) => r.type === "write",
  ).length;
  const callCount = binding.references.filter((r) => r.type === "call").length;
  const propAccessCount = binding.references.filter(
    (r) => r.type === "property-access",
  ).length;
  const shorthandCount = binding.references.filter(
    (r) => r.type === "shorthand",
  ).length;

  if (callCount > 0) {
    parts.push(`called ${callCount} time${callCount > 1 ? "s" : ""}`);
  }
  if (propAccessCount > 0) {
    parts.push(
      `property accessed ${propAccessCount} time${propAccessCount > 1 ? "s" : ""}`,
    );
  }
  if (writeCount > 0) {
    parts.push(`reassigned ${writeCount} time${writeCount > 1 ? "s" : ""}`);
  }
  if (readCount > 0) {
    parts.push(`read ${readCount} time${readCount > 1 ? "s" : ""}`);
  }
  if (shorthandCount > 0) {
    parts.push(
      `used in object shorthand ${shorthandCount} time${shorthandCount > 1 ? "s" : ""}`,
    );
  }

  // Add property access details
  const propertyAccesses = binding.references
    .filter((r) => r.type === "property-access" && r.context)
    .map((r) => r.context!);

  if (propertyAccesses.length > 0) {
    const uniqueProps = [...new Set(propertyAccesses)];
    if (uniqueProps.length <= 5) {
      parts.push(`accessed properties: ${uniqueProps.join(", ")}`);
    } else {
      parts.push(
        `accessed properties: ${uniqueProps.slice(0, 5).join(", ")} and ${uniqueProps.length - 5} more`,
      );
    }
  }

  if (binding.isExported) {
    parts.push("exported");
  }

  if (parts.length === 0) {
    return "declared but not used";
  }

  return parts.join("; ");
}

/**
 * Extracts type-ish hints from usage patterns.
 */
function extractTypeHints(binding: SymbolBinding): string[] {
  const hints: string[] = [];

  // From usage hints
  for (const hint of binding.usageHints) {
    if (hint.hint.startsWith("used with .")) {
      const method = hint.hint.slice("used with .".length);
      const typeHint = inferTypeFromMethod(method);
      if (typeHint && !hints.includes(typeHint)) {
        hints.push(typeHint);
      }
    }
    if (hint.hint === "called as function") {
      hints.push("is a function");
    }
  }

  // From binding kind
  switch (binding.kind) {
    case "function":
      if (!hints.includes("is a function")) {
        hints.push("is a function");
      }
      break;
    case "class":
      hints.push("is a class");
      break;
    case "const":
      hints.push("is a constant");
      break;
    case "param":
      hints.push("is a parameter");
      break;
    case "import":
      hints.push("is imported");
      break;
  }

  return hints;
}

/**
 * Infers a type hint from a method name.
 */
function inferTypeFromMethod(method: string): string | null {
  // Array methods
  const arrayMethods = [
    "map",
    "filter",
    "reduce",
    "forEach",
    "find",
    "findIndex",
    "some",
    "every",
    "includes",
    "indexOf",
    "push",
    "pop",
    "shift",
    "unshift",
    "slice",
    "splice",
    "concat",
    "join",
    "sort",
    "reverse",
    "flat",
    "flatMap",
    "fill",
    "copyWithin",
  ];
  if (arrayMethods.includes(method)) {
    return "likely an array";
  }

  // String methods
  const stringMethods = [
    "charAt",
    "charCodeAt",
    "concat",
    "includes",
    "endsWith",
    "indexOf",
    "lastIndexOf",
    "match",
    "replace",
    "replaceAll",
    "search",
    "slice",
    "split",
    "startsWith",
    "substring",
    "toLowerCase",
    "toUpperCase",
    "trim",
    "trimStart",
    "trimEnd",
    "padStart",
    "padEnd",
    "repeat",
    "normalize",
  ];
  if (stringMethods.includes(method)) {
    return "likely a string";
  }

  // Promise methods
  if (["then", "catch", "finally"].includes(method)) {
    return "likely a Promise";
  }

  // Map/Set methods
  if (
    [
      "get",
      "set",
      "has",
      "delete",
      "clear",
      "keys",
      "values",
      "entries",
    ].includes(method)
  ) {
    return "likely a Map or Set";
  }

  // DOM methods
  const domMethods = [
    "querySelector",
    "querySelectorAll",
    "getElementById",
    "getElementsByClassName",
    "getElementsByTagName",
    "addEventListener",
    "removeEventListener",
    "appendChild",
    "removeChild",
    "insertBefore",
    "replaceChild",
    "cloneNode",
    "getAttribute",
    "setAttribute",
    "removeAttribute",
    "classList",
  ];
  if (domMethods.includes(method)) {
    return "likely a DOM element";
  }

  // Object methods (less specific)
  if (
    method === "hasOwnProperty" ||
    method === "toString" ||
    method === "valueOf"
  ) {
    return "likely an object";
  }

  return null;
}

/**
 * Creates a summary of what a scope does, for LLM context.
 */
export function createScopeSummary(scope: ScopeInfo, code: string): string {
  const scopeCode = code.slice(scope.start, scope.end);

  switch (scope.kind) {
    case "program":
      return "Top-level module code";
    case "function": {
      // Try to extract function signature
      const lines = scopeCode.split("\n");
      const firstLine = lines[0] ?? "";
      if (firstLine.includes("function") || firstLine.includes("=>")) {
        return `Function: ${firstLine.slice(0, 80)}${firstLine.length > 80 ? "..." : ""}`;
      }
      return "Function scope";
    }
    case "class": {
      const lines = scopeCode.split("\n");
      const firstLine = lines[0] ?? "";
      return `Class: ${firstLine.slice(0, 80)}${firstLine.length > 80 ? "..." : ""}`;
    }
    case "block":
      return "Block scope";
    case "module":
      return "Module scope";
    default:
      return "Unknown scope";
  }
}

/**
 * Creates naming batches from analysis results.
 * Groups symbols by scope and sorts scopes from largest to smallest.
 */
export function createNamingBatches(
  result: SymbolAnalysisResult,
  code: string,
  maxBatchSize: number = 20,
): NamingBatch[] {
  const batches: NamingBatch[] = [];

  // Get scopes sorted by size (largest first)
  const sortedScopes = getScopesSortedBySize(result);

  for (const scope of sortedScopes) {
    const scopeBindings = scope.bindingIds
      .map((id) => result.bindings.get(id))
      .filter((b): b is SymbolBinding => b !== undefined)
      .filter((b) => shouldRenameBinding(b));

    if (scopeBindings.length === 0) continue;

    const scopeSummary = createScopeSummary(scope, code);

    // Split into batches if too many symbols
    for (let i = 0; i < scopeBindings.length; i += maxBatchSize) {
      const batchBindings = scopeBindings.slice(i, i + maxBatchSize);
      const symbols = batchBindings.map(createSymbolDossier);

      batches.push({
        scopeSummary,
        scopeId: scope.id,
        symbols,
      });
    }
  }

  return batches;
}

/**
 * Determines if a binding should be renamed.
 */
export function shouldRenameBinding(binding: SymbolBinding): boolean {
  // Skip bindings that might be affected by dynamic features
  if (binding.hasDynamicAccess) {
    return false;
  }

  // Skip imported bindings (they have meaningful names from external modules)
  if (binding.kind === "import") {
    return false;
  }

  // Skip single-letter or very short names that are likely minified
  // (Actually, we WANT to rename these, so this is inverted logic)
  // Let's rename everything except imports and dynamic-access bindings
  return true;
}

/**
 * Gets scopes sorted by size (largest first).
 */
function getScopesSortedBySize(result: SymbolAnalysisResult): ScopeInfo[] {
  const scopes = [...result.scopes.values()];
  scopes.sort((a, b) => b.end - b.start - (a.end - a.start));
  return scopes;
}

/**
 * Formats a symbol dossier as a string for LLM input.
 */
export function formatDossierForLLM(dossier: SymbolDossier): string {
  const parts: string[] = [];

  parts.push(`Variable: \`${dossier.name}\``);
  parts.push(`Kind: ${dossier.kind}`);

  if (dossier.typeHints.length > 0) {
    parts.push(`Type hints: ${dossier.typeHints.join(", ")}`);
  }

  parts.push(`Usage: ${dossier.useSummary}`);
  parts.push(`Context:\n\`\`\`javascript\n${dossier.surroundingCode}\n\`\`\``);

  return parts.join("\n");
}

/**
 * Formats a batch for LLM input.
 */
export function formatBatchForLLM(batch: NamingBatch): string {
  const parts: string[] = [];

  parts.push(`## Scope: ${batch.scopeSummary}\n`);
  parts.push(`Rename the following ${batch.symbols.length} identifiers:\n`);

  for (const symbol of batch.symbols) {
    parts.push(`---\n${formatDossierForLLM(symbol)}\n`);
  }

  return parts.join("\n");
}

import { toIdentifier } from "@babel/types";
import type {
  CandidateName,
  NamingStyle,
  RenameSymbol,
  ScopeMeta,
} from "./types";

const RESERVED_WORDS = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "let",
  "static",
  "enum",
  "await",
  "implements",
  "package",
  "protected",
  "interface",
  "private",
  "public",
  "null",
  "true",
  "false",
]);

export function solveRenamePlan(args: {
  symbols: RenameSymbol[];
  suggestionsBySymbolId: Map<string, CandidateName[]>;
  scopeMetaById: Map<string, ScopeMeta>;
  unsafeScopeIds: Set<string>;
}): Map<string, string> {
  const { symbols, suggestionsBySymbolId, scopeMetaById, unsafeScopeIds } =
    args;

  const symbolsByScope = new Map<string, RenameSymbol[]>();
  for (const s of symbols) {
    const arr = symbolsByScope.get(s.scopeId) ?? [];
    arr.push(s);
    symbolsByScope.set(s.scopeId, arr);
  }

  // Names allocated (final) per scope.
  const allocatedByScope = new Map<string, Set<string>>();
  for (const scopeId of scopeMetaById.keys()) {
    allocatedByScope.set(scopeId, new Set<string>());
  }

  // Final mapping for all symbols (including "no change").
  const finalNameBySymbolId = new Map<string, string>();

  // Pre-fill unsafe scopes: keep original names in those scopes.
  for (const s of symbols) {
    if (unsafeScopeIds.has(s.scopeId)) {
      finalNameBySymbolId.set(s.id, s.originalName);
      allocatedByScope.get(s.scopeId)?.add(s.originalName);
    }
  }

  // Solve from outer to inner scopes so we can avoid introducing new shadowing.
  const scopesInOrder = Array.from(scopeMetaById.values()).sort(
    (a, b) => a.depth - b.depth || a.id.localeCompare(b.id),
  );

  for (const scopeMeta of scopesInOrder) {
    const scopeId = scopeMeta.id;
    const scopeSymbols = symbolsByScope.get(scopeId) ?? [];
    if (scopeSymbols.length === 0) continue;

    // Build candidate lists upfront and compute a "keep original" confidence.
    const candidatesBySymbol = new Map<
      string,
      Array<{ name: string; confidence: number }>
    >();
    const keepOriginalConfidenceBySymbol = new Map<string, number>();

    for (const s of scopeSymbols) {
      // Already fixed by unsafe scope policy
      if (finalNameBySymbolId.has(s.id)) continue;

      const rawCandidates = suggestionsBySymbolId.get(s.id) ?? [];

      const style = inferNamingStyle(s, rawCandidates);

      const processed = normalizeCandidates(rawCandidates, style);

      // Always include original as a low-confidence fallback.
      const originalNormalized = sanitizeIdentifier(s.originalName, style);
      processed.push({ name: originalNormalized, confidence: 0 });

      // Dedupe, keep highest confidence.
      const deduped = new Map<string, number>();
      for (const c of processed) {
        const prev = deduped.get(c.name);
        if (prev == null || c.confidence > prev)
          deduped.set(c.name, c.confidence);
      }

      const list = Array.from(deduped.entries())
        .map(([name, confidence]) => ({ name, confidence }))
        .sort(
          (a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name),
        );

      candidatesBySymbol.set(s.id, list);

      const keepConf =
        list.find((c) => c.name === originalNormalized)?.confidence ?? 0;
      keepOriginalConfidenceBySymbol.set(s.id, keepConf);
    }

    const allocatedHere = allocatedByScope.get(scopeId) ?? new Set<string>();

    // Prefer keeping names that already "belong" to a binding when the LLM suggests it.
    // Then prioritize importance (fan-out).
    const renameOrder = scopeSymbols
      .filter((s) => !finalNameBySymbolId.has(s.id))
      .sort((a, b) => {
        const ka = keepOriginalConfidenceBySymbol.get(a.id) ?? 0;
        const kb = keepOriginalConfidenceBySymbol.get(b.id) ?? 0;
        if (ka !== kb) return kb - ka;

        if (a.importance !== b.importance) return b.importance - a.importance;

        const sa = a.bindingPath.node.start ?? 0;
        const sb = b.bindingPath.node.start ?? 0;
        if (sa !== sb) return sa - sb;

        return a.id.localeCompare(b.id);
      });

    for (const s of renameOrder) {
      const list = candidatesBySymbol.get(s.id) ?? [];

      const style = inferNamingStyle(s, suggestionsBySymbolId.get(s.id) ?? []);
      const originalNormalized = sanitizeIdentifier(s.originalName, style);
      const preferredFallback = originalNormalized;

      const keepConf = keepOriginalConfidenceBySymbol.get(s.id) ?? 0;

      const desiredAll = list.map((c) => c.name);

      // If the model did not explicitly endorse keeping the current name, treat
      // the original identifier as a last-resort fallback. This prevents us from
      // "giving up" and keeping minified names just because the top suggestion
      // collides with another symbol in the same scope.
      let desired = desiredAll;
      if (keepConf <= 0 && desiredAll.length > 1) {
        const filtered = desiredAll.filter((n) => n !== originalNormalized);
        if (filtered.length > 0) desired = filtered;
      }

      // Prefer a non-conflicting candidate when possible; otherwise, take the
      // best candidate and disambiguate it (e.g. foo -> _foo) deterministically.
      const pick =
        desired.find(
          (name) =>
            !isTakenInScopeChain(
              name,
              scopeId,
              allocatedByScope,
              scopeMetaById,
              allocatedHere,
            ),
        ) ?? undefined;

      const base = ensureNotReserved(pick ?? desired[0] ?? preferredFallback);

      const unique = makeUniqueInScopeChain(
        base,
        scopeId,
        allocatedByScope,
        scopeMetaById,
        allocatedHere,
      );

      finalNameBySymbolId.set(s.id, unique);
      allocatedHere.add(unique);
    }

    allocatedByScope.set(scopeId, allocatedHere);
  }

  // Ensure all symbols have an entry.
  for (const s of symbols) {
    if (!finalNameBySymbolId.has(s.id)) {
      finalNameBySymbolId.set(s.id, s.originalName);
    }
  }

  return finalNameBySymbolId;
}

function normalizeCandidates(
  candidates: CandidateName[],
  style: NamingStyle,
): Array<{ name: string; confidence: number }> {
  const out: Array<{ name: string; confidence: number }> = [];
  for (const c of candidates) {
    const confidence = clamp(c.confidence, 0, 1);
    const name = sanitizeIdentifier(c.name, style);
    if (name.length === 0) continue;

    out.push({ name: ensureNotReserved(name), confidence });
  }
  return out;
}

function inferNamingStyle(
  symbol: RenameSymbol,
  candidates: CandidateName[],
): NamingStyle {
  if (symbol.kind === "class") return "pascalCase";

  if (symbol.kind === "function") {
    // If used with `new`, treat as constructor-like.
    const refs: any[] = symbol.binding?.referencePaths ?? [];
    const constructed = refs.some(
      (r) => r?.parentPath?.isNewExpression?.() && r.key === "callee",
    );
    return constructed ? "pascalCase" : "camelCase";
  }

  // For consts, only use UPPER_SNAKE when the model suggests constant-like names.
  if (symbol.kind === "const") {
    const anyUpperSnake = candidates.some((c) => looksLikeUpperSnake(c.name));
    return anyUpperSnake ? "upperSnakeCase" : "camelCase";
  }

  return "camelCase";
}

function looksLikeUpperSnake(name: string): boolean {
  const s = name.trim();
  if (s.length === 0) return false;
  if (!s.includes("_")) return false;
  return /^[A-Z0-9_]+$/.test(s);
}

function sanitizeIdentifier(raw: string, style: NamingStyle): string {
  // 1) Make it a valid identifier baseline.
  const base = toIdentifier(raw);
  const { prefix, core } = splitLeadingUnderscores(base);

  // 2) Style-normalize.
  const styledCore = applyStyle(core, style);

  // 3) Re-apply underscores (often used for collision/reserved fixes).
  const combined = `${prefix}${styledCore}`.trim();

  return ensureNotReserved(combined);
}

function applyStyle(name: string, style: NamingStyle): string {
  if (name.length === 0) return "";

  const words = splitIntoWords(name);
  if (words.length === 0) return name;

  if (style === "camelCase") {
    const [first, ...rest] = words;
    return [
      first!.toLowerCase(),
      ...rest.map((w) => capitalize(w.toLowerCase())),
    ].join("");
  }

  if (style === "pascalCase") {
    return words.map((w) => capitalize(w.toLowerCase())).join("");
  }

  // upperSnakeCase
  return words.map((w) => w.toUpperCase()).join("_");
}

function splitIntoWords(name: string): string[] {
  // Split underscores/spaces, then split camelCase transitions.
  const normalized = name
    .replace(/[^a-zA-Z0-9_]+/g, " ")
    .replace(/_/g, " ")
    .trim();

  if (normalized.length === 0) return [];

  const parts = normalized.split(/\s+/g);

  const words: string[] = [];
  for (const part of parts) {
    // Insert splits between lower->upper or digit->alpha.
    const withSpaces = part
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");

    for (const w of withSpaces.split(/\s+/g)) {
      if (w.length > 0) words.push(w);
    }
  }
  return words;
}

function splitLeadingUnderscores(name: string): {
  prefix: string;
  core: string;
} {
  const match = name.match(/^_+/);
  const prefix = match?.[0] ?? "";
  const core = name.slice(prefix.length);
  return { prefix, core };
}

function ensureNotReserved(name: string): string {
  if (!RESERVED_WORDS.has(name)) return name;
  return `_${name}`;
}

function makeUniqueInScopeChain(
  base: string,
  scopeId: string,
  allocatedByScope: Map<string, Set<string>>,
  scopeMetaById: Map<string, ScopeMeta>,
  allocatedHere: Set<string>,
): string {
  let name = ensureNotReserved(base);

  while (
    isTakenInScopeChain(
      name,
      scopeId,
      allocatedByScope,
      scopeMetaById,
      allocatedHere,
    )
  ) {
    name = `_${name}`;
  }

  return name;
}

function isTakenInScopeChain(
  name: string,
  scopeId: string,
  allocatedByScope: Map<string, Set<string>>,
  scopeMetaById: Map<string, ScopeMeta>,
  allocatedHere: Set<string>,
): boolean {
  // Current scope
  if (allocatedHere.has(name)) return true;

  // Ancestors
  let current: string | undefined = scopeMetaById.get(scopeId)?.parentId;
  while (current) {
    const set = allocatedByScope.get(current);
    if (set?.has(name)) return true;
    current = scopeMetaById.get(current)?.parentId;
  }

  return false;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s[0]!.toUpperCase() + s.slice(1);
}

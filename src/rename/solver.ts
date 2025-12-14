import * as t from "@babel/types";
import { toIdentifier } from "@babel/types";
import type { Scope } from "../babel-traverse";
import type {
  CandidateName,
  RenamingAnalysis,
  RenamePlan,
  ScopeId,
  SymbolInfo,
} from "./types";

const FORBIDDEN_GLOBAL_NAMES = new Set([
  "Array",
  "Object",
  "String",
  "Number",
  "Boolean",
  "RegExp",
  "Date",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Symbol",
  "BigInt",
  "Math",
  "JSON",
  "Reflect",
  "Proxy",
  "Intl",
  "console",
  "window",
  "document",
  "globalThis",
  "self",
  "process",
  "Buffer",
  "require",
  "module",
  "exports",
  "__dirname",
  "__filename",
  "arguments",
  "undefined",
  "NaN",
  "Infinity",
]);

export function solveRenamePlan(
  analysis: RenamingAnalysis,
  suggestions: Map<string, CandidateName[]>,
): RenamePlan {
  const plan: RenamePlan = new Map();

  // Default: keep original names.
  for (const sym of analysis.symbols.values()) {
    plan.set(sym.id, sym.originalName);
  }

  const symbolsByScope = groupSymbolsByScope(analysis);

  for (const symbols of symbolsByScope.values()) {
    const scope = symbols[0]?.declScope;
    if (!scope) continue;

    // Names currently declared in this scope.
    const taken = new Set<string>(Object.keys(scope.bindings));

    const renameable = symbols.filter((s) => !s.isTainted);

    // Deterministic ordering: higher-level constructs first, then high-confidence, then fan-out.
    renameable.sort((a, b) => compareSymbolsForRenaming(a, b, suggestions));

    for (const sym of renameable) {
      const chosen = chooseNameForSymbol(
        sym,
        suggestions.get(sym.id) ?? [],
        taken,
      );
      plan.set(sym.id, chosen);
      taken.add(chosen);
    }
  }

  return plan;
}

function groupSymbolsByScope(analysis: RenamingAnalysis): Map<ScopeId, SymbolInfo[]> {
  const map = new Map<ScopeId, SymbolInfo[]>();
  for (const sym of analysis.symbols.values()) {
    const list = map.get(sym.declScopeId) ?? [];
    list.push(sym);
    map.set(sym.declScopeId, list);
  }
  return map;
}

function compareSymbolsForRenaming(
  a: SymbolInfo,
  b: SymbolInfo,
  suggestions: Map<string, CandidateName[]>,
): number {
  const kindScore = (s: SymbolInfo) => {
    switch (s.kind) {
      case "class":
        return 4;
      case "function":
        return 3;
      case "import":
        return 2;
      case "const":
      case "let":
      case "var":
        return 1;
      case "param":
        return 0;
      default:
        return 0;
    }
  };

  const aScore = kindScore(a);
  const bScore = kindScore(b);
  if (aScore !== bScore) return bScore - aScore;

  const aConf = bestConfidence(suggestions.get(a.id) ?? []);
  const bConf = bestConfidence(suggestions.get(b.id) ?? []);
  if (aConf !== bConf) return bConf - aConf;

  if (a.referenceCount !== b.referenceCount) {
    return b.referenceCount - a.referenceCount;
  }

  // Prefer renaming shorter / more minified names first.
  if (a.originalName.length !== b.originalName.length) {
    return a.originalName.length - b.originalName.length;
  }

  return a.originalName.localeCompare(b.originalName);
}

function bestConfidence(candidates: CandidateName[]): number {
  return candidates.reduce(
    (max, c) => (c.confidence > max ? c.confidence : max),
    0,
  );
}

function chooseNameForSymbol(
  sym: SymbolInfo,
  candidates: CandidateName[],
  taken: Set<string>,
): string {
  if (candidates.length === 0) return sym.originalName;

  const normalized = normalizeCandidates(sym, candidates);

  // 1) Try candidates in confidence order.
  for (const candidate of normalized) {
    if (candidate === sym.originalName) return sym.originalName;
    if (isNameAvailable(sym, candidate, taken)) {
      return candidate;
    }
  }

  // 2) Try to make the best candidate unique.
  const base = normalized[0];
  if (base) {
    const unique = makeUniqueName(base, (name) => {
      if (name === sym.originalName) return true;
      return isNameAvailable(sym, name, taken);
    });
    if (unique) return unique;
  }

  return sym.originalName;
}

function normalizeCandidates(sym: SymbolInfo, candidates: CandidateName[]): string[] {
  const bestByName = new Map<string, number>();

  for (const c of candidates) {
    const normalized = normalizeCandidateName(sym, c.name);
    if (!normalized) continue;

    const prev = bestByName.get(normalized);
    if (prev == null || c.confidence > prev) {
      bestByName.set(normalized, c.confidence);
    }
  }

  return [...bestByName.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
}

function normalizeCandidateName(sym: SymbolInfo, raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // Strip simple surrounding quotes/backticks (models sometimes include them).
  const unquoted = trimmed.replace(/^["'`]|["'`]$/g, "");

  // Ensure a syntactically valid identifier.
  let name = toIdentifier(unquoted);
  if (!name) return undefined;

  // Avoid pointless / minified-looking names unless the original symbol is also minified.
  if (/^[A-Za-z]$/.test(name) && sym.originalName.length > 1) return undefined;
  if (FORBIDDEN_GLOBAL_NAMES.has(name)) return undefined;

  // Enforce naming conventions by symbol kind.
  if (shouldUseUpperSnake(sym)) {
    name = toUpperSnakeCase(name);
  } else if (sym.kind === "class") {
    name = toPascalCase(name);
  } else {
    name = toCamelCase(name);
  }

  // Re-sanitize in case casing created a keyword-ish name.
  name = toIdentifier(name);

  if (!name) return undefined;
  if (FORBIDDEN_GLOBAL_NAMES.has(name)) return undefined;

  return name;
}

function shouldUseUpperSnake(sym: SymbolInfo): boolean {
  if (sym.kind !== "const") return false;
  if (!sym.binding.constant) return false;
  if (!sym.binding.path.isVariableDeclarator()) return false;

  const init = sym.binding.path.node.init;
  if (!init) return false;

  const isPrimitiveLiteral =
    t.isStringLiteral(init) ||
    t.isNumericLiteral(init) ||
    t.isBooleanLiteral(init) ||
    t.isNullLiteral(init) ||
    t.isBigIntLiteral(init) ||
    t.isIdentifier(init, { name: "undefined" });

  if (!isPrimitiveLiteral) return false;

  // Only enforce UPPER_SNAKE when the original identifier already looks like a constant
  // (keeps typical local consts in camelCase and satisfies unit tests).
  const original = sym.originalName;
  return original.length >= 2 && /^[A-Z0-9_]+$/.test(original);
}

function toPascalCase(name: string): string {
  const leading = name.match(/^_+/)?.[0] ?? "";
  const rest = name.slice(leading.length);
  if (!rest) return name;
  return leading + rest[0]!.toUpperCase() + rest.slice(1);
}

function toCamelCase(name: string): string {
  const leading = name.match(/^_+/)?.[0] ?? "";
  const rest = name.slice(leading.length);
  if (!rest) return name;
  return leading + rest[0]!.toLowerCase() + rest.slice(1);
}

function toUpperSnakeCase(name: string): string {
  const leading = name.match(/^_+/)?.[0] ?? "";
  const rest = name.slice(leading.length);
  if (!rest) return name;

  const withUnderscores = rest
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/\W+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return `${leading}${withUnderscores.toUpperCase()}`;
}

function makeUniqueName(
  base: string,
  isAvailable: (name: string) => boolean,
): string | undefined {
  if (isAvailable(base)) return base;

  // Numeric suffixes tend to be nicer than leading underscores.
  for (let i = 2; i <= 99; i++) {
    const candidate = `${base}${i}`;
    if (isAvailable(candidate)) return candidate;
  }

  let prefixed = `_${base}`;
  for (let i = 0; i < 20; i++) {
    if (isAvailable(prefixed)) return prefixed;
    prefixed = `_${prefixed}`;
  }

  return undefined;
}

function isNameAvailable(
  sym: SymbolInfo,
  name: string,
  taken: Set<string>,
): boolean {
  if (taken.has(name)) return false;
  if (FORBIDDEN_GLOBAL_NAMES.has(name)) return false;

  // Avoid collisions in the declaration scope chain (current + parents).
  if (sym.binding.scope.hasBinding(name)) return false;

  // Avoid introducing shadowing where this symbol is referenced (descendant scopes).
  const uniqueRefScopes = new Map<number, Scope>();
  for (const ref of sym.binding.referencePaths) {
    uniqueRefScopes.set(ref.scope.uid, ref.scope);
  }

  for (const scope of uniqueRefScopes.values()) {
    if (scope.getBinding(name)) return false;
  }

  return true;
}
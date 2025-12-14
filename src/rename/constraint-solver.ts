import { toIdentifier } from "@babel/types";
import type { NameCandidate, NameStyle, ScopeId, SymbolId } from "./types";

export type SymbolForNaming = {
  symbolId: SymbolId;
  scopeId: ScopeId;
  originalName: string;
  nameStyle: NameStyle;

  // Higher means more important (more references / fan-out).
  importance: number;
};

type NormalizedCandidate = {
  name: string;
  score: number;
};

// Penalty per underscore we have to prefix to make a name unique within a scope.
// This nudges the solver to prefer a good alternative candidate (e.g. "baz")
// over "_foo" when the score difference is small, while still preferring "_foo"
// over falling back to the original minified name.
const UNDERSCORE_PENALTY = 0.2;

export function normalizeCandidateName(raw: string, style: NameStyle): string {
  const trimmed = raw.trim();
  const safe = toIdentifier(trimmed.length > 0 ? trimmed : "_");

  if (style === "upper_snake") {
    const upperSnake = toUpperSnakeCase(safe);
    return toIdentifier(upperSnake);
  }

  if (style === "pascal") {
    return applyCaseToFirstAlpha(safe, "upper");
  }

  return applyCaseToFirstAlpha(safe, "lower");
}

export function solveSymbolNames({
  symbols,
  suggestions,
  occupiedByScope,
}: {
  symbols: SymbolForNaming[];
  suggestions: Map<SymbolId, NameCandidate[]>;
  occupiedByScope: Map<ScopeId, Set<string>>;
}): Map<SymbolId, string> {
  const byScope = new Map<ScopeId, SymbolForNaming[]>();
  for (const s of symbols) {
    const list = byScope.get(s.scopeId) ?? [];
    list.push(s);
    byScope.set(s.scopeId, list);
  }

  const result = new Map<SymbolId, string>();

  for (const [scopeId, scopeSymbols] of byScope) {
    const occupied = new Set<string>(occupiedByScope.get(scopeId) ?? []);

    // Build candidate lists.
    const candidatesBySymbol = new Map<SymbolId, NormalizedCandidate[]>();
    for (const s of scopeSymbols) {
      const raw = suggestions.get(s.symbolId) ?? [];
      const normalized = normalizeCandidates(s, raw);

      // Always allow "keep original" as a fallback.
      const originalNormalized = normalizeCandidateName(
        s.originalName,
        s.nameStyle,
      );
      if (!normalized.some((c) => c.name === originalNormalized)) {
        normalized.push({ name: originalNormalized, score: 0 });
      }

      candidatesBySymbol.set(s.symbolId, normalized);
    }

    const assigned =
      scopeSymbols.length <= 12
        ? solveExact(scopeSymbols, candidatesBySymbol, occupied)
        : solveHeuristic(scopeSymbols, candidatesBySymbol, occupied);

    for (const [symbolId, name] of assigned) {
      result.set(symbolId, name);
    }
  }

  return result;
}

function normalizeCandidates(
  symbol: SymbolForNaming,
  rawCandidates: NameCandidate[],
): NormalizedCandidate[] {
  const bestByName = new Map<string, number>();

  for (const c of rawCandidates) {
    const normalizedName = normalizeCandidateName(c.name, symbol.nameStyle);
    const confidence = clamp(c.confidence, 0, 1);

    // Favor candidates for high fan-out symbols slightly.
    const score = confidence * (1 + Math.min(1, symbol.importance / 25));

    const prev = bestByName.get(normalizedName);
    if (prev == null || score > prev) {
      bestByName.set(normalizedName, score);
    }
  }

  const list: NormalizedCandidate[] = [...bestByName.entries()].map(
    ([name, score]) => ({
      name,
      score,
    }),
  );

  // Sort by score desc, then name asc for determinism.
  list.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return list;
}

function solveExact(
  symbols: SymbolForNaming[],
  candidatesBySymbol: Map<SymbolId, NormalizedCandidate[]>,
  occupied: Set<string>,
): Map<SymbolId, string> {
  // Most-constrained first for better pruning.
  const ordered = [...symbols].sort((a, b) => {
    const aLen = (candidatesBySymbol.get(a.symbolId) ?? []).length;
    const bLen = (candidatesBySymbol.get(b.symbolId) ?? []).length;
    if (aLen !== bLen) return aLen - bLen;

    // Higher importance earlier.
    if (a.importance !== b.importance) return b.importance - a.importance;

    return a.symbolId.localeCompare(b.symbolId);
  });

  const bestAssignment = new Map<SymbolId, string>();
  let bestScore = Number.NEGATIVE_INFINITY;

  const current = new Map<SymbolId, string>();
  const used = new Set<string>(occupied);

  // Upper bound pruning: assume each remaining symbol can take its best base score.
  const bestRemainingScore = ordered.map((s) => {
    const cands = candidatesBySymbol.get(s.symbolId) ?? [];
    const best = cands[0]?.score ?? 0;
    return best;
  });

  const suffixBest = new Array<number>(bestRemainingScore.length + 1).fill(0);
  for (let i = bestRemainingScore.length - 1; i >= 0; i--) {
    suffixBest[i] = (suffixBest[i + 1] ?? 0) + bestRemainingScore[i]!;
  }

  const dfs = (idx: number, scoreSoFar: number) => {
    if (idx >= ordered.length) {
      if (scoreSoFar > bestScore) {
        bestScore = scoreSoFar;
        bestAssignment.clear();
        for (const [k, v] of current) bestAssignment.set(k, v);
      }
      return;
    }

    // Upper bound pruning.
    if (scoreSoFar + suffixBest[idx]! <= bestScore) return;

    const sym = ordered[idx]!;
    const baseCands = candidatesBySymbol.get(sym.symbolId) ?? [];

    // For the current used-set, compute the best unique variant per resulting name.
    const bestByFinalName = new Map<
      string,
      { name: string; score: number; addedUnderscores: number }
    >();

    for (const cand of baseCands) {
      const { name: uniqueName, addedUnderscores } = makeUniqueWithCount(
        cand.name,
        used,
      );
      const adjustedScore = cand.score - addedUnderscores * UNDERSCORE_PENALTY;

      const prev = bestByFinalName.get(uniqueName);
      if (
        !prev ||
        adjustedScore > prev.score ||
        (adjustedScore === prev.score &&
          addedUnderscores < prev.addedUnderscores)
      ) {
        bestByFinalName.set(uniqueName, {
          name: uniqueName,
          score: adjustedScore,
          addedUnderscores,
        });
      }
    }

    const options = [...bestByFinalName.values()].sort((a, b) => {
      // Higher adjusted score first.
      if (a.score !== b.score) return b.score - a.score;
      // Fewer added underscores is preferred.
      if (a.addedUnderscores !== b.addedUnderscores) {
        return a.addedUnderscores - b.addedUnderscores;
      }
      // Deterministic by name.
      return a.name.localeCompare(b.name);
    });

    for (const opt of options) {
      if (used.has(opt.name)) continue;

      used.add(opt.name);
      current.set(sym.symbolId, opt.name);

      dfs(idx + 1, scoreSoFar + opt.score);

      current.delete(sym.symbolId);
      used.delete(opt.name);
    }
  };

  dfs(0, 0);

  // Safety: ensure every symbol has a name (should always hold).
  const out = new Map<SymbolId, string>();
  const usedOut = new Set<string>(occupied);

  for (const s of symbols) {
    const chosen = bestAssignment.get(s.symbolId);
    const base =
      chosen ??
      candidatesBySymbol.get(s.symbolId)?.[0]?.name ??
      normalizeCandidateName(s.originalName, s.nameStyle);

    const unique = makeUnique(base, usedOut);
    usedOut.add(unique);
    out.set(s.symbolId, unique);
  }

  return out;
}

function solveHeuristic(
  symbols: SymbolForNaming[],
  candidatesBySymbol: Map<SymbolId, NormalizedCandidate[]>,
  occupied: Set<string>,
): Map<SymbolId, string> {
  const ordered = [...symbols].sort((a, b) => {
    // Higher importance first.
    if (a.importance !== b.importance) return b.importance - a.importance;
    return a.symbolId.localeCompare(b.symbolId);
  });

  const out = new Map<SymbolId, string>();
  const used = new Set<string>(occupied);

  for (const s of ordered) {
    const cands = candidatesBySymbol.get(s.symbolId) ?? [];

    let bestName: string | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestAddedUnderscores = Number.POSITIVE_INFINITY;

    for (const cand of cands) {
      const { name: uniqueName, addedUnderscores } = makeUniqueWithCount(
        cand.name,
        used,
      );
      const adjustedScore = cand.score - addedUnderscores * UNDERSCORE_PENALTY;

      if (
        adjustedScore > bestScore ||
        (adjustedScore === bestScore &&
          addedUnderscores < bestAddedUnderscores) ||
        (adjustedScore === bestScore &&
          addedUnderscores === bestAddedUnderscores &&
          uniqueName.localeCompare(bestName ?? uniqueName) < 0)
      ) {
        bestScore = adjustedScore;
        bestAddedUnderscores = addedUnderscores;
        bestName = uniqueName;
      }
    }

    const finalName =
      bestName ??
      makeUnique(normalizeCandidateName(s.originalName, s.nameStyle), used);

    used.add(finalName);
    out.set(s.symbolId, finalName);
  }

  return out;
}

function makeUniqueWithCount(
  base: string,
  used: Set<string>,
): { name: string; addedUnderscores: number } {
  let name = base;
  let added = 0;
  while (used.has(name)) {
    name = `_${name}`;
    added++;
  }
  return { name, addedUnderscores: added };
}

function makeUnique(base: string, used: Set<string>): string {
  return makeUniqueWithCount(base, used).name;
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function toUpperSnakeCase(name: string): string {
  // Insert underscores between lower->upper transitions and uppercase.
  // Preserve existing underscores.
  const withUnderscores = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/__+/g, "_");
  return withUnderscores.toUpperCase();
}

function applyCaseToFirstAlpha(name: string, mode: "lower" | "upper"): string {
  // Preserve leading underscores (often used to avoid collisions/reserved words),
  // but enforce casing on the first alphabetic character.
  const chars = [...name];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (/[A-Za-z]/.test(ch)) {
      chars[i] = mode === "lower" ? ch.toLowerCase() : ch.toUpperCase();
      return chars.join("");
    }
  }
  return name;
}

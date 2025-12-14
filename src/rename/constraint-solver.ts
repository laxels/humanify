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
      const originalNormalized = normalizeCandidateName(s.originalName, s.nameStyle);
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

  const list: NormalizedCandidate[] = [...bestByName.entries()].map(([name, score]) => ({
    name,
    score,
  }));

  // Sort by score desc, then name asc for determinism.
  list.sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));

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

  const bestRemainingScore = ordered.map((s) => {
    const cands = candidatesBySymbol.get(s.symbolId) ?? [];
    const best = cands[0]?.score ?? 0;
    return best;
  });

  const suffixBest = new Array<number>(bestRemainingScore.length + 1).fill(0);
  for (let i = bestRemainingScore.length - 1; i >= 0; i--) {
    suffixBest[i] = suffixBest[i + 1] + bestRemainingScore[i]!;
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
    const cands = candidatesBySymbol.get(sym.symbolId) ?? [];

    for (const cand of cands) {
      if (used.has(cand.name)) continue;

      used.add(cand.name);
      current.set(sym.symbolId, cand.name);

      dfs(idx + 1, scoreSoFar + cand.score);

      current.delete(sym.symbolId);
      used.delete(cand.name);
    }
  };

  dfs(0, 0);

  // Ensure every symbol has a name (fallback: make unique from its best candidate).
  const out = new Map<SymbolId, string>();
  const usedOut = new Set<string>(occupied);

  for (const s of symbols) {
    const chosen = bestAssignment.get(s.symbolId);
    const base = chosen ?? (candidatesBySymbol.get(s.symbolId)?.[0]?.name ?? s.originalName);
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

  const choiceIndex = new Map<SymbolId, number>();
  const chosen = new Map<SymbolId, string>();

  for (const s of ordered) {
    choiceIndex.set(s.symbolId, 0);
    const first = candidatesBySymbol.get(s.symbolId)?.[0]?.name ?? s.originalName;
    chosen.set(s.symbolId, first);
  }

  // Iteratively resolve collisions by pushing losers to their next candidate.
  for (let iter = 0; iter < 100; iter++) {
    const byName = new Map<string, SymbolForNaming[]>();

    for (const s of ordered) {
      const name = chosen.get(s.symbolId) ?? s.originalName;
      const list = byName.get(name) ?? [];
      list.push(s);
      byName.set(name, list);
    }

    let changed = false;

    for (const [name, ss] of byName) {
      const conflicts = ss.length > 1 || occupied.has(name);
      if (!conflicts) continue;

      // Pick winner:
      // - If name is occupied, there is no winner; everyone must move.
      // - Else keep the highest score/importance as winner.
      let winners: Set<SymbolId> = new Set();

      if (!occupied.has(name) && ss.length > 0) {
        const sorted = [...ss].sort((a, b) => {
          const aIdx = choiceIndex.get(a.symbolId) ?? 0;
          const bIdx = choiceIndex.get(b.symbolId) ?? 0;
          const aScore = candidatesBySymbol.get(a.symbolId)?.[aIdx]?.score ?? 0;
          const bScore = candidatesBySymbol.get(b.symbolId)?.[bIdx]?.score ?? 0;
          if (aScore !== bScore) return bScore - aScore;
          if (a.importance !== b.importance) return b.importance - a.importance;
          return a.symbolId.localeCompare(b.symbolId);
        });
        winners = new Set([sorted[0]!.symbolId]);
      }

      for (const s of ss) {
        if (winners.has(s.symbolId)) continue;

        const cands = candidatesBySymbol.get(s.symbolId) ?? [];
        let idx = (choiceIndex.get(s.symbolId) ?? 0) + 1;
        if (idx >= cands.length) idx = cands.length - 1;

        if (idx !== (choiceIndex.get(s.symbolId) ?? 0)) {
          choiceIndex.set(s.symbolId, idx);
          chosen.set(s.symbolId, cands[idx]?.name ?? s.originalName);
          changed = true;
        } else if (occupied.has(name)) {
          // Still stuck on an occupied name: force change marker to proceed to uniqueness stage.
          changed = true;
        }
      }
    }

    if (!changed) break;
  }

  // Final pass: make unique deterministically.
  const out = new Map<SymbolId, string>();
  const used = new Set<string>(occupied);

  for (const s of ordered) {
    const base = chosen.get(s.symbolId) ?? s.originalName;
    const unique = makeUnique(base, used);
    used.add(unique);
    out.set(s.symbolId, unique);
  }

  return out;
}

function makeUnique(base: string, used: Set<string>): string {
  let name = base;
  while (used.has(name)) {
    name = `_${name}`;
  }
  return name;
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

function applyCaseToFirstAlpha(
  name: string,
  mode: "lower" | "upper",
): string {
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
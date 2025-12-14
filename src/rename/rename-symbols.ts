import { parseAsync, transformFromAstAsync } from "@babel/core";
import type { Node } from "@babel/types";
import { applyRenamePlan } from "./apply-renames";
import {
  detachModuleInterfaceNames,
  expandRenamedObjectShorthands,
  preserveExportedDeclarations,
  scopeIdFromUid,
} from "./ast-fixes";
import { type SymbolForNaming, solveSymbolNames } from "./constraint-solver";
import { planRenameJobs } from "./plan-rename-jobs";
import { analyzeCode } from "./symbol-analysis";
import { buildSymbolDossier } from "./symbol-dossier";
import type {
  NameCandidate,
  SuggestNames,
  SymbolDossier,
  SymbolId,
  SymbolNameSuggestion,
} from "./types";

export type RenameSymbolsOptions = {
  contextWindowSize: number;
  suggestNames: SuggestNames;
  countInputTokens: (job: {
    chunkId: string;
    scopeSummary: string;
    symbols: SymbolDossier[];
  }) => Promise<number>;
  maxSymbolsPerJob: number;
  maxInputTokens: number;
  onProgress?: (done: number, total: number) => void;

  /**
   * Max number of concurrent scope-batch naming calls.
   * This parallelizes LLM calls without changing the deterministic constraint solving.
   */
  concurrency?: number;
};

export async function renameSymbols(
  code: string,
  {
    contextWindowSize,
    suggestNames,
    countInputTokens,
    maxSymbolsPerJob,
    maxInputTokens,
    onProgress,
    concurrency = 4,
  }: RenameSymbolsOptions,
): Promise<string> {
  const analyzed = await analyzeCode(code);

  const {
    ast,
    symbols,
    chunks,
    bindingToSymbolId,
    bindingIdentifierToSymbolId,
    exportDeclarationRecords,
  } = analyzed;

  const renameableSymbols = symbols.filter((s) => !s.isUnsafeToRename);
  const total = renameableSymbols.length;

  if (total === 0) {
    // Preserve exact input formatting for unit tests and avoid extra churn.
    return code;
  }

  const dossiersByChunkId = new Map<string, SymbolDossier[]>();
  const originalNameBySymbolId = new Map<SymbolId, string>();

  for (const s of symbols) {
    originalNameBySymbolId.set(s.id, s.originalName);
  }

  // Build dossiers for renameable symbols, grouped by chunk.
  for (const s of renameableSymbols) {
    const dossier = buildSymbolDossier(s, { contextWindowSize });

    const list = dossiersByChunkId.get(s.chunkId) ?? [];
    list.push(dossier);
    dossiersByChunkId.set(s.chunkId, list);
  }

  // Run scope-batch name suggestions (parallelized).
  let done = 0;

  const jobs = await planRenameJobs({
    chunks,
    dossiersByChunkId,
    maxSymbolsPerJob: Math.max(1, Math.floor(maxSymbolsPerJob)),
    maxInputTokens: Math.max(1, Math.floor(maxInputTokens)),
    countInputTokens,
  });

  const suggestionResults = await mapWithConcurrency(
    jobs,
    concurrency,
    async (job) => {
      const suggestions = await safeSuggestNames(suggestNames, job);
      done += job.symbols.length;
      onProgress?.(done, total);
      return suggestions;
    },
  );

  const candidatesBySymbolId = new Map<SymbolId, NameCandidate[]>();
  for (const suggestions of suggestionResults) {
    for (const s of suggestions) {
      candidatesBySymbolId.set(s.symbolId, s.candidates);
    }
  }

  // Build solver inputs.
  const occupiedByScope = new Map<string, Set<string>>();
  const solverSymbols: SymbolForNaming[] = [];

  for (const s of symbols) {
    const scopeId = scopeIdFromUid(s.declaringScopeUid);

    if (s.isUnsafeToRename) {
      // Unsafe symbols are "fixed": their original names are occupied.
      const set = occupiedByScope.get(scopeId) ?? new Set<string>();
      set.add(s.originalName);
      occupiedByScope.set(scopeId, set);
      continue;
    }

    solverSymbols.push({
      symbolId: s.id,
      scopeId,
      originalName: s.originalName,
      nameStyle: s.nameStyle,
      importance: s.binding.referencePaths?.length ?? 0,
    });
  }

  const solved = solveSymbolNames({
    symbols: solverSymbols,
    suggestions: candidatesBySymbolId,
    occupiedByScope,
  });

  // Build final rename plan (unsafe => unchanged).
  const renamePlan = new Map<SymbolId, string>();
  for (const s of symbols) {
    if (s.isUnsafeToRename) {
      renamePlan.set(s.id, s.originalName);
    } else {
      renamePlan.set(s.id, solved.get(s.id) ?? s.originalName);
    }
  }

  // AST safety rewrites before we apply renames.
  detachModuleInterfaceNames(ast);
  expandRenamedObjectShorthands({
    ast,
    bindingToSymbolId,
    bindingIdentifierToSymbolId,
    renamePlan,
    originalNameBySymbolId,
  });

  // Apply renames.
  applyRenamePlan(symbols, renamePlan);

  // Preserve named export interfaces post-rename.
  preserveExportedDeclarations(ast, exportDeclarationRecords);

  const output = await stringifyAst(ast, code);

  // Quick validation pass: ensure parseable output.
  await assertParseable(output);

  onProgress?.(total, total);

  return output;
}

async function safeSuggestNames(
  suggestNames: SuggestNames,
  job: { chunkId: string; scopeSummary: string; symbols: SymbolDossier[] },
): Promise<SymbolNameSuggestion[]> {
  try {
    const suggestions = await suggestNames(job);

    // Be defensive: ensure shape and that we only include known symbols.
    const known = new Set(job.symbols.map((s) => s.symbolId));
    const cleaned: SymbolNameSuggestion[] = [];

    for (const s of suggestions ?? []) {
      if (!known.has(s.symbolId)) continue;
      const candidates = Array.isArray(s.candidates) ? s.candidates : [];
      cleaned.push({ symbolId: s.symbolId, candidates });
    }

    return cleaned;
  } catch (err) {
    console.error("Failed to suggest names for chunk", job.chunkId, err);
    // If a batch fails, fall back to "no suggestions" for that chunk.
    // The solver will keep original names for missing suggestions.
    return job.symbols.map((s) => ({
      symbolId: s.symbolId,
      candidates: [{ name: s.originalName, confidence: 0 }],
    }));
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array<R>(items.length);

  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const currentIndex = nextIndex++;
        if (currentIndex >= items.length) break;
        results[currentIndex] = await fn(items[currentIndex]!, currentIndex);
      }
    },
  );

  await Promise.all(workers);
  return results;
}

async function stringifyAst(ast: Node, originalCode: string): Promise<string> {
  const result = await transformFromAstAsync(ast, originalCode, {
    compact: false,
    minified: false,
    comments: false,
    sourceMaps: false,
    retainLines: false,
  });

  if (!result?.code) {
    throw new Error("Failed to stringify code");
  }
  return result.code;
}

async function assertParseable(code: string): Promise<void> {
  const parsed = await parseAsync(code, { sourceType: "unambiguous" });
  if (!parsed) {
    throw new Error("Validation failed: output is not parseable");
  }
}

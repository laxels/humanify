import { parseAsync, transformFromAstAsync } from "@babel/core";
import type { Node } from "@babel/types";
import { createTimer, timedAsync, timedSync, verbose } from "../verbose";
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
  declarationSnippetMaxLength: number;
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
    declarationSnippetMaxLength,
    suggestNames,
    countInputTokens,
    maxSymbolsPerJob,
    maxInputTokens,
    onProgress,
    concurrency = 4,
  }: RenameSymbolsOptions,
): Promise<string> {
  const totalTimer = createTimer("Total renameSymbols");
  totalTimer.start();

  verbose.log(`renameSymbols input size: ${(code.length / 1024).toFixed(1)}KB`);

  const analyzed = await timedAsync("Code analysis (AST + symbol table)", () =>
    analyzeCode(code),
  );

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

  verbose.log(
    `Found ${symbols.length} total symbols, ${total} renameable, ${symbols.length - total} unsafe`,
  );

  if (total === 0) {
    verbose.log("No renameable symbols, returning original code");
    return code;
  }

  const dossiersByChunkId = new Map<string, SymbolDossier[]>();
  const originalNameBySymbolId = new Map<SymbolId, string>();

  for (const s of symbols) {
    originalNameBySymbolId.set(s.id, s.originalName);
  }

  // Build dossiers for renameable symbols, grouped by chunk.
  const dossierStart = performance.now();
  for (const s of renameableSymbols) {
    const dossier = buildSymbolDossier(s, { declarationSnippetMaxLength });

    const list = dossiersByChunkId.get(s.chunkId) ?? [];
    list.push(dossier);
    dossiersByChunkId.set(s.chunkId, list);
  }
  verbose.log(
    `Built ${total} symbol dossiers in ${(performance.now() - dossierStart).toFixed(0)}ms`,
  );

  // Run scope-batch name suggestions (parallelized).
  let done = 0;

  const jobs = await timedAsync("Job planning (with token counting)", () =>
    planRenameJobs({
      chunks,
      dossiersByChunkId,
      maxSymbolsPerJob: Math.max(1, Math.floor(maxSymbolsPerJob)),
      maxInputTokens: Math.max(1, Math.floor(maxInputTokens)),
      countInputTokens,
    }),
  );

  verbose.log(
    `Planned ${jobs.length} LLM job(s) for ${total} symbols (concurrency: ${concurrency})`,
  );

  const llmTimer = createTimer(`LLM name suggestions (${jobs.length} jobs)`);
  llmTimer.start();

  const suggestionResults = await mapWithConcurrency(
    jobs,
    concurrency,
    async (job, index) => {
      verbose.log(
        `Starting LLM job ${index + 1}/${jobs.length} (${job.symbols.length} symbols)`,
      );
      const jobStart = performance.now();
      const suggestions = await safeSuggestNames(suggestNames, job);
      verbose.log(
        `Completed LLM job ${index + 1}/${jobs.length} in ${(performance.now() - jobStart).toFixed(0)}ms`,
      );
      done += job.symbols.length;
      onProgress?.(done, total);
      return suggestions;
    },
  );

  llmTimer.stop();

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

  const solved = timedSync(
    `Constraint solving (${solverSymbols.length} symbols, ${occupiedByScope.size} scopes)`,
    () =>
      solveSymbolNames({
        symbols: solverSymbols,
        suggestions: candidatesBySymbolId,
        occupiedByScope,
      }),
  );

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
  timedSync("AST fix: detachModuleInterfaceNames", () =>
    detachModuleInterfaceNames(ast),
  );
  timedSync("AST fix: expandRenamedObjectShorthands", () =>
    expandRenamedObjectShorthands({
      ast,
      bindingToSymbolId,
      bindingIdentifierToSymbolId,
      renamePlan,
      originalNameBySymbolId,
    }),
  );

  // Apply renames.
  timedSync(`Applying ${renamePlan.size} renames via Babel`, () =>
    applyRenamePlan(symbols, renamePlan),
  );

  // Preserve named export interfaces post-rename.
  timedSync("AST fix: preserveExportedDeclarations", () =>
    preserveExportedDeclarations(ast, exportDeclarationRecords),
  );

  const output = await timedAsync("AST stringification", () =>
    stringifyAst(ast, code),
  );

  // Quick validation pass: ensure parseable output.
  await timedAsync("Validation parse", () => assertParseable(output));

  onProgress?.(total, total);

  totalTimer.stop();
  verbose.log(`Output size: ${(output.length / 1024).toFixed(1)}KB`);

  return output;
}

async function safeSuggestNames(
  suggestNames: SuggestNames,
  job: { chunkId: string; scopeSummary: string; symbols: SymbolDossier[] },
): Promise<SymbolNameSuggestion[]> {
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

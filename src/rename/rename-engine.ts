import { parseAsync } from "@babel/core";
import { chunkArray, mapWithConcurrency } from "../async-utils";
import { env } from "../env";
import { parseNumber } from "../number-utils";
import { verbose } from "../verbose";
import { analyzeRenaming, getBabelParseOptions } from "./analyze";
import { applyRenamePlan } from "./apply";
import { buildDossiersByChunk } from "./dossier";
import { solveRenamePlan } from "./solver";
import type {
  CandidateName,
  ChunkInfo,
  NameSuggestionProvider,
  RenamingAnalysis,
  ScopeSuggestionResponse,
  SymbolDossier,
  SymbolId,
} from "./types";

export type RenameEngineOptions = {
  contextWindowSize: number;

  maxCandidatesPerSymbol?: number;
  llmConcurrency?: number;
  symbolsPerBatch?: number;

  onProgress?: (done: number, total: number) => void;
};

const DEFAULT_MAX_CANDIDATES = 5;
const DEFAULT_LLM_CONCURRENCY = 4;
const DEFAULT_SYMBOLS_PER_BATCH = 24;

export async function renameIdentifiersWithProvider(
  code: string,
  options: RenameEngineOptions,
  provider: NameSuggestionProvider,
): Promise<string> {
  const maxCandidatesPerSymbol =
    options.maxCandidatesPerSymbol ?? DEFAULT_MAX_CANDIDATES;

  const llmConcurrency =
    options.llmConcurrency ??
    tryParseNumber(env("HUMANIFY_LLM_CONCURRENCY"), DEFAULT_LLM_CONCURRENCY);

  const symbolsPerBatch =
    options.symbolsPerBatch ??
    tryParseNumber(
      env("HUMANIFY_SYMBOLS_PER_BATCH"),
      DEFAULT_SYMBOLS_PER_BATCH,
    );

  const analysis = await analyzeRenaming(code, options.contextWindowSize);

  // Only ask the LLM about symbols we are allowed to rename.
  const dossiersByChunk = buildDossiersByChunk(
    analysis,
    options.contextWindowSize,
  );
  const tasks = buildSuggestionTasks(
    analysis,
    dossiersByChunk,
    symbolsPerBatch,
    maxCandidatesPerSymbol,
  );

  if (tasks.totalSymbols === 0) {
    return code;
  }

  let done = 0;
  options.onProgress?.(done, tasks.totalSymbols);

  const responses = await mapWithConcurrency(
    tasks.items,
    llmConcurrency,
    async (task) => {
      const response = await provider({
        chunk: task.chunk,
        dossiers: task.dossiers,
        maxCandidates: task.maxCandidates,
      }).catch((err) => {
        verbose.log("LLM suggestion batch failed", err);
        return {
          suggestions: task.dossiers.map((d) => ({ id: d.id, candidates: [] })),
        } as ScopeSuggestionResponse;
      });

      done += task.dossiers.length;
      options.onProgress?.(done, tasks.totalSymbols);

      return response;
    },
  );

  const suggestions = mergeSuggestions(responses);

  const plan = solveRenamePlan(analysis, suggestions);

  const renamed = await applyRenamePlan(analysis, plan);

  // Validation pass: ensure parseable output. If we produced invalid syntax for any reason,
  // fall back to the original code for safety (pipeline will still format it later).
  const validated = await validateParseable(renamed).catch((err) => {
    verbose.log("Validation parse failed; returning original code", err);
    return code;
  });

  options.onProgress?.(tasks.totalSymbols, tasks.totalSymbols);
  return validated;
}

type SuggestionTask = {
  chunk: ChunkInfo;
  dossiers: SymbolDossier[];
  maxCandidates: number;
};

function buildSuggestionTasks(
  analysis: RenamingAnalysis,
  dossiersByChunk: Map<string, SymbolDossier[]>,
  symbolsPerBatch: number,
  maxCandidates: number,
): { items: SuggestionTask[]; totalSymbols: number } {
  const items: SuggestionTask[] = [];
  let total = 0;

  for (const [chunkId, dossiers] of dossiersByChunk.entries()) {
    const chunk = analysis.chunks.get(chunkId);
    if (!chunk) continue;

    // Skip tainted symbols; we won't rename them.
    const renameable = dossiers.filter((d) => {
      const sym = analysis.symbols.get(d.id);
      return sym != null && !sym.isTainted;
    });

    if (renameable.length === 0) continue;

    const batches = chunkArray(renameable, symbolsPerBatch);
    for (const batch of batches) {
      items.push({ chunk, dossiers: batch, maxCandidates });
      total += batch.length;
    }
  }

  return { items, totalSymbols: total };
}

function mergeSuggestions(
  responses: ScopeSuggestionResponse[],
): Map<SymbolId, CandidateName[]> {
  const out = new Map<SymbolId, CandidateName[]>();

  for (const res of responses) {
    for (const s of res.suggestions) {
      out.set(s.id, s.candidates ?? []);
    }
  }

  return out;
}

async function validateParseable(code: string): Promise<string> {
  const ast = await parseAsync(code, getBabelParseOptions());
  if (!ast) {
    throw new Error("Validation parse returned null AST");
  }
  return code;
}

function tryParseNumber(value: string | undefined, fallback: number): number {
  if (value == null) return fallback;
  try {
    return parseNumber(value);
  } catch {
    return fallback;
  }
}

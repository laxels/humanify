import { verbose } from "../verbose";
import { solveConstraints, validateDecisions } from "./constraint-solver";
import type { NamingResult } from "./llm-namer";
import { nameChunkGroups } from "./llm-namer";
import { applyRenamesWithShorthandHandling } from "./rename-applier";
import {
  chunkByScope,
  groupChunksForParallelProcessing,
} from "./scope-chunker";
import type { SymbolDossier } from "./symbol-dossier";
import { extractDossiersForSymbols } from "./symbol-dossier";
import { buildSymbolTable, getAllSymbolsSortedByScope } from "./symbol-table";
import { fullValidation } from "./validator";

export type RenameOptions = {
  model?: string;
  contextWindowSize: number;
  maxSymbolsPerChunk?: number;
  enableParallelProcessing?: boolean;
};

export async function renameIdentifiers(
  code: string,
  options: RenameOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const {
    model,
    contextWindowSize,
    maxSymbolsPerChunk = 10,
    enableParallelProcessing = true,
  } = options;

  verbose.log("Building symbol table...");

  // Step 1: Build symbol table and scope graph
  const table = await buildSymbolTable(code);

  verbose.log(
    `Found ${table.symbols.size} symbols in ${table.scopes.size} scopes`,
  );

  if (table.symbols.size === 0) {
    verbose.log("No symbols to rename");
    return code;
  }

  // Step 2: Extract symbol dossiers
  verbose.log("Extracting symbol dossiers...");
  const allSymbols = getAllSymbolsSortedByScope(table);
  const dossiers = extractDossiersForSymbols(allSymbols, table);

  // Create a map for quick lookup
  const dossierMap = new Map<string, SymbolDossier>();
  for (const dossier of dossiers) {
    dossierMap.set(dossier.symbolId, dossier);
  }

  verbose.log(`Extracted ${dossiers.length} dossiers`);

  // Step 3: Chunk by scope
  verbose.log("Chunking by scope...");
  const chunks = chunkByScope(table, dossierMap, {
    maxSymbolsPerChunk,
    maxContextLength: contextWindowSize,
  });

  verbose.log(`Created ${chunks.length} chunks`);

  if (chunks.length === 0) {
    verbose.log("No chunks to process");
    return code;
  }

  // Step 4: Group chunks for parallel processing
  let namingResults: NamingResult[];

  if (enableParallelProcessing) {
    verbose.log("Grouping chunks for parallel processing...");
    const groups = groupChunksForParallelProcessing(chunks, table);
    verbose.log(`Created ${groups.length} parallel groups`);

    // Step 5: Process chunk groups (parallel within groups, sequential between)
    verbose.log("Calling LLM for naming suggestions...");
    namingResults = await nameChunkGroups(groups, { model }, onProgress);
  } else {
    // Sequential processing for debugging
    verbose.log("Processing chunks sequentially...");
    namingResults = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const { nameChunk } = await import("./llm-namer");
      const result = await nameChunk(chunk, { model });
      namingResults.push(result);
      onProgress?.(i + 1, chunks.length);
    }
  }

  // Log any errors
  for (const result of namingResults) {
    if (result.error) {
      verbose.log(`Error in chunk ${result.chunk.scopeId}: ${result.error}`);
    }
  }

  // Step 6: Solve constraints
  verbose.log("Solving naming constraints...");
  const decisions = solveConstraints(table, namingResults, {
    enforceNamingConventions: true,
    minConfidenceThreshold: 0.3,
  });

  verbose.log(`Made ${decisions.length} rename decisions`);

  // Validate decisions
  const decisionValidation = validateDecisions(table, decisions);
  if (!decisionValidation.valid) {
    verbose.log(
      "Decision validation errors:",
      decisionValidation.errors.join(", "),
    );
  }

  if (decisions.length === 0) {
    verbose.log("No renames to apply");
    return code;
  }

  // Step 7: Apply renames
  verbose.log("Applying renames...");
  const applyResult = await applyRenamesWithShorthandHandling(table, decisions);

  verbose.log(
    `Applied ${applyResult.appliedRenames} renames, skipped ${applyResult.skippedRenames}`,
  );

  if (applyResult.errors.length > 0) {
    verbose.log("Apply errors:", applyResult.errors.join(", "));
  }

  // Step 8: Validate output
  verbose.log("Validating output...");
  const validation = await fullValidation(applyResult.code);

  if (!validation.valid) {
    verbose.log("Validation errors:", validation.errors.join(", "));
  }

  if (validation.warnings.length > 0) {
    verbose.log("Validation warnings:", validation.warnings.join(", "));
  }

  return applyResult.code;
}

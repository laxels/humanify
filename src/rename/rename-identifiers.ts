import { verbose } from "../verbose";
import { applyRenamesDirect } from "./apply-renames";
import { solveConstraints } from "./constraint-solver";
import { getNamingSuggestionsParallel } from "./llm-naming";
import { analyzeSymbols } from "./symbol-analysis";
import { createNamingBatches } from "./symbol-dossier";
import type {
  ConstraintSolverOptions,
  LLMNamingOptions,
  SymbolAnalysisOptions,
} from "./types";
import { quickValidate, validateOutput } from "./validation";

export type RenameIdentifiersOptions = {
  model?: string;
  contextWindowSize: number;
  maxConcurrency?: number;
  maxBatchSize?: number;
};

/**
 * Renames identifiers in JavaScript/TypeScript code using LLM suggestions.
 *
 * Pipeline:
 * 1. Analyze symbols (build scope tree, symbol table, reference map)
 * 2. Create symbol dossiers and batch by scope
 * 3. Get naming suggestions from LLM (parallelized)
 * 4. Solve constraints (avoid collisions, apply conventions)
 * 5. Apply renames to AST
 * 6. Validate output
 */
export async function renameIdentifiers(
  code: string,
  options: RenameIdentifiersOptions,
  onProgress?: (stage: string, done: number, total: number) => void,
): Promise<string> {
  const {
    model,
    contextWindowSize,
    maxConcurrency = 100,
    maxBatchSize = 20,
  } = options;

  // Handle empty code
  if (!code.trim()) {
    return code;
  }

  // Step 1: Analyze symbols
  verbose.log("Step 1: Analyzing symbols...");
  onProgress?.("Analyzing symbols", 0, 1);

  const analysisOptions: SymbolAnalysisOptions = {
    contextLines: Math.ceil(contextWindowSize / 80), // Approximate lines from character count
  };

  const analysisResult = await analyzeSymbols(code, analysisOptions);

  verbose.log(
    `Found ${analysisResult.bindings.size} bindings in ${analysisResult.scopes.size} scopes`,
  );

  if (analysisResult.hasDynamicFeatures) {
    verbose.log(
      "Warning: Code contains dynamic features (eval/with). Some bindings may be skipped.",
    );
  }

  onProgress?.("Analyzing symbols", 1, 1);

  // Step 2: Create naming batches
  verbose.log("Step 2: Creating naming batches...");
  onProgress?.("Creating batches", 0, 1);

  const batches = createNamingBatches(analysisResult, code, maxBatchSize);

  verbose.log(`Created ${batches.length} batches`);

  if (batches.length === 0) {
    verbose.log("No identifiers to rename");
    return code;
  }

  onProgress?.("Creating batches", 1, 1);

  // Step 3: Get naming suggestions (parallelized)
  verbose.log("Step 3: Getting naming suggestions from LLM...");

  const llmOptions: LLMNamingOptions = {
    model,
    batchSize: maxBatchSize,
    candidatesPerSymbol: 3,
  };

  const namingResults = await getNamingSuggestionsParallel(
    batches,
    llmOptions,
    maxConcurrency,
    (done, total) => onProgress?.("Getting suggestions", done, total),
  );

  verbose.log(`Got ${namingResults.length} naming results`);

  // Step 4: Solve constraints
  verbose.log("Step 4: Solving naming constraints...");
  onProgress?.("Solving constraints", 0, 1);

  const constraintOptions: ConstraintSolverOptions = {
    enforceCamelCase: true,
    enforcePascalCase: true,
    enforceConstantCase: false,
    minConfidence: 0.1,
  };

  const resolvedRenames = solveConstraints(
    analysisResult,
    namingResults,
    constraintOptions,
  );

  verbose.log(`Resolved ${resolvedRenames.length} renames`);

  if (resolvedRenames.length === 0) {
    verbose.log("No renames to apply");
    return code;
  }

  onProgress?.("Solving constraints", 1, 1);

  // Step 5: Apply renames
  verbose.log("Step 5: Applying renames to AST...");
  onProgress?.("Applying renames", 0, 1);

  const renamedCode = await applyRenamesDirect(analysisResult, resolvedRenames);

  onProgress?.("Applying renames", 1, 1);

  // Step 6: Validate output
  verbose.log("Step 6: Validating output...");
  onProgress?.("Validating", 0, 1);

  const isValid = await quickValidate(renamedCode);

  if (!isValid) {
    verbose.log("Warning: Output validation failed, returning original code");
    const validationResult = await validateOutput(renamedCode, resolvedRenames);
    for (const error of validationResult.errors) {
      verbose.log(`  Error: ${error.message}`);
    }
    return code;
  }

  // Full validation for warnings
  const validationResult = await validateOutput(renamedCode, resolvedRenames);
  for (const warning of validationResult.warnings) {
    verbose.log(`  Warning: ${warning.message}`);
  }

  onProgress?.("Validating", 1, 1);

  verbose.log("Done renaming identifiers");

  return renamedCode;
}

export { applyRenames, applyRenamesDirect } from "./apply-renames";
export { solveConstraints, validateRenames } from "./constraint-solver";
export {
  getNamingSuggestionsForBatch,
  isValidIdentifier,
  sanitizeIdentifier,
} from "./llm-naming";
// Re-export for backward compatibility with tests
export { analyzeSymbols } from "./symbol-analysis";
export { createNamingBatches, createSymbolDossier } from "./symbol-dossier";
export type * from "./types";
export {
  quickValidate,
  validateOutput,
  verifySemanticEquivalence,
} from "./validation";

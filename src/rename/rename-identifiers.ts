import { analyzeCode } from "../analysis/scope-analyzer";
import { extractSymbolDossiers } from "../analysis/symbol-dossier";
import { verbose } from "../verbose";
import { applyRenames, createRenameSummary } from "./apply-renames";
import { processAllScopes } from "./batch-rename";
import { solveConstraints, validateRenames } from "./constraint-solver";
import { quickValidate } from "./validator";

export type RenameOptions = {
  /** Model to use for LLM calls */
  model?: string;
  /** Context window size (kept for backwards compatibility, not used in new approach) */
  contextWindowSize?: number;
  /** Maximum number of concurrent scope processing */
  maxConcurrency?: number;
  /** Minimum confidence threshold for renames */
  minConfidence?: number;
};

/**
 * Renames identifiers in JavaScript code using the new AST + scope graph approach.
 *
 * The pipeline:
 * 1. Parse AST and build scope graph + symbol table
 * 2. Extract symbol dossiers with use-site analysis
 * 3. Batch LLM calls per scope (parallelized)
 * 4. Global constraint solving for name reconciliation
 * 5. Apply renames via AST transform
 * 6. Validate output
 */
export async function renameIdentifiers(
  code: string,
  options: RenameOptions = {},
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const { model, maxConcurrency = 5, minConfidence = 0 } = options;

  // Handle empty code
  if (!code || code.trim().length === 0) {
    return code;
  }

  verbose.log("Step 1: Analyzing code and building scope graph...");

  // Step 1: Parse AST and build scope graph + symbol table
  const analyzeResult = await analyzeCode(code);
  const { ast, symbolTable } = analyzeResult;

  verbose.log(`Found ${symbolTable.scopes.size} scopes`);

  // Step 2: Extract symbol dossiers
  verbose.log("Step 2: Extracting symbol dossiers...");
  const dossiers = extractSymbolDossiers(ast, analyzeResult);

  verbose.log(`Found ${dossiers.size} bindings to process`);

  // If no bindings, return original code
  if (dossiers.size === 0) {
    return code;
  }

  // Step 3: Get rename suggestions from LLM (parallelized by scope)
  verbose.log("Step 3: Getting rename suggestions from LLM...");
  const renameResults = await processAllScopes(
    symbolTable,
    { model },
    maxConcurrency,
    onProgress,
  );

  verbose.log(`Got suggestions for ${renameResults.renames.length} bindings`);

  // Step 4: Solve constraints to get final names
  verbose.log("Step 4: Solving naming constraints...");
  const resolvedRenames = solveConstraints(symbolTable, renameResults, {
    minConfidence,
  });

  // Validate the constraint solution
  const validation = validateRenames(resolvedRenames, symbolTable);
  if (!validation.valid) {
    verbose.log("Constraint validation errors:", validation.errors);
    throw new Error(
      `Constraint validation failed: ${validation.errors.join(", ")}`,
    );
  }

  verbose.log("Rename summary:\n" + createRenameSummary(resolvedRenames));

  // Step 5: Apply renames to AST
  verbose.log("Step 5: Applying renames to AST...");
  const renamedCode = await applyRenames(ast, resolvedRenames, symbolTable);

  // Step 6: Validate output
  verbose.log("Step 6: Validating output...");
  const outputValidation = await quickValidate(renamedCode);
  if (!outputValidation.valid) {
    verbose.log(`Output validation failed: ${outputValidation.error}`);
    // Don't throw, just log warning - the code might still be usable
    verbose.log("Warning: Output validation failed, but continuing...");
  }

  return renamedCode;
}

import { formatDossiersForBatch } from "../analysis/symbol-dossier";
import type {
  BatchRenameResult,
  BindingId,
  NameCandidate,
  ScopeInfo,
  SymbolDossier,
  SymbolTable,
} from "../analysis/types";
import { anthropicToolUse } from "../anthropic/tool-use";
import { verbose } from "../verbose";

const MAX_BATCH_SIZE = 15;
const MAX_SCOPE_CONTEXT_SIZE = 3000;

export type BatchRenameOptions = {
  model?: string;
  maxTokens?: number;
  thinkingBudget?: number;
};

type LLMRenameResponse = {
  renames: Array<{
    originalName: string;
    candidates: Array<{
      name: string;
      confidence: number;
      rationale: string;
    }>;
  }>;
};

/**
 * Creates the system prompt for batch renaming.
 */
export function createBatchRenameSystemPrompt(): string {
  return `You are an expert JavaScript developer tasked with renaming minified/obfuscated variable and function names to be more descriptive and readable.

For each identifier provided, suggest up to 3 candidate names ranked by confidence.

Guidelines:
- Use camelCase for variables and functions
- Use PascalCase for classes
- Use UPPER_SNAKE_CASE for constants (if clearly a constant value)
- Prefer descriptive names that indicate purpose/role
- For handlers, use prefixes like "on", "handle"
- For predicates, use prefixes like "is", "has", "should", "can"
- For getters, use "get" prefix
- For setters, use "set" prefix
- Keep names concise but meaningful
- If the purpose is truly unclear, use a generic but appropriate name

Respond with exactly the names of the original identifiers provided, mapped to their candidate names.`;
}

/**
 * Creates the content/user prompt for a batch of symbols.
 */
export function createBatchRenameContent(
  scopeContext: string,
  dossiers: SymbolDossier[],
): string {
  const dossiersText = formatDossiersForBatch(dossiers);

  let content = `## Scope Context\n\`\`\`javascript\n${scopeContext}\n\`\`\`\n\n`;
  content += `## Identifiers to Rename\n\n${dossiersText}`;

  return content;
}

/**
 * Creates the tool definition for batch renaming.
 */
export function createBatchRenameTool(dossiers: SymbolDossier[]) {
  return {
    name: "suggest_renames",
    description: "Provide rename suggestions for the identifiers",
    input_schema: {
      type: "object" as const,
      properties: {
        renames: {
          type: "array",
          items: {
            type: "object",
            properties: {
              originalName: {
                type: "string",
                description: "The original identifier name being renamed",
              },
              candidates: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: {
                      type: "string",
                      description: "Suggested new name",
                    },
                    confidence: {
                      type: "number",
                      description: "Confidence score from 0 to 1",
                    },
                    rationale: {
                      type: "string",
                      description: "Brief explanation for this suggestion",
                    },
                  },
                  required: ["name", "confidence", "rationale"],
                },
                minItems: 1,
                maxItems: 3,
              },
            },
            required: ["originalName", "candidates"],
          },
        },
      },
      required: ["renames"],
    },
  };
}

/**
 * Calls the LLM to get rename suggestions for a batch of symbols.
 */
export async function callLLMForBatch(
  scopeContext: string,
  dossiers: SymbolDossier[],
  options: BatchRenameOptions = {},
): Promise<Map<string, NameCandidate[]>> {
  const { model, maxTokens, thinkingBudget } = options;

  const response = await anthropicToolUse<LLMRenameResponse>({
    model,
    maxTokens,
    thinkingBudget,
    system: createBatchRenameSystemPrompt(),
    content: createBatchRenameContent(scopeContext, dossiers),
    tool: createBatchRenameTool(dossiers),
  });

  const result = new Map<string, NameCandidate[]>();

  for (const rename of response.renames) {
    result.set(rename.originalName, rename.candidates);
  }

  return result;
}

/**
 * Groups dossiers into batches of appropriate size.
 */
export function batchDossiers(
  dossiers: SymbolDossier[],
  maxBatchSize = MAX_BATCH_SIZE,
): SymbolDossier[][] {
  const batches: SymbolDossier[][] = [];

  for (let i = 0; i < dossiers.length; i += maxBatchSize) {
    batches.push(dossiers.slice(i, i + maxBatchSize));
  }

  return batches;
}

/**
 * Gets the appropriate scope context, truncating if necessary.
 */
export function getScopeContextForBatch(
  scope: ScopeInfo,
  maxSize = MAX_SCOPE_CONTEXT_SIZE,
): string {
  if (scope.code.length <= maxSize) {
    return scope.code;
  }
  return scope.code.slice(0, maxSize) + "\n// ... truncated";
}

/**
 * Processes a single scope, calling the LLM for all its bindings.
 * Returns a map from binding ID to candidate names.
 */
export async function processScope(
  scope: ScopeInfo,
  dossiers: SymbolDossier[],
  options: BatchRenameOptions = {},
  onProgress?: (completed: number, total: number) => void,
): Promise<Map<BindingId, NameCandidate[]>> {
  const result = new Map<BindingId, NameCandidate[]>();

  if (dossiers.length === 0) {
    return result;
  }

  // Create a map from original name to binding ID for lookup
  const nameToId = new Map<string, BindingId>();
  for (const dossier of dossiers) {
    nameToId.set(dossier.originalName, dossier.id);
  }

  const scopeContext = getScopeContextForBatch(scope);
  const batches = batchDossiers(dossiers);

  let completed = 0;
  const total = dossiers.length;

  // Process batches sequentially to maintain order (could parallelize if needed)
  for (const batch of batches) {
    verbose.log(
      `Processing batch of ${batch.length} identifiers in scope ${scope.summary}`,
    );

    const candidates = await callLLMForBatch(scopeContext, batch, options);

    // Map results back to binding IDs
    for (const [originalName, nameCandidates] of candidates) {
      const bindingId = nameToId.get(originalName);
      if (bindingId) {
        result.set(bindingId, nameCandidates);
      }
    }

    completed += batch.length;
    onProgress?.(completed, total);
  }

  return result;
}

/**
 * Processes all scopes in parallel (at the scope level).
 * Scopes are processed in order of size (largest first) but different scopes
 * can be processed concurrently.
 */
export async function processAllScopes(
  symbolTable: SymbolTable,
  options: BatchRenameOptions = {},
  maxConcurrency = 100,
  onProgress?: (completed: number, total: number) => void,
): Promise<BatchRenameResult> {
  const allCandidates: BatchRenameResult = { renames: [] };

  // Get all scopes that have bindings
  const scopesWithBindings = Array.from(symbolTable.scopes.values())
    .filter((scope) => scope.bindingIds.length > 0)
    .sort((a, b) => b.size - a.size); // Largest first

  // Collect all dossiers that need processing
  const dossiersByScope = new Map<string, SymbolDossier[]>();
  let totalBindings = 0;

  for (const scope of scopesWithBindings) {
    const scopeDossiers: SymbolDossier[] = [];

    for (const bindingId of scope.bindingIds) {
      const dossier = symbolTable.bindings.get(bindingId);
      if (dossier && !dossier.isUnsafe) {
        scopeDossiers.push(dossier);
        totalBindings++;
      }
    }

    if (scopeDossiers.length > 0) {
      dossiersByScope.set(scope.id, scopeDossiers);
    }
  }

  let completedBindings = 0;

  // Process scopes with controlled concurrency
  const scopesToProcess = scopesWithBindings.filter((s) =>
    dossiersByScope.has(s.id),
  );

  // Create a semaphore-like mechanism for concurrency control
  const results: Map<BindingId, NameCandidate[]>[] = [];

  for (let i = 0; i < scopesToProcess.length; i += maxConcurrency) {
    const batch = scopesToProcess.slice(i, i + maxConcurrency);

    const batchResults = await Promise.all(
      batch.map(async (scope) => {
        const dossiers = dossiersByScope.get(scope.id) || [];
        const scopeResult = await processScope(
          scope,
          dossiers,
          options,
          (done, _total) => {
            completedBindings += done;
            onProgress?.(completedBindings, totalBindings);
          },
        );
        return scopeResult;
      }),
    );

    results.push(...batchResults);
  }

  // Merge all results
  for (const scopeResult of results) {
    for (const [bindingId, candidates] of scopeResult) {
      allCandidates.renames.push({ bindingId, candidates });
    }
  }

  return allCandidates;
}

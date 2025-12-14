import { anthropicToolUse } from "../anthropic/tool-use";
import { verbose } from "../verbose";
import { formatBatchForLLM } from "./symbol-dossier";
import type {
  LLMNamingOptions,
  NamingBatch,
  SymbolNamingResult,
} from "./types";

const _DEFAULT_BATCH_SIZE = 20;
const DEFAULT_CANDIDATES_PER_SYMBOL = 3;

/**
 * Response schema for a single symbol's naming suggestions.
 */
type SymbolNamingSuggestion = {
  originalName: string;
  candidates: Array<{
    name: string;
    confidence: number;
    rationale: string;
  }>;
};

/**
 * Response schema from the LLM naming tool.
 */
type NamingToolResponse = {
  suggestions: SymbolNamingSuggestion[];
};

const SYSTEM_PROMPT = `You are an expert JavaScript/TypeScript developer tasked with renaming minified/obfuscated identifiers to descriptive, meaningful names.

Guidelines for naming:
1. Use camelCase for variables and functions
2. Use PascalCase for classes
3. Use UPPER_SNAKE_CASE for constants that are truly constant values
4. Names should be descriptive but concise (2-4 words typically)
5. Use common conventions:
   - Handlers: onXxx, handleXxx
   - Predicates: isXxx, hasXxx, canXxx, shouldXxx
   - Getters: getXxx
   - Setters: setXxx
   - Arrays/collections: xxxs, xxxList, xxxArray
   - Callbacks: onXxx, xxxCallback, xxxHandler
   - Counters: xxxCount, numXxx
   - Indices: xxxIndex, xxxIdx, i, j, k (for simple loops)
6. Consider the context and usage patterns to infer purpose
7. If the purpose is truly unclear, prefer generic but accurate names over misleading specific names

For each identifier, provide 1-3 candidate names ranked by confidence (0.0-1.0).
Higher confidence means you're more certain the name accurately reflects the identifier's purpose.`;

/**
 * Gets naming suggestions for a batch of symbols from the LLM.
 */
export async function getNamingSuggestionsForBatch(
  batch: NamingBatch,
  options: LLMNamingOptions = {},
): Promise<SymbolNamingResult[]> {
  const { model, candidatesPerSymbol = DEFAULT_CANDIDATES_PER_SYMBOL } =
    options;

  const content = formatBatchForLLM(batch);

  verbose.log(
    `Getting naming suggestions for batch with ${batch.symbols.length} symbols`,
  );
  verbose.log(`Batch content:\n${content}`);

  const response = await anthropicToolUse<NamingToolResponse>({
    model,
    system: SYSTEM_PROMPT,
    content,
    tool: {
      name: "suggest_names",
      description: "Provide naming suggestions for the identifiers",
      input_schema: {
        type: "object" as const,
        properties: {
          suggestions: {
            type: "array",
            description: "Naming suggestions for each identifier",
            items: {
              type: "object",
              properties: {
                originalName: {
                  type: "string",
                  description: "The original identifier name being renamed",
                },
                candidates: {
                  type: "array",
                  description: `Top ${candidatesPerSymbol} candidate names, ranked by confidence`,
                  items: {
                    type: "object",
                    properties: {
                      name: {
                        type: "string",
                        description: "The suggested name",
                      },
                      confidence: {
                        type: "number",
                        description: "Confidence score between 0.0 and 1.0",
                      },
                      rationale: {
                        type: "string",
                        description: "Brief explanation for this suggestion",
                      },
                    },
                    required: ["name", "confidence", "rationale"],
                  },
                },
              },
              required: ["originalName", "candidates"],
            },
          },
        },
        required: ["suggestions"],
      },
    },
  });

  verbose.log(`LLM response:`, JSON.stringify(response, null, 2));

  // Map response back to binding IDs
  const results: SymbolNamingResult[] = [];

  for (const symbol of batch.symbols) {
    const suggestion = response.suggestions.find(
      (s) => s.originalName === symbol.name,
    );

    if (suggestion) {
      results.push({
        bindingId: symbol.id,
        candidates: suggestion.candidates.map((c) => ({
          name: c.name,
          confidence: Math.max(0, Math.min(1, c.confidence)),
          rationale: c.rationale,
        })),
      });
    } else {
      // No suggestion found, keep original name with low confidence
      results.push({
        bindingId: symbol.id,
        candidates: [
          {
            name: symbol.name,
            confidence: 0.1,
            rationale: "No suggestion provided by LLM",
          },
        ],
      });
    }
  }

  return results;
}

/**
 * Gets naming suggestions for all batches in parallel.
 * Respects a maximum concurrency limit to avoid rate limiting.
 */
export async function getNamingSuggestionsParallel(
  batches: NamingBatch[],
  options: LLMNamingOptions = {},
  maxConcurrency: number = 100,
  onProgress?: (completed: number, total: number) => void,
): Promise<SymbolNamingResult[]> {
  const results: SymbolNamingResult[] = [];
  let completed = 0;
  const total = batches.length;

  // Process in chunks of maxConcurrency
  for (let i = 0; i < batches.length; i += maxConcurrency) {
    const chunk = batches.slice(i, i + maxConcurrency);
    const chunkPromises = chunk.map((batch) =>
      getNamingSuggestionsForBatch(batch, options),
    );

    const chunkResults = await Promise.all(chunkPromises);

    for (const batchResults of chunkResults) {
      results.push(...batchResults);
      completed++;
      onProgress?.(completed, total);
    }
  }

  return results;
}

/**
 * Validates that a suggested name is a valid JavaScript identifier.
 */
const RESERVED_WORDS = new Set([
  "break",
  "case",
  "catch",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "finally",
  "for",
  "function",
  "if",
  "in",
  "instanceof",
  "new",
  "return",
  "switch",
  "this",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "class",
  "const",
  "enum",
  "export",
  "extends",
  "import",
  "super",
  "implements",
  "interface",
  "let",
  "package",
  "private",
  "protected",
  "public",
  "static",
  "yield",
  "await",
  "async",
  "null",
  "true",
  "false",
]);

/**
 * Validates that a suggested name is a valid JavaScript identifier.
 */
export function isValidIdentifier(name: string): boolean {
  if (!name || name.length === 0) return false;

  // Check if it's a reserved word
  if (RESERVED_WORDS.has(name)) return false;

  // Check if it matches identifier pattern
  const identifierPattern = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
  return identifierPattern.test(name);
}

/**
 * Sanitizes a name to be a valid JavaScript identifier.
 */
export function sanitizeIdentifier(name: string): string {
  // Remove invalid characters (keeping alphanumeric, underscore, and dollar sign)
  let sanitized = name.replace(/[^a-zA-Z0-9_$]/g, "");

  // Ensure it doesn't start with a number
  if (/^[0-9]/.test(sanitized)) {
    sanitized = "_" + sanitized;
  }

  // Handle empty result or only $ signs (which would be valid but not descriptive)
  if (sanitized.length === 0 || /^\$+$/.test(sanitized)) {
    sanitized = "_unnamed";
  }

  // Handle reserved words
  if (RESERVED_WORDS.has(sanitized)) {
    sanitized = "_" + sanitized;
  }

  return sanitized;
}

/**
 * Converts a name to camelCase.
 */
export function toCamelCase(name: string): string {
  // Handle UPPER_SNAKE_CASE
  if (/^[A-Z][A-Z0-9_]*$/.test(name)) {
    return name
      .toLowerCase()
      .replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase());
  }

  // Handle PascalCase
  if (/^[A-Z]/.test(name) && !name.includes("_")) {
    return name.charAt(0).toLowerCase() + name.slice(1);
  }

  // Handle snake_case
  if (name.includes("_")) {
    return name
      .toLowerCase()
      .replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase());
  }

  return name;
}

/**
 * Converts a name to PascalCase.
 */
export function toPascalCase(name: string): string {
  const camel = toCamelCase(name);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

/**
 * Converts a name to UPPER_SNAKE_CASE.
 */
export function toUpperSnakeCase(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toUpperCase();
}

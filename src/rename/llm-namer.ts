import { anthropicToolUse } from "../anthropic/tool-use";
import { verbose } from "../verbose";
import type { ScopeChunk } from "./scope-chunker";

export type NameCandidate = {
  symbolId: string;
  originalName: string;
  newName: string;
  confidence: number;
  rationale: string;
};

export type NamingResult = {
  chunk: ScopeChunk;
  candidates: NameCandidate[];
  error?: string;
};

export type LLMNamerOptions = {
  model?: string;
  maxCandidatesPerSymbol?: number;
};

const SYSTEM_PROMPT = `You are an expert JavaScript developer tasked with renaming obfuscated/minified variable and function names to be more descriptive and readable.

Guidelines:
- Provide descriptive names based on how the variable/function is used
- Use camelCase for variables and functions
- Use PascalCase for classes
- Use UPPER_SNAKE_CASE for constants that hold primitive values
- Prefer short but meaningful names (2-4 words max)
- Common patterns:
  - Event handlers: onClick, onSubmit, handleClick
  - Predicates: isValid, hasItems, canSubmit
  - Callbacks: callback, cb, handler, fn
  - Loops: i, j, k for simple counters; item, element for iterators
  - Arrays: items, list, elements
  - Maps/Objects: map, cache, config
- If the purpose is unclear, make a reasonable guess based on usage context
- Rate your confidence (0-1) based on how certain you are of the name's accuracy`;

const TOOL_DEFINITION = {
  name: "suggest_names",
  description: "Suggest new names for the given symbols",
  input_schema: {
    type: "object" as const,
    properties: {
      suggestions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            symbolId: {
              type: "string",
              description: "The ID of the symbol being renamed",
            },
            originalName: {
              type: "string",
              description: "The original name of the symbol",
            },
            newName: {
              type: "string",
              description: "The suggested new name",
            },
            confidence: {
              type: "number",
              description: "Confidence in the suggestion (0-1)",
            },
            rationale: {
              type: "string",
              description: "Brief explanation for the name choice",
            },
          },
          required: [
            "symbolId",
            "originalName",
            "newName",
            "confidence",
            "rationale",
          ],
        },
        description: "List of name suggestions for each symbol",
      },
    },
    required: ["suggestions"],
  },
};

type LLMResponse = {
  suggestions: Array<{
    symbolId: string;
    originalName: string;
    newName: string;
    confidence: number;
    rationale: string;
  }>;
};

export async function nameChunk(
  chunk: ScopeChunk,
  options: LLMNamerOptions = {},
): Promise<NamingResult> {
  const { model } = options;

  const symbolList = chunk.dossiers
    .map((d) => `- ${d.symbolId}: ${d.originalName}`)
    .join("\n");

  const content = `${chunk.formattedPrompt}

Please suggest new names for these symbols:
${symbolList}`;

  try {
    verbose.log(
      `Naming chunk with ${chunk.dossiers.length} symbols in scope ${chunk.scopeSummary}`,
    );

    const result = await anthropicToolUse<LLMResponse>({
      model,
      system: SYSTEM_PROMPT,
      content,
      tool: TOOL_DEFINITION,
    });

    const candidates: NameCandidate[] = result.suggestions.map((s) => ({
      symbolId: s.symbolId,
      originalName: s.originalName,
      newName: s.newName,
      confidence: s.confidence,
      rationale: s.rationale,
    }));

    verbose.log(`Got ${candidates.length} name suggestions`);

    return { chunk, candidates };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    verbose.log(`Error naming chunk: ${errorMessage}`);

    return {
      chunk,
      candidates: [],
      error: errorMessage,
    };
  }
}

export async function nameChunksSequentially(
  chunks: ScopeChunk[],
  options: LLMNamerOptions = {},
  onProgress?: (done: number, total: number) => void,
): Promise<NamingResult[]> {
  const results: NamingResult[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;

    const result = await nameChunk(chunk, options);
    results.push(result);
    onProgress?.(i + 1, chunks.length);
  }

  return results;
}

export async function nameChunksInParallel(
  chunks: ScopeChunk[],
  options: LLMNamerOptions = {},
  concurrency = 5,
): Promise<NamingResult[]> {
  const results: NamingResult[] = [];

  // Process in batches to limit concurrency
  for (let i = 0; i < chunks.length; i += concurrency) {
    const batch = chunks.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((chunk) => nameChunk(chunk, options)),
    );
    results.push(...batchResults);
  }

  return results;
}

export async function nameChunkGroups(
  groups: ScopeChunk[][],
  options: LLMNamerOptions = {},
  onProgress?: (done: number, total: number) => void,
): Promise<NamingResult[]> {
  const results: NamingResult[] = [];
  const totalChunks = groups.reduce((sum, g) => sum + g.length, 0);
  let processedChunks = 0;

  // Process groups sequentially (dependencies between groups)
  // But within each group, process chunks in parallel
  for (const group of groups) {
    if (group.length === 1) {
      // Single chunk - just process it
      const result = await nameChunk(group[0]!, options);
      results.push(result);
      processedChunks += 1;
    } else {
      // Multiple chunks - process in parallel
      const groupResults = await Promise.all(
        group.map((chunk) => nameChunk(chunk, options)),
      );
      results.push(...groupResults);
      processedChunks += group.length;
    }

    onProgress?.(processedChunks, totalChunks);
  }

  return results;
}

import { anthropicToolUse } from "../anthropic/tool-use";
import { showProgress } from "../progress";
import { verbose } from "../verbose";
import { renameSymbols } from "./rename-symbols";
import type { SuggestNames, SymbolNameSuggestion } from "./types";

const TOP_K = 5;
const DEFAULT_CONCURRENCY = 100;

type AnthropicBatchRenameResponse = {
  suggestions: SymbolNameSuggestion[];
};

export async function renameIdentifiers(
  code: string,
  {
    model,
    contextWindowSize,
  }: {
    model?: string;
    contextWindowSize: number;
  },
): Promise<string> {
  const suggestNames: SuggestNames = async ({
    chunkId,
    scopeSummary,
    symbols,
  }) => {
    if (symbols.length === 0) return [];

    verbose.log(
      `Suggesting names for chunk ${chunkId} (${symbols.length} symbols)`,
    );

    const response = await anthropicToolUse<AnthropicBatchRenameResponse>({
      model,
      system: [
        "You are helping deobfuscate JavaScript by renaming minified identifiers.",
        "",
        "You will receive:",
        "- A scope summary (code snippet) for context",
        "- A list of symbol dossiers. Each dossier includes declaration snippet, usage summary, and type hints.",
        "",
        `For each symbolId, propose up to ${TOP_K} candidate names (top-k), ordered best-first.`,
        "Return a short rationale and a confidence score (0.0 to 1.0) per candidate.",
        "",
        "Naming rules:",
        "- Variables/functions/params: lower camelCase (e.g., userId, parseUrl)",
        "- Classes/constructors: PascalCase (e.g., UserService)",
        "- Obvious top-level primitive constants may be UPPER_SNAKE_CASE (e.g., MAX_RETRIES)",
        "- Names must be valid JavaScript identifiers and not reserved words",
        "- Avoid overly generic names unless uncertainty is high (e.g., prefer userId over value if evidence supports it)",
        "",
        "Do NOT include any extra keys; only return the tool response.",
      ].join("\n"),
      content: JSON.stringify(
        {
          scopeSummary,
          topK: TOP_K,
          symbols,
        },
        null,
        2,
      ),
      tool: {
        name: "suggest_names",
        description: "Suggest top-k descriptive names for each symbol",
        input_schema: {
          type: "object" as const,
          properties: {
            suggestions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  symbolId: { type: "string" },
                  candidates: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        name: { type: "string" },
                        confidence: {
                          type: "number",
                          minimum: 0,
                          maximum: 1,
                        },
                        rationale: { type: "string" },
                      },
                      required: ["name", "confidence"],
                    },
                  },
                },
                required: ["symbolId", "candidates"],
              },
            },
          },
          required: ["suggestions"],
        },
      },
    });

    return response.suggestions ?? [];
  };

  return await renameSymbols(code, {
    contextWindowSize,
    suggestNames,
    onProgress: showProgress,
    concurrency: DEFAULT_CONCURRENCY,
  });
}

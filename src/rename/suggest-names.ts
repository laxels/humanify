import { anthropicToolUse } from "../anthropic/tool-use";
import { verbose } from "../verbose";
import { formatSymbolDossier } from "./dossier";
import type {
  NamingUnitSummary,
  SymbolDossier,
  SymbolSuggestion,
} from "./types";

type ToolResponse = {
  symbols: Array<{
    id: string;
    candidates: Array<{
      name: string;
      confidence?: number;
      rationale?: string;
    }>;
  }>;
};

export async function suggestNamesWithAnthropic(args: {
  model?: string;
  unit: NamingUnitSummary;
  dossiers: SymbolDossier[];
  maxCandidates?: number;
}): Promise<SymbolSuggestion[]> {
  const { model, unit, dossiers, maxCandidates = 5 } = args;

  const scopeLabel =
    unit.kind === "program"
      ? "module/program"
      : unit.displayName
        ? `${unit.kind} ${unit.displayName}`
        : `${unit.kind} (anonymous)`;

  const dossierText = dossiers.map(formatSymbolDossier).join("\n\n");

  const prompt = [
    `You are a JavaScript reverse engineering assistant.`,
    `Your task: propose descriptive new identifier names for symbols in the current scope.`,
    ``,
    `Rules:`,
    `- Only rename the SYMBOLS listed below (do not rename property keys or strings).`,
    `- Names must be valid JavaScript identifiers.`,
    `- Prefer descriptive but concise names.`,
    `- Use camelCase for variables/params/functions; PascalCase for classes/constructors; UPPER_SNAKE_CASE only for true constants.`,
    `- Return up to ${maxCandidates} candidates per symbol with confidence in [0,1] and a very short rationale.`,
    `- If uncertain, still propose generic-but-accurate names (value, result, options, index, callback, handler, node, state, etc.).`,
    ``,
    `Scope: ${scopeLabel}`,
    `Scope snippet (truncated):`,
    `\`\`\`js`,
    unit.snippet,
    `\`\`\``,
    ``,
    `Symbols:`,
    dossierText,
  ].join("\n");

  verbose.log(`LLM naming batch for ${scopeLabel}: ${dossiers.length} symbols`);

  const response = await anthropicToolUse<ToolResponse>({
    model,
    system:
      "Return structured rename candidates via the provided tool. Do not include any extra commentary outside the tool response.",
    content: prompt,
    tool: {
      name: "rename_symbols",
      description:
        "Provide rename candidates for each symbol id with confidence and short rationale",
      input_schema: {
        type: "object" as const,
        properties: {
          symbols: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                candidates: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      confidence: { type: "number" },
                      rationale: { type: "string" },
                    },
                    required: ["name", "confidence"],
                  },
                },
              },
              required: ["id", "candidates"],
            },
          },
        },
        required: ["symbols"],
      },
    },
    // Keep outputs bounded; reasoning budget can still be substantial.
    maxTokens: 16_000,
    thinkingBudget: 12_000,
  });

  const requestedIds = new Set(dossiers.map((d) => d.id));
  const out: SymbolSuggestion[] = [];

  for (const s of response.symbols ?? []) {
    if (!requestedIds.has(s.id)) continue;

    const candidates = (s.candidates ?? [])
      .filter((c) => typeof c.name === "string" && c.name.trim().length > 0)
      .map((c) => ({
        name: c.name,
        confidence:
          typeof c.confidence === "number" && Number.isFinite(c.confidence)
            ? Math.max(0, Math.min(1, c.confidence))
            : 0,
        rationale: typeof c.rationale === "string" ? c.rationale : undefined,
      }))
      .slice(0, maxCandidates);

    if (candidates.length === 0) continue;

    out.push({ id: s.id, candidates });
  }

  // Ensure every requested symbol gets at least something (fallback to original name).
  // The solver will decide whether to keep or rename.
  for (const d of dossiers) {
    if (out.some((x) => x.id === d.id)) continue;
    out.push({
      id: d.id,
      candidates: [
        { name: d.originalName, confidence: 0.0, rationale: "fallback" },
      ],
    });
  }

  return out;
}

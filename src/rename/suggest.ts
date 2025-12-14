import { anthropicToolUse } from "../anthropic/tool-use";
import type {
  NameSuggestionProvider,
  ScopeSuggestionRequest,
  ScopeSuggestionResponse,
  SymbolDossier,
} from "./types";

export function createAnthropicNameSuggestionProvider({
  model,
}: {
  model?: string;
}): NameSuggestionProvider {
  return async (
    req: ScopeSuggestionRequest,
  ): Promise<ScopeSuggestionResponse> => {
    const content = buildPrompt(
      req.chunk.summary,
      req.dossiers,
      req.maxCandidates,
    );

    return await anthropicToolUse<ScopeSuggestionResponse>({
      model,
      system: buildSystemPrompt(req.maxCandidates),
      content,
      tool: {
        name: "suggest_names",
        description:
          "Suggest descriptive identifier names for a batch of JavaScript symbols",
        input_schema: {
          type: "object" as const,
          properties: {
            suggestions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
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
                required: ["id", "candidates"],
              },
            },
          },
          required: ["suggestions"],
        },
      },
    });
  };
}

function buildSystemPrompt(maxCandidates: number): string {
  return [
    `You are a JavaScript deobfuscation assistant.`,
    `You will receive a scope summary and a list of symbol dossiers.`,
    `For each symbol, propose up to ${maxCandidates} descriptive candidate names.`,
    ``,
    `Rules:`,
    `- Use camelCase for variables, functions, and parameters.`,
    `- Use PascalCase for classes and class-like constructors.`,
    `- Avoid single-letter or meaningless names (a, b, x, tmp) unless absolutely necessary.`,
    `- Avoid JavaScript keywords / reserved words.`,
    `- Prefer consistency:`,
    `  - predicates -> is*/has*/can*/should*`,
    `  - event handlers -> on*/handle*`,
    `  - arrays -> plural nouns when obvious`,
    `- Keep names reasonably short (2–4 words max).`,
    `- Output MUST be valid tool input JSON only.`,
  ].join("\n");
}

function buildPrompt(
  scopeSummary: string,
  dossiers: SymbolDossier[],
  maxCandidates: number,
): string {
  const lines: string[] = [];

  lines.push(`SCOPE SUMMARY:\n${scopeSummary}`);
  lines.push(
    `\nSYMBOL DOSSIERS (provide up to ${maxCandidates} candidates per symbol):`,
  );

  for (const d of dossiers) {
    lines.push(formatDossier(d));
  }

  return lines.join("\n\n");
}

function formatDossier(d: SymbolDossier): string {
  const typeHints = d.typeHints.length > 0 ? d.typeHints.join(", ") : "(none)";

  return [
    `ID: ${d.id}`,
    `originalName: ${d.originalName}`,
    `kind: ${d.kind}`,
    `exported: ${d.isExported ? "yes" : "no"}`,
    `declaration: ${d.declarationSnippet}`,
    `usage: ${d.usageSummary}`,
    `typeHints: ${typeHints}`,
  ].join("\n");
}

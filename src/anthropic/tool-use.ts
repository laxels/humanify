import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env";

const client = new Anthropic({
  apiKey: env("ANTHROPIC_API_KEY"),
  // We have to override the default timeout to disable the SDK throwing an error when `max_tokens` is too high.
  // See https://github.com/anthropics/anthropic-sdk-typescript?tab=readme-ov-file#long-requests
  timeout: 1000 * 60 * 60, // 1 hour
});

export const DEFAULT_MODEL = "claude-sonnet-4-5";
const DEFAULT_MAX_TOKENS = 64000; // Highest possible value for Sonnet 4.5
const DEFAULT_THINKING_BUDGET = 50000;

type ToolInputSchema = Anthropic.Messages.Tool["input_schema"];

// Claude Sonnet 4.5 supports a 1,000,000 token context window when this beta is enabled.
// https://platform.claude.com/docs/en/build-with-claude/context-windows#1m-token-context-window
const CONTEXT_1M_BETA = "context-1m-2025-08-07";

export function defaultMaxInputTokensForModel(model: string): number {
  // Source of truth: model table in Anthropic docs (Opus/Haiku 4.5 are 200K; Sonnet 4.5 is 200K or 1M w/ beta).
  // https://docs.claude.com/en/docs/models-overview
  if (isClaudeSonnet45(model)) return 1_000_000;
  if (isClaudeOpus45(model)) return 200_000;
  if (isClaudeHaiku45(model)) return 200_000;
  return 200_000;
}

function isClaudeSonnet45(model: string): boolean {
  const m = normalizeModel(model);
  return m.includes("claude-sonnet-4-5") || m.includes("claude-sonnet-4.5");
}

function isClaudeOpus45(model: string): boolean {
  const m = normalizeModel(model);
  return m.includes("claude-opus-4-5") || m.includes("claude-opus-4.5");
}

function isClaudeHaiku45(model: string): boolean {
  const m = normalizeModel(model);
  return m.includes("claude-haiku-4-5") || m.includes("claude-haiku-4.5");
}

function normalizeModel(model: string): string {
  return model.trim().toLowerCase();
}

function headersForModel(model: string): Record<string, string> | undefined {
  // Apply the 1M context window beta header for Claude Sonnet 4.5 requests.
  if (!isClaudeSonnet45(model)) return undefined;
  return { "anthropic-beta": CONTEXT_1M_BETA };
}

export type AnthropicToolUseOptions = {
  model?: string;
  system: string;
  content: string;
  tool: {
    name: string;
    description: string;
    input_schema: ToolInputSchema;
  };
  maxTokens?: number;
  thinkingBudget?: number;
};

export async function anthropicToolUse<T>({
  model = DEFAULT_MODEL,
  system,
  content,
  tool,
  maxTokens = DEFAULT_MAX_TOKENS,
  thinkingBudget = DEFAULT_THINKING_BUDGET,
}: AnthropicToolUseOptions): Promise<T> {
  const response = await client.messages.create(
    {
      model,
      max_tokens: maxTokens,
      thinking: {
        type: "enabled",
        budget_tokens: thinkingBudget,
      },
      system,
      messages: [{ role: "user", content }],
      tools: [tool],
    },
    { headers: headersForModel(model) },
  );

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );

  if (!toolUse) {
    throw new Error(`Failed to get tool use response from Anthropic`, {
      cause: response,
    });
  }

  return toolUse.input as T;
}

export async function anthropicCountInputTokens({
  model = DEFAULT_MODEL,
  system,
  messages,
  tools,
}: {
  model?: string;
  system?: Anthropic.Messages.MessageCountTokensParams["system"];
  messages: Anthropic.Messages.MessageCountTokensParams["messages"];
  tools?: Anthropic.Messages.MessageCountTokensParams["tools"];
}): Promise<number> {
  const result = await client.messages.countTokens(
    { model, system, messages, tools },
    { headers: headersForModel(model) },
  );
  return result.input_tokens;
}

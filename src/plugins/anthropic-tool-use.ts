import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env.js";

const client = new Anthropic({
  apiKey: env("ANTHROPIC_API_KEY"),
  // We have to override the default timeout to disable the SDK throwing an error when `max_tokens` is too high.
  // See https://github.com/anthropics/anthropic-sdk-typescript?tab=readme-ov-file#long-requests
  timeout: 1000 * 60 * 60, // 1 hour
});

export const DEFAULT_MODEL = "claude-opus-4-5";
const DEFAULT_MAX_TOKENS = 64000; // Highest possible value for Opus 4.5
const DEFAULT_THINKING_BUDGET = 50000;

type ToolInputSchema = Anthropic.Messages.Tool["input_schema"];

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
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    thinking: {
      type: "enabled",
      budget_tokens: thinkingBudget,
    },
    system,
    messages: [{ role: "user", content }],
    tools: [tool],
  });

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

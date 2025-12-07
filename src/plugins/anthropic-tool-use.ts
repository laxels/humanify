import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env.js";

const client = new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") });

type ToolInputSchema = Anthropic.Messages.Tool["input_schema"];

export interface AnthropicToolUseOptions {
  model: string;
  system: string;
  content: string;
  tool: {
    name: string;
    description: string;
    input_schema: ToolInputSchema;
  };
  maxTokens?: number;
}

export async function anthropicToolUse<T>({
  model,
  system,
  content,
  tool,
  maxTokens = 100,
}: AnthropicToolUseOptions): Promise<T> {
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content }],
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
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

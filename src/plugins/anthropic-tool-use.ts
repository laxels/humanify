import Anthropic from "@anthropic-ai/sdk";

type ToolInputSchema = Anthropic.Messages.Tool["input_schema"];

export interface AnthropicToolUseOptions {
  client?: Anthropic;
  apiKey?: string;
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
  client,
  apiKey,
  model,
  system,
  content,
  tool,
  maxTokens = 100
}: AnthropicToolUseOptions): Promise<T> {
  if (!client && !apiKey) {
    throw new Error("Either client or apiKey must be provided");
  }

  const anthropicClient = client ?? new Anthropic({ apiKey });

  const response = await anthropicClient.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content }],
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name }
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );

  if (!toolUse) {
    throw new Error(`Failed to get tool use response from Anthropic`, {
      cause: response
    });
  }

  return toolUse.input as T;
}

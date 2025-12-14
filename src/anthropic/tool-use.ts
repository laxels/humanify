import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env";

const client = new Anthropic({
  apiKey: env("ANTHROPIC_API_KEY"),
  // We have to override the default timeout to disable the SDK throwing an error when `max_tokens` is too high.
  // See https://github.com/anthropics/anthropic-sdk-typescript?tab=readme-ov-file#long-requests
  timeout: 1000 * 60 * 60, // 1 hour
});

export const DEFAULT_MODEL = "claude-opus-4-5";
const DEFAULT_MAX_TOKENS = 64000; // Highest possible value for Opus 4.5
const DEFAULT_THINKING_BUDGET = 50000;
const DEFAULT_RETRIES = 5;

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
  retries?: number;
};

export async function anthropicToolUse<T>({
  model = DEFAULT_MODEL,
  system,
  content,
  tool,
  maxTokens = DEFAULT_MAX_TOKENS,
  thinkingBudget = DEFAULT_THINKING_BUDGET,
  retries = DEFAULT_RETRIES,
}: AnthropicToolUseOptions): Promise<T> {
  const response = await withRetry(
    () =>
      client.messages.create({
        model,
        max_tokens: maxTokens,
        thinking: {
          type: "enabled",
          budget_tokens: thinkingBudget,
        },
        system,
        messages: [{ role: "user", content }],
        tools: [tool],
      }),
    { retries },
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

async function withRetry<T>(
  fn: () => Promise<T>,
  { retries }: { retries: number },
): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > retries || !isRetryableError(err)) {
        throw err;
      }

      const delayMs = computeBackoffMs(attempt);
      await sleep(delayMs);
    }
  }
}

function isRetryableError(err: unknown): boolean {
  const anyErr = err as any;
  const status: number | undefined =
    anyErr?.status ??
    anyErr?.statusCode ??
    anyErr?.response?.status ??
    anyErr?.error?.status;

  if (status === 429) return true;
  if (typeof status === "number" && status >= 500) return true;

  const code: string | undefined = anyErr?.code;
  if (
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND"
  ) {
    return true;
  }

  const message: string | undefined = anyErr?.message;
  if (typeof message === "string") {
    const lower = message.toLowerCase();
    if (
      lower.includes("timeout") ||
      lower.includes("timed out") ||
      lower.includes("network") ||
      lower.includes("connection reset")
    ) {
      return true;
    }
  }

  return false;
}

function computeBackoffMs(attempt: number): number {
  // 500ms, 1s, 2s, 4s, 8s … with jitter, capped at 30s.
  const base = Math.min(30_000, 500 * 2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

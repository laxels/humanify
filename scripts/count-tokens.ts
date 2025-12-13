#!/usr/bin/env bun
import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_MODEL } from "@/anthropic/tool-use";
import { env } from "@/env";

const client = new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") });

async function countTokens(filePath: string): Promise<number> {
  const content = await Bun.file(filePath).text();

  const response = await client.messages.countTokens({
    model: DEFAULT_MODEL,
    messages: [{ role: "user", content }],
  });

  return response.input_tokens;
}

const filePath = process.argv[2];

if (!filePath) {
  console.error("Usage: bun scripts/count-tokens.ts FILE_PATH");
  process.exit(1);
}

const tokens = await countTokens(filePath);
console.log(tokens);

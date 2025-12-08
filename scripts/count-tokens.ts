#!/usr/bin/env bun
import { DEFAULT_MODEL } from "@/plugins/anthropic-tool-use";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "@dotenvx/dotenvx";

config();

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

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
  console.error("Usage: bun scripts/count-tokens.ts <file>");
  process.exit(1);
}

const tokens = await countTokens(filePath);
console.log(tokens);

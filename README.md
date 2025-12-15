# Humanify

**Deobfuscate Javascript code using LLMs ("AI")**

This tool uses Anthropic's Claude API and other tools to deobfuscate and unminify Javascript code.
Note that LLMs don't perform any structural changes – they only provide hints to rename variables and functions.
The heavy lifting is done by Babel on AST level to ensure code stays 1-1 equivalent.

## Usage

Requires `ANTHROPIC_API_KEY` to be set.

```bash
bun run start -- <input-file> [options]
```

### CLI options

- `--model <model>`: Which Claude model to use (default: `claude-sonnet-4-5`).
- `--outputDir <dir>`: Output directory (default: `output`).
- `--declarationSnippetMaxLength <n>`: Max characters of local code context included in each symbol dossier (default: `1000`).
- `--maxSymbolsPerJob <n>`: Max number of symbol dossiers per LLM naming job (default: `300`).
- `--maxInputTokens <n>`: Max _input_ tokens per LLM naming job. If omitted, defaults to the selected model’s max input tokens.
  - For Claude Sonnet 4.5, Humanify automatically enables the `context-1m-2025-08-07` beta header and defaults this limit to `1_000_000`.

## Identifier renaming batching

Humanify plans LLM “rename jobs” by starting from the root Program scope and merging nested scope chunks (Program / Function / Class) into a single job when possible. If a job is too large, it splits recursively along chunk boundaries and only falls back to smaller symbol batches when needed.

Job size is enforced by:

- `--maxSymbolsPerJob`
- `--maxInputTokens`, measured via Anthropic’s Token Count API (`/v1/messages/count_tokens`) using the exact prompt + tool schema used for name suggestions

The processing pipeline is fixed:

1. Unpack bundles (Webcrack)
2. AST cleanup (Babel)
3. Identifier renaming (Claude suggestions applied via Babel scope renaming)
4. Final formatting (Biome)

# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.

## Project Overview

HumanifyJS is a CLI tool that uses Anthropic's Claude API to deobfuscate and unminify JavaScript code. The LLM provides variable/function renaming suggestions while Babel handles AST-level transformations to ensure code equivalence.

## Commands

```bash
# Run development CLI
bun run start -- <input-file> [options]

# Build (creates single binary executable using Bun)
bun run build

# Validate (typecheck + unit tests + lint)
bun run validate

# Typecheck
bun run typecheck

# Run specific test types
bun run test:unit    # Unit tests (*.test.ts)
bun run test:e2e     # E2E tests (*.test.e2e.ts) - requires build first

# Run a single test file
bun test ./src/path/to/file.test.ts

# Linting and formatting (Biome)
bun run lint
```

Requires `ANTHROPIC_API_KEY` environment variable to be set.

## Architecture

### Processing Pipeline

The `unminify.ts` orchestrates two phases:

1. **Webcrack** (`plugins/webcrack.ts`) - Unbundles Webpack bundles first, extracting individual files to output directory
2. **Plugin chain** - Each extracted file runs through plugins sequentially:
   - `babel.ts` - AST-level cleanup (void→undefined, flip comparisons, expand scientific notation)
   - `anthropic-rename.ts` - Renames minified identifiers using Claude with extended thinking
   - `biome.ts` - Final code formatting

### Plugin Pattern

Plugins are functions with signature `(code: string) => Promise<string>`. They're composed via promise chaining: `plugins.reduce((p, next) => p.then(next), Promise.resolve(code))`.

### Identifier Renaming

The renaming logic in `plugins/visit-all-identifiers.ts`:

- Parses code to AST with Babel
- Finds all binding identifiers (variable/function declarations)
- Sorts by enclosing block size (largest first) so outer scopes get renamed before inner
- For each identifier, extracts surrounding code context (configurable window size) and calls Claude via tool use
- Uses Babel's `scope.rename()` to safely rename all references
- Handles name collisions by prefixing with underscores

### Anthropic Integration

`plugins/anthropic-tool-use.ts` wraps the Anthropic SDK:

- Uses extended thinking (default 50k budget) for better reasoning
- Uses tool use to get structured `{ newName: string }` responses
- Default model: `claude-opus-4-5`

### Test File Conventions

- `*.test.ts` - Unit tests
- `*.test.e2e.ts` - End-to-end tests (require built CLI)

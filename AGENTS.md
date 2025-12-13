# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.

## Project Overview

Humanify is a CLI tool that uses Anthropic's Claude API to deobfuscate and unminify JavaScript code. The LLM provides variable/function renaming suggestions while Babel handles AST-level transformations to ensure code equivalence.

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

The pipeline is intentionally fixed and lives in `src/pipeline/unminify.ts`:

1. **Unpack bundles** (`src/unpack/webcrack.ts`)
   Unbundles Webpack bundles first, extracting individual files to the output directory.
2. **AST cleanup** (`src/ast/babel/babel.ts`)
   Semantics-preserving cleanups (void→undefined, flip comparisons, expand scientific notation) plus beautification.
3. **Identifier renaming** (`src/rename/rename-identifiers.ts`)
   Calls Claude to propose descriptive names and applies them safely via Babel scope renaming.
4. **Formatting** (`src/format/biome.ts`)
   Final code formatting.

### Identifier Renaming

The renaming logic in `src/rename/visit-all-identifiers.ts`:

* Parses code to AST with Babel
* Finds all binding identifiers (variable/function/class declarations)
* Sorts by enclosing block size (largest first) so outer scopes get renamed before inner
* For each identifier, extracts surrounding code context (configurable window size) and calls Claude via tool use
* Uses Babel's `scope.rename()` to safely rename all references
* Handles name collisions by prefixing with underscores

### Anthropic Integration

`src/anthropic/tool-use.ts` wraps the Anthropic SDK:

* Uses extended thinking (default 50k budget) for better reasoning
* Uses tool use to get structured responses (e.g. `{ newName: string }`)
* Default model: `claude-opus-4-5`

### Test File Conventions

* `*.test.ts` - Unit tests
* `*.test.e2e.ts` - End-to-end tests (require built CLI)

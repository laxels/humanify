# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.

## Project Overview

Humanify is a CLI tool that uses Anthropic's Claude API to deobfuscate and unminify JavaScript code.
The LLM proposes better variable/function names while Babel performs AST-level transforms to preserve semantics.

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
   Builds an AST + scope graph + symbol table, asks Claude for batched per-scope naming suggestions, runs a deterministic global reconciliation step, then applies renames via Babel.
4. **Formatting** (`src/format/biome.ts`)
   Final code formatting.

### Identifier Renaming

The renaming engine lives in `src/rename/` and follows an AST + scope graph + per-symbol dossier + global solver architecture:

* `analyze.ts`
  Parses code and builds:

  * a symbol table (each binding gets a stable ID)
  * a scope/chunk map (functions + program)
  * a taint map for dynamic features (`eval`, `with`, `new Function`) to conservatively skip unsafe renames
* `dossier.ts`
  Creates a compact "symbol dossier" per binding:

  * kind (param/const/let/var/function/class/import/catch)
  * declaration snippet
  * aggregated usage summary (calls, member accesses, comparisons, etc.)
  * lightweight type-ish hints (array-like, promise-like, callable, …)
* `suggest.ts`
  Batches dossiers per chunk and calls Claude (tool use) to return top-k candidate names per symbol + confidence.
* `solver.ts`
  Deterministic global reconciliation step:

  * sanitizes / normalizes identifiers (reserved words, invalid chars)
  * enforces naming conventions (camelCase, PascalCase; UPPER_SNAKE for literal `const` values)
  * prevents collisions within a scope and avoids shadowing hazards at reference sites
* `apply.ts`
  Applies renames via `scope.rename()` and runs safety transforms:

  * rewrites object literal/pattern shorthand `{a}` → `{a: renamed}` to preserve property keys
  * rewrites `export <declaration>` into `declaration + export { local as original }` when needed to preserve exported names

Environment knobs:

* `HUMANIFY_LLM_CONCURRENCY` (default 4): parallel Claude calls
* `HUMANIFY_SYMBOLS_PER_BATCH` (default 24): number of symbols per scope batch

### Anthropic Integration

`src/anthropic/tool-use.ts` wraps the Anthropic SDK:

* Uses extended thinking (default 50k budget) for better reasoning
* Uses tool use to get structured responses (e.g. batched name suggestions)
* Adds retry/backoff for transient failures to support higher concurrency
* Default model: `claude-opus-4-5`

### Test File Conventions

* `*.test.ts` - Unit tests
* `*.test.e2e.ts` - End-to-end tests (require built CLI)

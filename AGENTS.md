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

The renaming logic now follows an **AST + scope graph + per-symbol dossiers + global constraint solver** design:

* **Analyze** (`src/rename/symbol-analysis.ts`)
  * Parse to AST (Babel)
  * Build a stable **symbol table** (each binding gets a stable symbolId)
  * Build scope "chunks" (Program / Function / Class) for batching
  * Detect **unsafe scopes** (e.g., global `eval`, `with`, string-eval timers) and conservatively skip renames there
* **Dossier extraction** (`src/rename/symbol-dossier.ts`)
  * For each symbol, produce a compact "dossier":
    * declaration kind/snippet
    * usage summary (call sites, member accesses, comparisons, etc.)
    * lightweight type-ish hints (array-like, promise-like, etc.)
* **Batched LLM calls per scope** (`src/rename/rename-identifiers.ts`)
  * One call per scope-chunk (many symbols at once)
  * Parallelized with a concurrency limit
  * Requests **top‑k candidates** + confidence for each symbolId
* **Global reconciliation / constraint solving** (`src/rename/constraint-solver.ts`)
  * Picks final names per lexical scope to **avoid collisions**
  * Enforces naming conventions (camelCase / PascalCase / conservative UPPER_SNAKE for obvious top-level primitive constants)
* **Safe application** (`src/rename/apply-renames.ts` + `src/rename/ast-fixes.ts`)
  * Two‑phase rename (temp → final) to avoid cycles/collisions
  * Fix object shorthand semantics when renaming (`{a}` → `{a: userId}`, `{a} = obj` → `{a: userId} = obj`)
  * Preserve named-export interfaces across files (`export function a` → `function betterName; export { betterName as a }`)

### Anthropic Integration

`src/anthropic/tool-use.ts` wraps the Anthropic SDK:

* Uses extended thinking (default 50k budget) for better reasoning
* Uses tool use to get structured responses (e.g. `{ newName: string }`)
* Default model: `claude-opus-4-5`

### Test File Conventions

* `*.test.ts` - Unit tests
* `*.test.e2e.ts` - End-to-end tests (require built CLI)

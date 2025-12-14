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

The renaming logic now follows an **AST + Scope Graph + Per-Symbol Dossiers + Global Constraint Solver** architecture:

* Parses code to AST with Babel and builds:
  * **Scope graph** (lexical scopes) + stable scope IDs
  * **Symbol table** where each binding gets a stable symbol ID (sorted by source order)
* Runs **safety prepasses** before renaming:
  * Expands object/destucturing shorthand to explicit form so renaming cannot change runtime keys:
    * `{a}` → `{a: a}`, `{a} = obj` → `{a: a} = obj`
  * Splits `export`ed declarations so local renames preserve the public export name:
    * `export const a = 1;` → `const a = 1; export { a };`
* Extracts a compact **symbol dossier** per binding:
  * Declaration snippet
  * Use-site summaries (member access, call/new sites, operators, literals compared against, etc.)
  * Lightweight "type-ish" hints (array-like, promise-like, string-like, …)
* **Batches LLM requests by naming unit** (program/function/class) and parallelizes them with a concurrency limit.
  * Each batch asks for **top‑k candidate names per symbol** + confidence + short rationale.
* Runs a deterministic **global reconciliation / constraint solver**:
  * Enforces valid identifiers + reserved-word handling
  * Enforces **no collisions** within scopes and avoids introducing new shadowing
  * Prefers "keep original" when the model indicates the current name should remain
* Applies renames with Babel via a **two-phase rename** (temporary → final) to avoid swap/collision hazards.
* Validates output is parseable.

Key entry points:
* Analysis + prepasses: `src/rename/analyze.ts`
* Dossiers: `src/rename/dossier.ts`
* Suggestions: `src/rename/suggest-names.ts`
* Constraint solver: `src/rename/constraints.ts`
* Rename application: `src/rename/apply-renames.ts`
* Orchestration: `src/rename/rename-identifiers.ts`

### Anthropic Integration

`src/anthropic/tool-use.ts` wraps the Anthropic SDK:

* Uses extended thinking (default 50k budget) for better reasoning
* Uses tool use to get structured responses (e.g. `{ newName: string }`)
* Default model: `claude-opus-4-5`

### Test File Conventions

* `*.test.ts` - Unit tests
* `*.test.e2e.ts` - End-to-end tests (require built CLI)

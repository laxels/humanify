# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

HumanifyJS is a CLI tool that uses Anthropic's Claude API to deobfuscate and unminify JavaScript code. The LLM provides variable/function renaming suggestions while Babel handles AST-level transformations to ensure code equivalence.

## Commands

```bash
# Run development CLI
bun run start -- <command> [options]

# Build (creates single binary executable using Bun)
bun run build

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

## Architecture

### Processing Pipeline

The core pipeline in `unminify.ts` processes files through a sequence of plugins:

1. **Webcrack** (`plugins/webcrack.ts`) - Unbundles Webpack bundles, extracts individual files to output directory
2. **Babel transformations** (`plugins/babel/babel.ts`) - AST-level cleanup (void→undefined, flip comparisons, expand numbers)
3. **Anthropic rename** (`plugins/anthropic-rename.ts`) - Renames minified identifiers using Claude
4. **Biome** (`plugins/biome.ts`) - Final code formatting

### Plugin Pattern

Plugins are functions with signature `(code: string) => Promise<string>`. They're composed sequentially via promise chaining in `unminify.ts`.

### Identifier Renaming

The renaming logic in `plugins/visit-all-identifiers.ts`:
- Parses code to AST with Babel
- Finds all binding identifiers (variable/function declarations)
- Sorts by scope size (largest first) so outer scopes get renamed before inner
- For each identifier, extracts surrounding code context and calls Claude for a better name
- Uses Babel's scope.rename() to safely rename all references

### CLI Structure

- Entry point: `src/index.ts` (parses CLI options, configures plugins)
- CLI wrapper: `src/cli.ts` (Commander.js setup)

### Test File Conventions

- `*.test.ts` - Unit tests
- `*.test.e2e.ts` - End-to-end tests (require built CLI)

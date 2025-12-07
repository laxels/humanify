# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

HumanifyJS is a CLI tool that uses Anthropic's Claude API to deobfuscate and unminify JavaScript code. The LLM provides variable/function renaming suggestions while Babel handles AST-level transformations to ensure code equivalence.

## Commands

```bash
# Run development CLI
npm start -- <command> [options]

# Build (uses pkgroll)
npm run build

# Run all tests
npm test

# Run specific test types
npm run test:unit    # Unit tests (*.test.ts)
npm run test:e2e     # E2E tests (*.e2etest.ts) - requires build first

# Run a single test file
tsx --test src/path/to/file.test.ts

# Linting
npm run lint
npm run lint:prettier
npm run lint:eslint
```

## Architecture

### Processing Pipeline

The core pipeline in `unminify.ts` processes files through a sequence of plugins:
1. **Webcrack** (`plugins/webcrack.ts`) - Unbundles Webpack bundles, extracts individual files
2. **Babel transformations** (`plugins/babel/babel.ts`) - AST-level cleanup (void→undefined, flip comparisons, expand numbers)
3. **Anthropic rename** (`plugins/anthropic-rename.ts`) - Renames minified identifiers using Claude
4. **Prettier** (`plugins/prettier.ts`) - Final code formatting

### CLI Structure

- Entry point: `src/index.ts`
- CLI wrapper: `src/cli.ts` (Commander.js)
- Commands: `src/commands/anthropic.ts`

### Test File Conventions

- `*.test.ts` - Unit tests
- `*.e2etest.ts` - End-to-end tests (require built CLI)
- `*.anthropictest.ts` - Tests requiring Anthropic API key

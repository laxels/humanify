# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

HumanifyJS is a CLI tool that uses LLMs (OpenAI, Gemini, or local models via llama.cpp) to deobfuscate and unminify JavaScript code. The LLMs provide variable/function renaming suggestions while Babel handles AST-level transformations to ensure code equivalence.

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
npm run test:llm     # LLM tests (*.llmtest.ts)

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
3. **LLM rename** - Renames minified identifiers using the chosen backend:
   - OpenAI: `plugins/openai/openai-rename.ts`
   - Gemini: `plugins/gemini-rename.ts`
   - Local: `plugins/local-llm-rename/local-llm-rename.ts`
4. **Prettier** (`plugins/prettier.ts`) - Final code formatting

### CLI Structure

- Entry point: `src/index.ts`
- CLI wrapper: `src/cli.ts` (Commander.js)
- Commands: `src/commands/` (local.ts, openai.ts, gemini.ts, download.ts)

### Local LLM System

Uses node-llama-cpp for local inference:
- `plugins/local-llm-rename/llama.ts` - Model loading and prompt interface
- `plugins/local-llm-rename/visit-all-identifiers.ts` - AST traversal for identifier renaming
- `plugins/local-llm-rename/gbnf.ts` - Grammar-based constrained generation for valid JS identifiers
- `local-models.ts` - Model definitions and download URLs

### Test File Conventions

- `*.test.ts` - Unit tests
- `*.e2etest.ts` - End-to-end tests (require built CLI)
- `*.llmtest.ts` - Tests requiring local LLM
- `*.openaitest.ts` / `*.geminitest.ts` - Tests requiring API keys

#!/usr/bin/env bun
import {
  DEFAULT_MODEL,
  defaultMaxInputTokensForModel,
} from "./anthropic/tool-use";
import { cli } from "./cli";
import { parseNumber } from "./number-utils";
import { unminify } from "./pipeline/unminify";
import { verbose } from "./verbose";

const DEFAULT_DECLARATION_SNIPPET_MAX_LENGTH = 1000;
// Dossier lists grow quickly with modern bundlers; 300 keeps calls efficient while still
// leaving headroom for deep scope summaries and tool schema overhead.
const DEFAULT_MAX_SYMBOLS_PER_JOB = 300;

type CliOptions = {
  model: string;
  outputDir: string;
  declarationSnippetMaxLength: string;
  maxSymbolsPerJob?: string;
  maxInputTokens?: string;
  verbose?: boolean;
};

const program = cli()
  .name("humanify")
  .description("Unminify JavaScript code using Anthropic's Claude API")
  .option("-m, --model <model>", "The model to use", DEFAULT_MODEL)
  .option("-o, --outputDir <output>", "The output directory", "output")
  .option(
    "--declarationSnippetMaxLength <declarationSnippetMaxLength>",
    "Max characters of an identifier's declaration snippet included in its symbol dossier",
    `${DEFAULT_DECLARATION_SNIPPET_MAX_LENGTH}`,
  )
  .option(
    "--maxSymbolsPerJob <n>",
    "Max number of symbol dossiers per LLM job",
    `${DEFAULT_MAX_SYMBOLS_PER_JOB}`,
  )
  .option(
    "--maxInputTokens <n>",
    "Max input tokens per LLM job (defaults to the selected model's max input tokens)",
  )
  .option("--verbose", "Show verbose output")
  .argument("<input>", "The input minified Javascript file")
  .action(async (filename: string) => {
    const opts = program.opts<CliOptions>();

    if (opts.verbose) {
      verbose.enabled = true;
    }

    const declarationSnippetMaxLength = parseNumber(
      opts.declarationSnippetMaxLength,
    );
    const maxSymbolsPerJob = parseNumber(
      opts.maxSymbolsPerJob ?? `${DEFAULT_MAX_SYMBOLS_PER_JOB}`,
    );
    const maxInputTokens =
      opts.maxInputTokens != null
        ? parseNumber(opts.maxInputTokens)
        : defaultMaxInputTokensForModel(opts.model);

    await unminify(filename, opts.outputDir, {
      model: opts.model,
      declarationSnippetMaxLength,
      maxSymbolsPerJob,
      maxInputTokens,
    });
  });

program.parse(process.argv);

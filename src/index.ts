#!/usr/bin/env bun
import { DEFAULT_MODEL } from "./anthropic/tool-use";
import { cli } from "./cli";
import { parseNumber } from "./number-utils";
import { unminify } from "./pipeline/unminify";
import { verbose } from "./verbose";

const DEFAULT_CONTEXT_WINDOW_SIZE = 1000;

type CliOptions = {
  model: string;
  outputDir: string;
  contextSize: string;
  verbose?: boolean;
};

const program = cli()
  .name("humanify")
  .description("Unminify JavaScript code using Anthropic's Claude API")
  .option("-m, --model <model>", "The model to use", DEFAULT_MODEL)
  .option("-o, --outputDir <output>", "The output directory", "output")
  .option(
    "--contextSize <contextSize>",
    "The context size to use for the LLM",
    `${DEFAULT_CONTEXT_WINDOW_SIZE}`,
  )
  .option("--verbose", "Show verbose output")
  .argument("<input>", "The input minified Javascript file")
  .action(async (filename: string) => {
    const opts = program.opts<CliOptions>();

    if (opts.verbose) {
      verbose.enabled = true;
    }

    const contextWindowSize = parseNumber(opts.contextSize);

    await unminify(filename, opts.outputDir, {
      model: opts.model,
      contextWindowSize,
    });
  });

program.parse(process.argv);

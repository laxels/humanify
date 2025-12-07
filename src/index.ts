#!/usr/bin/env -S npx tsx
import { cli } from "./cli.js";
import prettier from "./plugins/prettier.js";
import { unminify } from "./unminify.js";
import babel from "./plugins/babel/babel.js";
import { verbose } from "./verbose.js";
import { anthropicRename } from "./plugins/anthropic-rename.js";
import { parseNumber } from "./number-utils.js";
import { DEFAULT_MODEL } from "./plugins/anthropic-tool-use.js";

const DEFAULT_CONTEXT_WINDOW_SIZE = 1000;

cli()
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
  .argument("input", "The input minified Javascript file")
  .action(async (filename, opts) => {
    if (opts.verbose) {
      verbose.enabled = true;
    }

    const contextWindowSize = parseNumber(opts.contextSize);

    await unminify(filename, opts.outputDir, [
      babel,
      anthropicRename({ model: opts.model, contextWindowSize }),
      prettier,
    ]);
  })
  .parse(process.argv);

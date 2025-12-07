import { cli } from "../cli.js";
import prettier from "../plugins/prettier.js";
import { unminify } from "../unminify.js";
import babel from "../plugins/babel/babel.js";
import { verbose } from "../verbose.js";
import { anthropicRename } from "../plugins/anthropic-rename.js";
import { env } from "../env.js";
import { DEFAULT_CONTEXT_WINDOW_SIZE } from "./default-args.js";
import { parseNumber } from "../number-utils.js";

export const anthropic = cli()
  .name("anthropic")
  .description("Use Anthropic Claude API to unminify code")
  .option("-m, --model <model>", "The model to use", "claude-opus-4-5")
  .option("-o, --outputDir <output>", "The output directory", "output")
  .option(
    "--contextSize <contextSize>",
    "The context size to use for the LLM",
    `${DEFAULT_CONTEXT_WINDOW_SIZE}`
  )
  .option(
    "-k, --apiKey <apiKey>",
    "The Anthropic API key. Alternatively use ANTHROPIC_API_KEY environment variable"
  )
  .option("--verbose", "Show verbose output")
  .argument("input", "The input minified Javascript file")
  .action(async (filename, opts) => {
    if (opts.verbose) {
      verbose.enabled = true;
    }

    const apiKey = opts.apiKey ?? env("ANTHROPIC_API_KEY");
    const contextWindowSize = parseNumber(opts.contextSize);

    await unminify(filename, opts.outputDir, [
      babel,
      anthropicRename({ apiKey, model: opts.model, contextWindowSize }),
      prettier
    ]);
  });

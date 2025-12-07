#!/usr/bin/env -S npx tsx
import { cli } from "./cli.js";
import { anthropic } from "./commands/anthropic.js";

cli()
  .name("humanify")
  .description("Unminify JavaScript code using Anthropic's Claude API")
  .addCommand(anthropic)
  .parse(process.argv);

#!/usr/bin/env -S npx tsx
import { version } from "../package.json";
import { cli } from "./cli.js";
import { anthropic } from "./commands/anthropic.js";

cli()
  .name("humanify")
  .description("Unminify JavaScript code using Anthropic's Claude API")
  .version(version)
  .addCommand(anthropic)
  .parse(process.argv);

# Humanify

**Deobfuscate Javascript code using LLMs ("AI")**

This tool uses Anthropic's Claude API and other tools to deobfuscate and unminify Javascript code.
Note that LLMs don't perform any structural changes – they only provide hints to rename variables and functions.
The heavy lifting is done by Babel on AST level to ensure code stays 1-1 equivalent.

The processing pipeline is fixed:

1. Unpack bundles (Webcrack)
2. AST cleanup (Babel)
3. Identifier renaming (Claude suggestions applied via Babel scope renaming)
4. Final formatting (Biome)

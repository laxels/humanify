# Humanify

**Deobfuscate Javascript code using LLMs ("AI")**

This tool uses Anthropic's Claude API and other tools to deobfuscate, unminify, transpile, decompile and unpack Javascript code.
Note that LLMs don't perform any structural changes – they only provide hints to rename variables and functions.
The heavy lifting is done by Babel on AST level to ensure code stays 1-1 equivalent.

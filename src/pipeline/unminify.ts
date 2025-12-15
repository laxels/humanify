import fs from "fs/promises";
import babel from "../ast/babel/babel";
import { ensureFileExists } from "../file-utils";
import biome from "../format/biome";
import { renameIdentifiers } from "../rename/rename-identifiers";
import { webcrack } from "../unpack/webcrack";
import { createTimer, timedAsync, verbose } from "../verbose";

export type UnminifyOptions = {
  model?: string;
  declarationSnippetMaxLength: number;
  maxSymbolsPerJob: number;
  maxInputTokens: number;
};

export async function unminify(
  filename: string,
  outputDir: string,
  options: UnminifyOptions,
) {
  const totalTimer = createTimer("Total unminify pipeline");
  totalTimer.start();

  ensureFileExists(filename);
  const bundledCode = await fs.readFile(filename, "utf-8");
  verbose.log(`Input file size: ${(bundledCode.length / 1024).toFixed(1)}KB`);

  const extractedFiles = await timedAsync("Webcrack bundle unpacking", () =>
    webcrack(bundledCode, outputDir),
  );

  verbose.log(`Extracted ${extractedFiles.length} file(s) from bundle`);

  for (let i = 0; i < extractedFiles.length; i++) {
    const file = extractedFiles[i]!;
    const fileTimer = createTimer(
      `File ${i + 1}/${extractedFiles.length}: ${file.path}`,
    );
    fileTimer.start();

    console.log(
      `Processing file ${file.path} (${i + 1}/${extractedFiles.length})`,
    );

    const code = await fs.readFile(file.path, "utf-8");
    verbose.log(`File size: ${(code.length / 1024).toFixed(1)}KB`);

    if (code.trim().length === 0) {
      verbose.log(`Skipping empty file ${file.path}`);
      continue;
    }

    const babelCleaned = await timedAsync("Babel AST cleanup", () =>
      babel(code),
    );

    const renamed = await timedAsync("Identifier renaming (LLM)", () =>
      renameIdentifiers(babelCleaned, options),
    );

    const formattedCode = await timedAsync("Biome formatting", () =>
      biome(renamed),
    );

    verbose.log("Input: ", code);
    verbose.log("Output: ", formattedCode);

    await fs.writeFile(file.path, formattedCode);
    fileTimer.stop();
  }

  totalTimer.stop();
  console.log(`Done! You can find your unminified code in ${outputDir}`);
}

import fs from "fs/promises";
import babel from "../ast/babel/babel";
import { ensureFileExists } from "../file-utils";
import biome from "../format/biome";
import { renameIdentifiers } from "../rename/rename-identifiers";
import { webcrack } from "../unpack/webcrack";
import { verbose } from "../verbose";

export type UnminifyOptions = {
  model?: string;
  contextWindowSize: number;
  maxSymbolsPerJob: number;
  maxInputTokens: number;
};

export async function unminify(
  filename: string,
  outputDir: string,
  options: UnminifyOptions,
) {
  ensureFileExists(filename);
  const bundledCode = await fs.readFile(filename, "utf-8");
  const extractedFiles = await webcrack(bundledCode, outputDir);

  for (let i = 0; i < extractedFiles.length; i++) {
    const file = extractedFiles[i]!;
    console.log(
      `Processing file ${file.path} (${i + 1}/${extractedFiles.length})`,
    );

    const code = await fs.readFile(file.path, "utf-8");

    if (code.trim().length === 0) {
      verbose.log(`Skipping empty file ${file.path}`);
      continue;
    }

    const babelCleaned = await babel(code);
    const renamed = await renameIdentifiers(babelCleaned, options);
    const formattedCode = await biome(renamed);

    verbose.log("Input: ", code);
    verbose.log("Output: ", formattedCode);

    await fs.writeFile(file.path, formattedCode);
  }

  console.log(`Done! You can find your unminified code in ${outputDir}`);
}

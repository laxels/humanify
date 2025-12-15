import fs from "fs/promises";
import path from "path";
import { webcrack as wc } from "webcrack";
import { timedAsync, verbose } from "../verbose";

export async function webcrack(
  code: string,
  outputDir: string,
): Promise<Array<{ path: string }>> {
  verbose.log(`Webcrack input size: ${(code.length / 1024).toFixed(1)}KB`);

  const cracked = await timedAsync("Webcrack parsing and unbundling", () =>
    wc(code),
  );

  await timedAsync("Webcrack saving files to disk", () =>
    cracked.save(outputDir),
  );

  const output = await fs.readdir(outputDir);
  const jsFiles = output.filter((file) => file.endsWith(".js"));
  verbose.log(`Webcrack extracted ${jsFiles.length} JS file(s)`);

  return jsFiles.map((file) => ({ path: path.join(outputDir, file) }));
}

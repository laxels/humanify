import fs from "fs/promises";
import path from "path";
import { webcrack as wc } from "webcrack";

export async function webcrack(
  code: string,
  outputDir: string,
): Promise<Array<{ path: string }>> {
  const cracked = await wc(code);
  await cracked.save(outputDir);

  const output = await fs.readdir(outputDir);
  return output
    .filter((file) => file.endsWith(".js"))
    .map((file) => ({ path: path.join(outputDir, file) }));
}

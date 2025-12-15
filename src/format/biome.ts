import { spawn } from "child_process";
import { verbose } from "../verbose";

export default async (code: string): Promise<string> => {
  verbose.log(`Biome input size: ${(code.length / 1024).toFixed(1)}KB`);
  const start = performance.now();

  const result = await new Promise<string>((resolve, reject) => {
    const biome = spawn(
      "bunx",
      ["biome", "format", "--stdin-file-path=file.js"],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";

    biome.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    biome.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    biome.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Biome format failed: ${stderr}`));
      }
    });

    biome.on("error", reject);

    biome.stdin.write(code);
    biome.stdin.end();
  });

  const duration = performance.now() - start;
  verbose.log(
    `Biome format completed in ${duration.toFixed(0)}ms, output size: ${(result.length / 1024).toFixed(1)}KB`,
  );

  return result;
};

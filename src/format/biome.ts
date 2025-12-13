import { spawn } from "child_process";

export default async (code: string): Promise<string> => {
  return new Promise((resolve, reject) => {
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
};

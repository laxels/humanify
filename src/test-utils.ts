import { spawn } from "child_process";
import { verbose } from "./verbose.js";

export async function humanify(...argv: string[]) {
  const extraArgs = argv.includes("local") ? ["--seed", "1"] : [];
  const process = spawn("./dist/index.mjs", [...argv, ...extraArgs]);
  const stdout: string[] = [];
  const stderr: string[] = [];
  process.stdout.on("data", (data) => stdout.push(data.toString()));
  process.stderr.on("data", (data) => stderr.push(data.toString()));
  await new Promise((resolve, reject) =>
    process.on("close", () => {
      if (process.exitCode === 0) {
        resolve(undefined);
      } else {
        reject(
          new Error(
            `Process exited with code ${process.exitCode}, stderr: ${stderr.join("")}, stdout: ${stdout.join("")}`
          )
        );
      }
    })
  );
  verbose.log("stdout", stdout.join(""));
  verbose.log("stderr", stderr.join(""));

  return { stdout: stdout.join(""), stderr: stderr.join("") };
}

import { verbose } from "./verbose.js";

export function showPercentage(percentage: number) {
  const percentageStr = Math.round(percentage * 100);
  if (!verbose.enabled) {
    process.stdout.clearLine?.(0);
    process.stdout.cursorTo(0);
    process.stdout.write(`Processing: ${percentageStr}%`);
  } else {
    verbose.log(`Processing: ${percentageStr}%`);
  }
  if (percentage === 1) {
    process.stdout.write("\n");
  }
}

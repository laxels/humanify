import { verbose } from "./verbose.js";

export function showProgress(done: number, total: number) {
  const percentage = total > 0 ? Math.round((done / total) * 100) : 0;
  const message = `Processing: ${done}/${total} (${percentage}%)`;
  if (!verbose.enabled) {
    process.stdout.clearLine?.(0);
    process.stdout.cursorTo(0);
    process.stdout.write(message);
  } else {
    verbose.log(message);
  }
  if (done === total) {
    process.stdout.write("\n");
  }
}

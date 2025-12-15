import { env } from "./env";

export const verbose = {
  log(...args: ConsoleLogArgs) {
    if (this.enabled) {
      const timestamp = new Date()
        .toISOString()
        .replace(/T/, " ")
        .replace(/\..+/, "");
      console.log(`[${timestamp}] `, ...args);
    }
  },
  enabled: env(`CI`) === "true",
};

type ConsoleLogArgs = Parameters<typeof console.log>;

/**
 * Format milliseconds into a human-readable string.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = ((ms % 60000) / 1000).toFixed(1);
  return `${mins}m ${secs}s`;
}

/**
 * Time an async operation and log it if verbose is enabled.
 * Returns the result of the operation.
 */
export async function timedAsync<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!verbose.enabled) {
    return fn();
  }

  verbose.log(`[START] ${label}`);
  const start = performance.now();
  try {
    const result = await fn();
    const duration = performance.now() - start;
    verbose.log(`[DONE] ${label} (${formatDuration(duration)})`);
    return result;
  } catch (err) {
    const duration = performance.now() - start;
    verbose.log(`[FAIL] ${label} (${formatDuration(duration)})`);
    throw err;
  }
}

/**
 * Time a sync operation and log it if verbose is enabled.
 * Returns the result of the operation.
 */
export function timedSync<T>(label: string, fn: () => T): T {
  if (!verbose.enabled) {
    return fn();
  }

  verbose.log(`[START] ${label}`);
  const start = performance.now();
  try {
    const result = fn();
    const duration = performance.now() - start;
    verbose.log(`[DONE] ${label} (${formatDuration(duration)})`);
    return result;
  } catch (err) {
    const duration = performance.now() - start;
    verbose.log(`[FAIL] ${label} (${formatDuration(duration)})`);
    throw err;
  }
}

/**
 * Create a timer that can be started and stopped manually.
 * Useful for operations that span multiple steps.
 */
export function createTimer(label: string): {
  start: () => void;
  stop: () => void;
  elapsed: () => number;
} {
  let startTime = 0;
  let totalElapsed = 0;

  return {
    start() {
      if (verbose.enabled) {
        verbose.log(`[START] ${label}`);
      }
      startTime = performance.now();
    },
    stop() {
      totalElapsed = performance.now() - startTime;
      if (verbose.enabled) {
        verbose.log(`[DONE] ${label} (${formatDuration(totalElapsed)})`);
      }
    },
    elapsed() {
      return totalElapsed;
    },
  };
}

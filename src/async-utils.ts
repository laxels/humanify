export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new Error(
      `Invalid concurrency: ${concurrency}. Must be a positive finite number.`,
    );
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await mapper(items[currentIndex]!, currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

export function chunkArray<T>(items: readonly T[], chunkSize: number): T[][] {
  if (!Number.isFinite(chunkSize) || chunkSize < 1) {
    throw new Error(
      `Invalid chunk size: ${chunkSize}. Must be a positive finite number.`,
    );
  }

  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}
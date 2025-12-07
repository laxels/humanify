export function parseNumber(value: string): number {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid number: ${value}`);
  }
  return parsed;
}

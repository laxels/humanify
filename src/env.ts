import { config } from "@dotenvx/dotenvx";

config();

export function env(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  return value ?? fallback;
}

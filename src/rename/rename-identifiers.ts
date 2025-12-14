import { env } from "../env";
import { parseNumber } from "../number-utils";
import { showProgress } from "../progress";
import { verbose } from "../verbose";
import { renameIdentifiersWithProvider } from "./rename-engine";
import { createAnthropicNameSuggestionProvider } from "./suggest";

const DEFAULT_LLM_CONCURRENCY = 100;
const DEFAULT_SYMBOLS_PER_BATCH = 24;

export async function renameIdentifiers(
  code: string,
  {
    model,
    contextWindowSize,
  }: {
    model?: string;
    contextWindowSize: number;
  },
): Promise<string> {
  const llmConcurrency = safeParseEnvNumber(
    "HUMANIFY_LLM_CONCURRENCY",
    DEFAULT_LLM_CONCURRENCY,
  );
  const symbolsPerBatch = safeParseEnvNumber(
    "HUMANIFY_SYMBOLS_PER_BATCH",
    DEFAULT_SYMBOLS_PER_BATCH,
  );

  if (verbose.enabled) {
    verbose.log(
      `Renaming identifiers with batched scope suggestions (concurrency=${llmConcurrency}, batchSize=${symbolsPerBatch})`,
    );
  }

  const provider = createAnthropicNameSuggestionProvider({ model });

  return await renameIdentifiersWithProvider(
    code,
    {
      contextWindowSize,
      llmConcurrency,
      symbolsPerBatch,
      onProgress: showProgress,
    },
    provider,
  );
}

function safeParseEnvNumber(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  try {
    return parseNumber(raw);
  } catch {
    return fallback;
  }
}

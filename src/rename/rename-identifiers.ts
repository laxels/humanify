import { parseAsync, transformFromAstAsync } from "@babel/core";
import { env } from "../env";
import { mapLimit } from "../promise-utils";
import { showProgress } from "../progress";
import { verbose } from "../verbose";
import { applyRenamesToAst } from "./apply-renames";
import { analyzeCodeForRenaming } from "./analyze";
import { solveRenamePlan } from "./constraints";
import { buildSymbolDossier } from "./dossier";
import { suggestNamesWithAnthropic } from "./suggest-names";
import type {
  CandidateName,
  NamingUnitSummary,
  SymbolDossier,
  SymbolSuggestion,
} from "./types";

export type SuggestionProvider = (input: {
  unit: NamingUnitSummary;
  dossiers: SymbolDossier[];
}) => Promise<SymbolSuggestion[]>;

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
  return renameIdentifiersWithProvider(
    code,
    { model, contextWindowSize },
    async ({ unit, dossiers }) =>
      suggestNamesWithAnthropic({ model, unit, dossiers, maxCandidates: 5 }),
  );
}

export async function renameIdentifiersWithProvider(
  code: string,
  {
    model,
    contextWindowSize,
  }: {
    model?: string;
    contextWindowSize: number;
  },
  provider: SuggestionProvider,
): Promise<string> {
  const analysis = await analyzeCodeForRenaming(code, contextWindowSize);

  if (analysis.symbols.length === 0) {
    return code;
  }

  // Build dossiers for all symbols once.
  const dossiersById = new Map<string, SymbolDossier>();
  for (const s of analysis.symbols) {
    dossiersById.set(s.id, buildSymbolDossier(s));
  }

  // Create LLM jobs grouped by naming unit, excluding symbols declared in unsafe scopes.
  const jobs: Array<{ unit: NamingUnitSummary; dossiers: SymbolDossier[] }> = [];

  let totalSymbolsToSuggest = 0;

  for (const unit of analysis.units) {
    const renameable = unit.symbols.filter((s) => !analysis.unsafeScopeIds.has(s.scopeId));
    if (renameable.length === 0) continue;

    totalSymbolsToSuggest += renameable.length;

    // Chunk within unit if needed (keeps requests reasonably sized while preserving unit-local coherence).
    const dossiers = renameable.map((s) => dossiersById.get(s.id)!);
    const chunks = chunkDossiers(dossiers, contextWindowSize);

    for (const chunk of chunks) {
      jobs.push({
        unit: {
          id: unit.id,
          kind: unit.kind,
          displayName: unit.displayName,
          snippet: unit.snippet,
        },
        dossiers: chunk,
      });
    }
  }

  const concurrency = getConcurrencyLimit();
  verbose.log(`Naming: ${jobs.length} LLM job(s), concurrency=${concurrency}`);

  const suggestionsBySymbolId = new Map<string, CandidateName[]>();

  let doneSymbols = 0;

  if (jobs.length > 0) {
    await mapLimit(jobs, concurrency, async (job) => {
      const suggestions = await provider(job);

      for (const s of suggestions) {
        const prev = suggestionsBySymbolId.get(s.id) ?? [];
        suggestionsBySymbolId.set(s.id, mergeCandidates(prev, s.candidates));
      }

      doneSymbols += job.dossiers.length;
      showProgress(doneSymbols, totalSymbolsToSuggest);

      return undefined;
    });

    showProgress(totalSymbolsToSuggest, totalSymbolsToSuggest);
  }

  const finalNameBySymbolId = solveRenamePlan({
    symbols: analysis.symbols,
    suggestionsBySymbolId,
    scopeMetaById: analysis.scopeMetaById,
    unsafeScopeIds: analysis.unsafeScopeIds,
  });

  // Apply renames via two-phase temp rename to allow swaps and avoid collisions.
  applyRenamesToAst(analysis.ast, analysis.symbols, finalNameBySymbolId);

  const out = await transformFromAstAsync(analysis.ast, undefined, {
    compact: false,
    minified: false,
    comments: false,
    sourceMaps: false,
    retainLines: false,
  });

  if (out?.code == null) {
    throw new Error("Failed to stringify code after renaming");
  }

  // Validation pass: ensure parseable output.
  const parsed = await parseAsync(out.code, { sourceType: "unambiguous" });
  if (!parsed) {
    throw new Error("Renamed output is not parseable");
  }

  return out.code;
}

function getConcurrencyLimit(): number {
  const raw = env("HUMANIFY_LLM_CONCURRENCY", "4");
  const n = raw ? Number(raw) : 4;
  if (!Number.isFinite(n) || n <= 0) return 4;
  return Math.max(1, Math.floor(n));
}

function mergeCandidates(
  existing: CandidateName[],
  incoming: CandidateName[],
): CandidateName[] {
  const bestByName = new Map<string, CandidateName>();

  for (const c of [...existing, ...incoming]) {
    const name = typeof c.name === "string" ? c.name : "";
    if (name.trim().length === 0) continue;

    const confidence =
      typeof c.confidence === "number" && Number.isFinite(c.confidence)
        ? c.confidence
        : 0;

    const prev = bestByName.get(name);
    if (!prev || confidence > prev.confidence) {
      bestByName.set(name, { ...c, confidence });
    }
  }

  return Array.from(bestByName.values()).sort(
    (a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name),
  );
}

function chunkDossiers(dossiers: SymbolDossier[], contextWindowSize: number): SymbolDossier[][] {
  // Keep chunks bounded. We use a simple heuristic on count and rough size.
  const maxSymbols = Math.max(8, Math.min(30, Math.floor(contextWindowSize / 50) + 10));

  const chunks: SymbolDossier[][] = [];
  for (let i = 0; i < dossiers.length; i += maxSymbols) {
    chunks.push(dossiers.slice(i, i + maxSymbols));
  }
  return chunks;
}

import { verbose } from "../verbose";
import type { ScopeChunk } from "./symbol-analysis";
import type { ScopeChunkId, SymbolDossier } from "./types";

export type RenameJob = {
  chunkId: string;
  scopeSummary: string;
  symbols: SymbolDossier[];
};

export type PlanRenameJobsOptions = {
  chunks: ScopeChunk[];
  dossiersByChunkId: Map<ScopeChunkId, SymbolDossier[]>;
  maxSymbolsPerJob: number;
  maxInputTokens: number;
  countInputTokens: (job: RenameJob) => Promise<number>;
};

type ChunkNode = {
  chunk: ScopeChunk;
  children: ChunkNode[];
  directSymbols: SymbolDossier[];
  subtreeSymbols: SymbolDossier[];
};

export async function planRenameJobs({
  chunks,
  dossiersByChunkId,
  maxSymbolsPerJob,
  maxInputTokens,
  countInputTokens,
}: PlanRenameJobsOptions): Promise<RenameJob[]> {
  const start = performance.now();
  let tokenCountCalls = 0;

  const countWithTracking = async (job: RenameJob): Promise<number> => {
    tokenCountCalls++;
    return countInputTokens(job);
  };

  verbose.log(
    `Job planning: ${chunks.length} chunks, maxSymbols=${maxSymbolsPerJob}, maxTokens=${maxInputTokens}`,
  );

  const treeStart = performance.now();
  const root = buildChunkTree(chunks, dossiersByChunkId);
  verbose.log(
    `Built chunk tree in ${(performance.now() - treeStart).toFixed(0)}ms`,
  );

  if (!root) {
    verbose.log("No root chunk found, returning empty jobs");
    return [];
  }

  const jobs: RenameJob[] = [];
  const planStart = performance.now();
  await planSubtree({
    node: root,
    jobs,
    maxSymbolsPerJob,
    maxInputTokens,
    countInputTokens: countWithTracking,
  });

  const totalDuration = performance.now() - start;
  const planDuration = performance.now() - planStart;

  verbose.log(
    `Job planning completed: ${jobs.length} jobs, ${tokenCountCalls} token count API calls, planning took ${planDuration.toFixed(0)}ms, total ${totalDuration.toFixed(0)}ms`,
  );

  return jobs;
}

function buildChunkTree(
  chunks: ScopeChunk[],
  dossiersByChunkId: Map<ScopeChunkId, SymbolDossier[]>,
): ChunkNode | null {
  const byUid = new Map<number, ScopeChunk>();
  const byId = new Map<ScopeChunkId, ScopeChunk>();

  for (const c of chunks) {
    byUid.set(c.scopeUid, c);
    byId.set(c.id, c);
  }

  let program: ScopeChunk | null = null;
  for (const c of chunks) {
    if (c.type === "program") {
      program = c;
      break;
    }
  }
  if (!program) return null;

  const nodes = new Map<ScopeChunkId, ChunkNode>();
  for (const c of chunks) {
    nodes.set(c.id, {
      chunk: c,
      children: [],
      directSymbols: dossiersByChunkId.get(c.id) ?? [],
      subtreeSymbols: [],
    });
  }

  const parentIdById = new Map<ScopeChunkId, ScopeChunkId | null>();

  for (const c of chunks) {
    if (c.id === program.id) {
      parentIdById.set(c.id, null);
      continue;
    }

    // Find nearest ancestor scope that is also a chunk scope.
    let scope = c.path.scope.parent;
    let parent: ScopeChunk | null = null;
    while (scope) {
      const maybe = byUid.get(scope.uid);
      if (maybe) {
        parent = maybe;
        break;
      }
      scope = scope.parent;
    }

    parentIdById.set(c.id, parent?.id ?? program.id);
  }

  for (const [id, parentId] of parentIdById) {
    if (!parentId) continue;
    const node = nodes.get(id);
    const parentNode = nodes.get(parentId);
    if (!node || !parentNode) continue;
    parentNode.children.push(node);
  }

  for (const node of nodes.values()) {
    node.children.sort((a, b) => a.chunk.start - b.chunk.start);
  }

  const root = nodes.get(program.id);
  if (!root) return null;

  computeSubtreeSymbols(root);
  return root;
}

function computeSubtreeSymbols(node: ChunkNode): SymbolDossier[] {
  const combined: SymbolDossier[] = [];
  combined.push(...node.directSymbols);
  for (const child of node.children) {
    combined.push(...computeSubtreeSymbols(child));
  }
  node.subtreeSymbols = combined;
  return combined;
}

async function planSubtree({
  node,
  jobs,
  maxSymbolsPerJob,
  maxInputTokens,
  countInputTokens,
}: {
  node: ChunkNode;
  jobs: RenameJob[];
  maxSymbolsPerJob: number;
  maxInputTokens: number;
  countInputTokens: (job: RenameJob) => Promise<number>;
}): Promise<void> {
  if (node.subtreeSymbols.length === 0) return;

  const scopeSummary = node.chunk.path.toString();
  const subtreeJob: RenameJob = {
    chunkId: `job_${node.chunk.id}_subtree`,
    scopeSummary,
    symbols: node.subtreeSymbols,
  };

  if (
    await jobFits({
      job: subtreeJob,
      maxSymbolsPerJob,
      maxInputTokens,
      countInputTokens,
    })
  ) {
    jobs.push(subtreeJob);
    return;
  }

  if (node.directSymbols.length > 0) {
    const directJobs = await planSymbolBatches({
      chunkIdPrefix: `job_${node.chunk.id}_direct`,
      scopeSummary,
      symbols: node.directSymbols,
      maxSymbolsPerJob,
      maxInputTokens,
      countInputTokens,
    });
    jobs.push(...directJobs);
  }

  const childJobArrays = await Promise.all(
    node.children.map(async (child) => {
      const childJobs: RenameJob[] = [];
      await planSubtree({
        node: child,
        jobs: childJobs,
        maxSymbolsPerJob,
        maxInputTokens,
        countInputTokens,
      });
      return childJobs;
    }),
  );
  for (const childJobs of childJobArrays) {
    jobs.push(...childJobs);
  }
}

async function jobFits({
  job,
  maxSymbolsPerJob,
  maxInputTokens,
  countInputTokens,
}: {
  job: RenameJob;
  maxSymbolsPerJob: number;
  maxInputTokens: number;
  countInputTokens: (job: RenameJob) => Promise<number>;
}): Promise<boolean> {
  if (job.symbols.length === 0) return true;
  if (job.symbols.length > maxSymbolsPerJob) return false;
  const tokens = await countInputTokens(job);
  return tokens <= maxInputTokens;
}

async function planSymbolBatches({
  chunkIdPrefix,
  scopeSummary,
  symbols,
  maxSymbolsPerJob,
  maxInputTokens,
  countInputTokens,
}: {
  chunkIdPrefix: string;
  scopeSummary: string;
  symbols: SymbolDossier[];
  maxSymbolsPerJob: number;
  maxInputTokens: number;
  countInputTokens: (job: RenameJob) => Promise<number>;
}): Promise<RenameJob[]> {
  const batches: SymbolDossier[][] = [];
  for (let i = 0; i < symbols.length; i += maxSymbolsPerJob) {
    batches.push(symbols.slice(i, i + maxSymbolsPerJob));
  }

  verbose.log(`Planning ${batches.length} symbol batches`);
  const batchResults = await Promise.all(
    batches.map((batch, batchIndex) =>
      ensureTokenFit({
        chunkIdPrefix: `${chunkIdPrefix}_${batchIndex}`,
        scopeSummary,
        symbols: batch,
        maxInputTokens,
        countInputTokens,
      }),
    ),
  );
  return batchResults.flat();
}

async function ensureTokenFit({
  chunkIdPrefix,
  scopeSummary,
  symbols,
  maxInputTokens,
  countInputTokens,
}: {
  chunkIdPrefix: string;
  scopeSummary: string;
  symbols: SymbolDossier[];
  maxInputTokens: number;
  countInputTokens: (job: RenameJob) => Promise<number>;
}): Promise<RenameJob[]> {
  if (symbols.length === 0) return [];

  const candidate: RenameJob = {
    chunkId: chunkIdPrefix,
    scopeSummary,
    symbols,
  };
  const tokens = await countInputTokens(candidate);
  if (tokens <= maxInputTokens) return [candidate];

  if (symbols.length > 1) {
    const mid = Math.floor(symbols.length / 2);
    const left = await ensureTokenFit({
      chunkIdPrefix: `${chunkIdPrefix}_a`,
      scopeSummary,
      symbols: symbols.slice(0, mid),
      maxInputTokens,
      countInputTokens,
    });
    const right = await ensureTokenFit({
      chunkIdPrefix: `${chunkIdPrefix}_b`,
      scopeSummary,
      symbols: symbols.slice(mid),
      maxInputTokens,
      countInputTokens,
    });
    return [...left, ...right];
  }

  // Last resort: single symbol still doesn't fit due to enormous scopeSummary.
  const truncated = await truncateScopeSummaryToFit({
    chunkId: `${chunkIdPrefix}_trunc`,
    scopeSummary,
    symbol: symbols[0]!,
    maxInputTokens,
    countInputTokens,
  });
  return [truncated];
}

async function truncateScopeSummaryToFit({
  chunkId,
  scopeSummary,
  symbol,
  maxInputTokens,
  countInputTokens,
}: {
  chunkId: string;
  scopeSummary: string;
  symbol: SymbolDossier;
  maxInputTokens: number;
  countInputTokens: (job: RenameJob) => Promise<number>;
}): Promise<RenameJob> {
  const minPrefix = Math.min(
    scopeSummary.length,
    Math.max(
      1,
      scopeSummary.includes("\n")
        ? scopeSummary.indexOf("\n") + 1
        : Math.min(200, scopeSummary.length),
    ),
  );

  let low = 1;
  let high = scopeSummary.length;
  let best = 1;

  // Prefer keeping at least a header-like prefix when possible.
  if (minPrefix > 1) {
    low = minPrefix;
    best = minPrefix;
  }

  const fitsAt = async (len: number): Promise<boolean> => {
    const job: RenameJob = {
      chunkId,
      scopeSummary: scopeSummary.slice(0, len),
      symbols: [symbol],
    };
    const tokens = await countInputTokens(job);
    return tokens <= maxInputTokens;
  };

  if (!(await fitsAt(low))) {
    // Header doesn't fit; fall back to smallest non-empty prefix.
    low = 1;
    best = 1;
  }

  if (!(await fitsAt(1))) {
    throw new Error(
      `maxInputTokens (${maxInputTokens}) is too small to fit a single-symbol request, even with a minimal scope summary`,
    );
  }

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (await fitsAt(mid)) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return {
    chunkId,
    scopeSummary: scopeSummary.slice(0, best),
    symbols: [symbol],
  };
}

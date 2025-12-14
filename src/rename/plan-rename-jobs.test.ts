import { expect, test } from "bun:test";
import { planRenameJobs } from "./plan-rename-jobs";
import { analyzeCode } from "./symbol-analysis";
import { buildSymbolDossier } from "./symbol-dossier";
import type { SymbolDossier } from "./types";

async function buildPlannerInputs(code: string): Promise<{
  chunks: Awaited<ReturnType<typeof analyzeCode>>["chunks"];
  dossiersByChunkId: Map<string, SymbolDossier[]>;
  renameableNames: string[];
}> {
  const analyzed = await analyzeCode(code);
  const renameable = analyzed.symbols.filter((s) => !s.isUnsafeToRename);

  const dossiersByChunkId = new Map<string, SymbolDossier[]>();
  for (const s of renameable) {
    const dossier = buildSymbolDossier(s, { contextWindowSize: 400 });
    const list = dossiersByChunkId.get(s.chunkId) ?? [];
    list.push(dossier);
    dossiersByChunkId.set(s.chunkId, list);
  }

  return {
    chunks: analyzed.chunks,
    dossiersByChunkId,
    renameableNames: renameable.map((s) => s.originalName),
  };
}

test("merges nested chunks into a single job when maxInputTokens is large", async () => {
  const code = `
const z = 0;
function outer(p) {
  const a = 1;
  function inner(q) {
    const b = 2;
    return a + b + z + p + q;
  }
  return inner(3);
}
`.trim();

  const { chunks, dossiersByChunkId, renameableNames } =
    await buildPlannerInputs(code);

  const jobs = await planRenameJobs({
    chunks,
    dossiersByChunkId,
    maxSymbolsPerJob: 10_000,
    maxInputTokens: 1_000_000,
    countInputTokens: async () => 1,
  });

  expect(jobs.length).toBe(1);
  expect(jobs[0]!.symbols.map((s) => s.originalName)).toEqual(renameableNames);
});

test("splits recursively along chunk boundaries when maxInputTokens is small", async () => {
  const code = `
const z = 0;
function outer(p) {
  const a = 1;
  function inner(q) {
    const b = 2;
    return a + b + z + p + q;
  }
  return inner(3);
}
`.trim();

  const { chunks, dossiersByChunkId } = await buildPlannerInputs(code);

  const jobs = await planRenameJobs({
    chunks,
    dossiersByChunkId,
    maxSymbolsPerJob: 10_000,
    maxInputTokens: 350,
    countInputTokens: async ({ symbols }) => symbols.length * 100,
  });

  expect(jobs.length).toBe(3);
  expect(jobs[0]!.symbols.map((s) => s.originalName)).toEqual(["z", "outer"]);
  expect(jobs[1]!.symbols.map((s) => s.originalName)).toEqual([
    "p",
    "a",
    "inner",
  ]);
  expect(jobs[2]!.symbols.map((s) => s.originalName)).toEqual(["q", "b"]);
});

test("maxSymbolsPerJob batches even when token budget is large", async () => {
  const code = `let a = 1, b = 2, c = 3, d = 4;`;
  const { chunks, dossiersByChunkId } = await buildPlannerInputs(code);

  const jobs = await planRenameJobs({
    chunks,
    dossiersByChunkId,
    maxSymbolsPerJob: 2,
    maxInputTokens: 1_000_000,
    countInputTokens: async () => 1,
  });

  expect(jobs.length).toBe(2);
  expect(jobs[0]!.symbols.map((s) => s.originalName)).toEqual(["a", "b"]);
  expect(jobs[1]!.symbols.map((s) => s.originalName)).toEqual(["c", "d"]);
});

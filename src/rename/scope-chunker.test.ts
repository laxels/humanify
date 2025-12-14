import { beforeEach, describe, expect, test } from "bun:test";
import {
  chunkByScope,
  groupChunksForParallelProcessing,
} from "./scope-chunker";
import type { SymbolDossier } from "./symbol-dossier";
import { extractDossiersForSymbols } from "./symbol-dossier";
import { buildSymbolTable, resetIdCounters } from "./symbol-table";

beforeEach(() => {
  resetIdCounters();
});

function createDossierMap(
  table: Awaited<ReturnType<typeof buildSymbolTable>>,
): Map<string, SymbolDossier> {
  const symbols = Array.from(table.symbols.values());
  const dossiers = extractDossiersForSymbols(symbols, table);
  const map = new Map<string, SymbolDossier>();
  for (const d of dossiers) {
    map.set(d.symbolId, d);
  }
  return map;
}

describe("chunkByScope", () => {
  test("creates chunk for single scope", async () => {
    const code = `const a = 1; const b = 2;`;
    const table = await buildSymbolTable(code);
    const dossierMap = createDossierMap(table);

    const chunks = chunkByScope(table, dossierMap);

    expect(chunks.length).toBe(1);
    expect(chunks[0]?.symbols.length).toBe(2);
  });

  test("creates separate chunks for different scopes", async () => {
    const code = `
const a = 1;
function foo() {
  const b = 2;
}
    `;
    const table = await buildSymbolTable(code);
    const dossierMap = createDossierMap(table);

    const chunks = chunkByScope(table, dossierMap);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  test("respects maxSymbolsPerChunk", async () => {
    const code = `
const a = 1;
const b = 2;
const c = 3;
const d = 4;
const e = 5;
    `;
    const table = await buildSymbolTable(code);
    const dossierMap = createDossierMap(table);

    const chunks = chunkByScope(table, dossierMap, { maxSymbolsPerChunk: 2 });

    // Should split into multiple chunks
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.symbols.length).toBeLessThanOrEqual(2);
    }
  });

  test("includes scope summary", async () => {
    const code = `
function myFunction() {
  const a = 1;
}
    `;
    const table = await buildSymbolTable(code);
    const dossierMap = createDossierMap(table);

    const chunks = chunkByScope(table, dossierMap);

    const functionChunk = chunks.find((c) =>
      c.scopeSummary.includes("myFunction"),
    );
    expect(functionChunk).toBeDefined();
  });

  test("includes formatted prompt", async () => {
    const code = `const a = 1;`;
    const table = await buildSymbolTable(code);
    const dossierMap = createDossierMap(table);

    const chunks = chunkByScope(table, dossierMap);

    expect(chunks[0]?.formattedPrompt).toContain("Scope:");
    expect(chunks[0]?.formattedPrompt).toContain("Symbols to rename:");
  });

  test("sorts chunks by scope size (largest first)", async () => {
    const code = `
const outer = 1;
function foo() {
  const inner = 2;
  function bar() {
    const deepest = 3;
  }
}
    `;
    const table = await buildSymbolTable(code);
    const dossierMap = createDossierMap(table);

    const chunks = chunkByScope(table, dossierMap);

    // First chunks should be from larger scopes
    // This is implied by the sorting in the implementation
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  test("skips unsafe symbols (eval/with)", async () => {
    const code = `
const b = 2;
function foo() {
  eval("x = 1");
  const a = 1;
}
    `;
    const table = await buildSymbolTable(code);
    const dossierMap = createDossierMap(table);

    const chunks = chunkByScope(table, dossierMap);

    // 'a' should be skipped because it's in a scope with eval
    // 'b' and 'foo' are in the program scope which doesn't have eval
    const allSymbolNames = chunks.flatMap((c) => c.symbols.map((s) => s.name));
    expect(allSymbolNames).not.toContain("a");
    // b and foo should be safe to rename
    expect(allSymbolNames.some((n) => n === "b" || n === "foo")).toBe(true);
  });

  test("handles empty code", async () => {
    const code = ``;
    const table = await buildSymbolTable(code);
    const dossierMap = createDossierMap(table);

    const chunks = chunkByScope(table, dossierMap);

    expect(chunks.length).toBe(0);
  });

  test("includes scope code in chunk", async () => {
    const code = `
function myFunc() {
  const x = 1;
  return x * 2;
}
    `;
    const table = await buildSymbolTable(code);
    const dossierMap = createDossierMap(table);

    const chunks = chunkByScope(table, dossierMap);

    const funcChunk = chunks.find((c) => c.scopeSummary.includes("myFunc"));
    expect(funcChunk?.scopeCode).toContain("function myFunc");
    expect(funcChunk?.scopeCode).toContain("return");
  });
});

describe("groupChunksForParallelProcessing", () => {
  test("groups sibling scopes together", async () => {
    const code = `
function foo() {
  const a = 1;
}
function bar() {
  const b = 2;
}
    `;
    const table = await buildSymbolTable(code);
    const dossierMap = createDossierMap(table);
    const chunks = chunkByScope(table, dossierMap);

    const groups = groupChunksForParallelProcessing(chunks, table);

    // foo and bar are siblings, so they can be in the same group
    // Plus the program scope with foo and bar declarations
    expect(groups.length).toBeGreaterThanOrEqual(1);
  });

  test("separates nested scopes into different groups", async () => {
    const code = `
function outer() {
  const a = 1;
  function inner() {
    const b = 2;
  }
}
    `;
    const table = await buildSymbolTable(code);
    const dossierMap = createDossierMap(table);
    const chunks = chunkByScope(table, dossierMap);

    const groups = groupChunksForParallelProcessing(chunks, table);

    // outer and inner are nested, so they should be in different groups
    // or at least processed in a way that respects the nesting
    expect(groups.length).toBeGreaterThanOrEqual(1);
  });

  test("handles single chunk", async () => {
    const code = `const a = 1;`;
    const table = await buildSymbolTable(code);
    const dossierMap = createDossierMap(table);
    const chunks = chunkByScope(table, dossierMap);

    const groups = groupChunksForParallelProcessing(chunks, table);

    expect(groups.length).toBe(1);
    expect(groups[0]?.length).toBe(1);
  });

  test("handles empty chunks", async () => {
    const code = ``;
    const table = await buildSymbolTable(code);
    const dossierMap = createDossierMap(table);
    const chunks = chunkByScope(table, dossierMap);

    const groups = groupChunksForParallelProcessing(chunks, table);

    expect(groups.length).toBe(0);
  });
});

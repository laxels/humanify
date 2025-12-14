import { beforeEach, describe, expect, test } from "bun:test";
import {
  extractDossiersForSymbols,
  extractSymbolDossier,
  formatDossierForLLM,
} from "./symbol-dossier";
import { buildSymbolTable, resetIdCounters } from "./symbol-table";

beforeEach(() => {
  resetIdCounters();
});

describe("extractSymbolDossier", () => {
  test("extracts basic dossier for variable", async () => {
    const code = `const a = 1;`;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values())[0]!;

    const dossier = extractSymbolDossier(symbol, table);

    expect(dossier.symbolId).toBe(symbol.id);
    expect(dossier.originalName).toBe("a");
    expect(dossier.declarationKind).toBe("const");
    // Generator may compact whitespace, so just check key parts
    expect(dossier.declarationContext).toContain("const");
    expect(dossier.declarationContext).toContain("a");
    expect(dossier.declarationContext).toContain("1");
  });

  test("detects function call usage", async () => {
    const code = `
const fn = () => {};
fn();
fn();
    `;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values()).find(
      (s) => s.name === "fn",
    )!;

    const dossier = extractSymbolDossier(symbol, table);

    expect(dossier.useSites.some((s) => s.type === "function_call")).toBe(true);
    expect(dossier.typeHints).toContain("called as function");
  });

  test("detects method call usage", async () => {
    const code = `
const arr = [1, 2, 3];
arr.map(x => x * 2);
    `;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values()).find(
      (s) => s.name === "arr",
    )!;

    const dossier = extractSymbolDossier(symbol, table);

    expect(dossier.useSites.some((s) => s.type === "method_call")).toBe(true);
    expect(dossier.typeHints).toContain("array-like");
  });

  test("detects property access usage", async () => {
    const code = `
const obj = { name: "test" };
const x = obj.name;
    `;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values()).find(
      (s) => s.name === "obj",
    )!;

    const dossier = extractSymbolDossier(symbol, table);

    // Should detect property access (not method_call since .name is not called)
    expect(dossier.useSites.some((s) => s.type === "property_access")).toBe(
      true,
    );
  });

  test("detects object shorthand usage", async () => {
    const code = `
const a = 1;
const obj = { a };
    `;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values()).find(
      (s) => s.name === "a",
    )!;

    const dossier = extractSymbolDossier(symbol, table);

    expect(dossier.usedAsObjectShorthand).toBe(true);
  });

  test("detects exported symbol", async () => {
    const code = `
const a = 1;
export { a };
    `;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values()).find(
      (s) => s.name === "a",
    )!;

    const dossier = extractSymbolDossier(symbol, table);

    expect(dossier.isExported).toBe(true);
  });

  test("detects await usage", async () => {
    const code = `
async function foo() {
  const promise = fetch('/api');
  await promise;
}
    `;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values()).find(
      (s) => s.name === "promise",
    )!;

    const dossier = extractSymbolDossier(symbol, table);

    expect(dossier.useSites.some((s) => s.type === "await")).toBe(true);
    expect(dossier.typeHints).toContain("async/Promise");
  });

  test("detects return usage", async () => {
    const code = `
function foo() {
  const result = 1;
  return result;
}
    `;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values()).find(
      (s) => s.name === "result",
    )!;

    const dossier = extractSymbolDossier(symbol, table);

    expect(dossier.useSites.some((s) => s.type === "return")).toBe(true);
  });

  test("detects comparison usage", async () => {
    const code = `
const a = 1;
if (a === 1) {}
    `;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values()).find(
      (s) => s.name === "a",
    )!;

    const dossier = extractSymbolDossier(symbol, table);

    expect(dossier.useSites.some((s) => s.type === "comparison")).toBe(true);
  });

  test("detects arithmetic usage", async () => {
    const code = `
const a = 1;
const b = a + 2;
    `;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values()).find(
      (s) => s.name === "a",
    )!;

    const dossier = extractSymbolDossier(symbol, table);

    expect(dossier.useSites.some((s) => s.type === "arithmetic")).toBe(true);
  });

  test("detects spread usage", async () => {
    const code = `
const arr = [1, 2, 3];
const arr2 = [...arr];
    `;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values()).find(
      (s) => s.name === "arr",
    )!;

    const dossier = extractSymbolDossier(symbol, table);

    expect(dossier.useSites.some((s) => s.type === "spread")).toBe(true);
  });

  test("detects string methods for type hints", async () => {
    const code = `
const str = "hello";
str.split(",");
str.toUpperCase();
    `;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values()).find(
      (s) => s.name === "str",
    )!;

    const dossier = extractSymbolDossier(symbol, table);

    expect(dossier.typeHints).toContain("string-like");
  });
});

describe("formatDossierForLLM", () => {
  test("formats dossier with all information", async () => {
    const code = `
const items = [1, 2, 3];
items.map(x => x * 2);
    `;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values()).find(
      (s) => s.name === "items",
    )!;

    const dossier = extractSymbolDossier(symbol, table);
    const formatted = formatDossierForLLM(dossier);

    expect(formatted).toContain("**items**");
    expect(formatted).toContain("const");
    expect(formatted).toContain("Declaration:");
    expect(formatted).toContain("Usage:");
  });

  test("includes shorthand warning", async () => {
    const code = `
const a = 1;
const obj = { a };
    `;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values()).find(
      (s) => s.name === "a",
    )!;

    const dossier = extractSymbolDossier(symbol, table);
    const formatted = formatDossierForLLM(dossier);

    expect(formatted).toContain("object shorthand");
  });

  test("includes export warning", async () => {
    const code = `
const a = 1;
export { a };
    `;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values()).find(
      (s) => s.name === "a",
    )!;

    const dossier = extractSymbolDossier(symbol, table);
    const formatted = formatDossierForLLM(dossier);

    expect(dossier.isExported).toBe(true);
    expect(formatted).toContain("Exported");
  });
});

describe("extractDossiersForSymbols", () => {
  test("extracts dossiers for multiple symbols", async () => {
    const code = `
const a = 1;
const b = 2;
const c = a + b;
    `;
    const table = await buildSymbolTable(code);
    const symbols = Array.from(table.symbols.values());

    const dossiers = extractDossiersForSymbols(symbols, table);

    expect(dossiers.length).toBe(3);
    expect(dossiers.map((d) => d.originalName).sort()).toEqual(["a", "b", "c"]);
  });
});

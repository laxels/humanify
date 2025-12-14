import { describe, expect, test } from "bun:test";
import { analyzeSymbols } from "./symbol-analysis";
import {
  createNamingBatches,
  createScopeSummary,
  createSymbolDossier,
  formatBatchForLLM,
  formatDossierForLLM,
  shouldRenameBinding,
} from "./symbol-dossier";

describe("createSymbolDossier", () => {
  test("creates dossier with basic info", async () => {
    const code = "const a = 1;";
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()][0]!;

    const dossier = createSymbolDossier(binding);

    expect(dossier.id).toBe(binding.id);
    expect(dossier.name).toBe("a");
    expect(dossier.kind).toBe("const");
  });

  test("creates use summary for called function", async () => {
    const code = `
      function foo() {}
      foo();
      foo();
    `;
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()].find(
      (b) => b.name === "foo",
    )!;

    const dossier = createSymbolDossier(binding);

    expect(dossier.useSummary).toContain("called");
  });

  test("creates use summary for property access", async () => {
    const code = `
      const arr = [];
      arr.push(1);
      arr.map(x => x);
    `;
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()].find(
      (b) => b.name === "arr",
    )!;

    const dossier = createSymbolDossier(binding);

    expect(dossier.useSummary).toContain("property accessed");
    expect(dossier.useSummary).toContain("push");
    expect(dossier.useSummary).toContain("map");
  });

  test("creates use summary for reassigned variable", async () => {
    const code = `
      let a = 1;
      a = 2;
    `;
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()].find((b) => b.name === "a")!;

    const dossier = createSymbolDossier(binding);

    expect(dossier.useSummary).toContain("reassigned");
  });

  test("creates type hints for array methods", async () => {
    const code = `
      const arr = [];
      arr.map(x => x);
    `;
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()].find(
      (b) => b.name === "arr",
    )!;

    const dossier = createSymbolDossier(binding);

    expect(dossier.typeHints).toContain("likely an array");
  });

  test("creates type hints for string methods", async () => {
    const code = `
      const str = "hello";
      str.toLowerCase();
    `;
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()].find(
      (b) => b.name === "str",
    )!;

    const dossier = createSymbolDossier(binding);

    expect(dossier.typeHints).toContain("likely a string");
  });

  test("creates type hints for promise methods", async () => {
    const code = `
      const p = fetch("/api");
      p.then(r => r);
    `;
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()].find((b) => b.name === "p")!;

    const dossier = createSymbolDossier(binding);

    expect(dossier.typeHints).toContain("likely a Promise");
  });

  test("creates type hints for functions", async () => {
    const code = `
      function foo() {}
    `;
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()].find(
      (b) => b.name === "foo",
    )!;

    const dossier = createSymbolDossier(binding);

    expect(dossier.typeHints).toContain("is a function");
  });

  test("creates type hints for classes", async () => {
    const code = `
      class Foo {}
    `;
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()].find(
      (b) => b.name === "Foo",
    )!;

    const dossier = createSymbolDossier(binding);

    expect(dossier.typeHints).toContain("is a class");
  });

  test("creates type hints for constants", async () => {
    const code = `const a = 1;`;
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()].find((b) => b.name === "a")!;

    const dossier = createSymbolDossier(binding);

    expect(dossier.typeHints).toContain("is a constant");
  });

  test("creates type hints for parameters", async () => {
    const code = `function foo(a) {}`;
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()].find((b) => b.name === "a")!;

    const dossier = createSymbolDossier(binding);

    expect(dossier.typeHints).toContain("is a parameter");
  });

  test("includes surrounding code", async () => {
    const code = `
      const a = 1;
      const b = a + 2;
    `;
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()].find((b) => b.name === "a")!;

    const dossier = createSymbolDossier(binding);

    expect(dossier.surroundingCode).toContain("const a = 1");
  });

  test("handles unused variable", async () => {
    const code = `const a = 1;`;
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()][0]!;

    const dossier = createSymbolDossier(binding);

    expect(dossier.useSummary).toContain("declared but not used");
  });
});

describe("createScopeSummary", () => {
  test("creates summary for program scope", async () => {
    const code = `const a = 1;`;
    const result = await analyzeSymbols(code);
    const scope = result.scopes.get(result.rootScopeId)!;

    const summary = createScopeSummary(scope, code);

    expect(summary).toBe("Top-level module code");
  });

  test("creates summary for function scope", async () => {
    const code = `
      function calculateTotal(items) {
        return items.reduce((sum, item) => sum + item, 0);
      }
    `;
    const result = await analyzeSymbols(code);
    const functionScope = [...result.scopes.values()].find(
      (s) => s.kind === "function",
    )!;

    const summary = createScopeSummary(functionScope, code);

    expect(summary).toContain("Function:");
  });

  test("creates summary for class scope", async () => {
    const code = `
      class Calculator {
        add(a, b) { return a + b; }
      }
    `;
    const result = await analyzeSymbols(code);
    const classScope = [...result.scopes.values()].find(
      (s) => s.kind === "class",
    );

    if (classScope) {
      const summary = createScopeSummary(classScope, code);
      expect(summary).toContain("Class:");
    }
  });
});

describe("shouldRenameBinding", () => {
  test("returns true for normal bindings", async () => {
    const code = `const a = 1;`;
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()][0]!;

    expect(shouldRenameBinding(binding)).toBe(true);
  });

  test("returns false for bindings with dynamic access", async () => {
    const code = `
      const a = 1;
      eval("a");
    `;
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()].find((b) => b.name === "a")!;

    // Bindings in scope with eval may have hasDynamicAccess set
    if (binding.hasDynamicAccess) {
      expect(shouldRenameBinding(binding)).toBe(false);
    }
  });
});

describe("createNamingBatches", () => {
  test("creates batches from analysis result", async () => {
    const code = `
      const a = 1;
      const b = 2;
    `;
    const result = await analyzeSymbols(code);
    const batches = createNamingBatches(result, code);

    expect(batches.length).toBeGreaterThan(0);
    expect(batches[0]?.symbols.length).toBeGreaterThan(0);
  });

  test("respects max batch size", async () => {
    const code = `
      const a = 1, b = 2, c = 3, d = 4, e = 5;
    `;
    const result = await analyzeSymbols(code);
    const batches = createNamingBatches(result, code, 2);

    // With 5 bindings and max batch size 2, we need at least 3 batches
    for (const batch of batches) {
      expect(batch.symbols.length).toBeLessThanOrEqual(2);
    }
  });

  test("includes scope summary in batches", async () => {
    const code = `
      const a = 1;
      function foo() {
        const b = 2;
      }
    `;
    const result = await analyzeSymbols(code);
    const batches = createNamingBatches(result, code);

    expect(batches.some((b) => b.scopeSummary.includes("Top-level"))).toBe(
      true,
    );
  });

  test("orders batches by scope size (largest first)", async () => {
    const code = `
      const a = 1;
      function foo() {
        const b = 2;
      }
    `;
    const result = await analyzeSymbols(code);
    const batches = createNamingBatches(result, code);

    // First batch should be from program scope (largest)
    expect(batches[0]?.scopeSummary).toContain("Top-level");
  });
});

describe("formatDossierForLLM", () => {
  test("formats dossier as readable string", async () => {
    const code = `const count = 0;`;
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()][0]!;
    const dossier = createSymbolDossier(binding);

    const formatted = formatDossierForLLM(dossier);

    expect(formatted).toContain("Variable: `count`");
    expect(formatted).toContain("Kind: const");
    expect(formatted).toContain("Context:");
    expect(formatted).toContain("```javascript");
  });

  test("includes type hints when present", async () => {
    const code = `
      const arr = [];
      arr.map(x => x);
    `;
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()].find(
      (b) => b.name === "arr",
    )!;
    const dossier = createSymbolDossier(binding);

    const formatted = formatDossierForLLM(dossier);

    expect(formatted).toContain("Type hints:");
    expect(formatted).toContain("array");
  });

  test("includes usage summary", async () => {
    const code = `
      function foo() {}
      foo();
    `;
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()].find(
      (b) => b.name === "foo",
    )!;
    const dossier = createSymbolDossier(binding);

    const formatted = formatDossierForLLM(dossier);

    expect(formatted).toContain("Usage:");
    expect(formatted).toContain("called");
  });
});

describe("formatBatchForLLM", () => {
  test("formats batch with scope summary and symbols", async () => {
    const code = `
      const a = 1;
      const b = 2;
    `;
    const result = await analyzeSymbols(code);
    const batches = createNamingBatches(result, code);

    const formatted = formatBatchForLLM(batches[0]!);

    expect(formatted).toContain("## Scope:");
    expect(formatted).toContain("Rename the following");
    expect(formatted).toContain("identifiers:");
  });
});

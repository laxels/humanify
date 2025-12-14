import { describe, expect, test } from "bun:test";
import { analyzeCode } from "./scope-analyzer";
import {
  buildTypeHints,
  extractSymbolDossiers,
  formatDossierForLLM,
  formatDossiersForBatch,
  inferType,
  truncateContext,
} from "./symbol-dossier";
import type { TypeHints, UseSite } from "./types";

describe("truncateContext", () => {
  test("returns short strings unchanged", () => {
    expect(truncateContext("hello")).toBe("hello");
  });

  test("truncates long strings with ellipsis", () => {
    const long = "a".repeat(200);
    const result = truncateContext(long, 50);
    expect(result.length).toBe(50);
    expect(result.endsWith("...")).toBe(true);
  });

  test("normalizes whitespace", () => {
    expect(truncateContext("  hello   world  ")).toBe("hello world");
  });

  test("normalizes newlines", () => {
    expect(truncateContext("hello\n\nworld")).toBe("hello world");
  });
});

describe("inferType", () => {
  test("infers array from array methods", () => {
    const hints: TypeHints = {
      methodsCalled: ["map", "filter"],
      propertiesAccessed: [],
      isCalledAsFunction: false,
      isConstructed: false,
      isAwaited: false,
      hasTypeofCheck: false,
      hasInstanceofCheck: false,
    };
    expect(inferType(hints)).toBe("array");
  });

  test("infers array from length property", () => {
    const hints: TypeHints = {
      methodsCalled: [],
      propertiesAccessed: ["length"],
      isCalledAsFunction: false,
      isConstructed: false,
      isAwaited: false,
      hasTypeofCheck: false,
      hasInstanceofCheck: false,
    };
    expect(inferType(hints)).toBe("array");
  });

  test("infers string from string methods", () => {
    const hints: TypeHints = {
      methodsCalled: ["toLowerCase", "trim"],
      propertiesAccessed: [],
      isCalledAsFunction: false,
      isConstructed: false,
      isAwaited: false,
      hasTypeofCheck: false,
      hasInstanceofCheck: false,
    };
    expect(inferType(hints)).toBe("string");
  });

  test("infers promise from await", () => {
    const hints: TypeHints = {
      methodsCalled: [],
      propertiesAccessed: [],
      isCalledAsFunction: false,
      isConstructed: false,
      isAwaited: true,
      hasTypeofCheck: false,
      hasInstanceofCheck: false,
    };
    expect(inferType(hints)).toBe("promise");
  });

  test("infers promise from then/catch methods", () => {
    const hints: TypeHints = {
      methodsCalled: ["then", "catch"],
      propertiesAccessed: [],
      isCalledAsFunction: false,
      isConstructed: false,
      isAwaited: false,
      hasTypeofCheck: false,
      hasInstanceofCheck: false,
    };
    expect(inferType(hints)).toBe("promise");
  });

  test("infers function when called", () => {
    const hints: TypeHints = {
      methodsCalled: [],
      propertiesAccessed: [],
      isCalledAsFunction: true,
      isConstructed: false,
      isAwaited: false,
      hasTypeofCheck: false,
      hasInstanceofCheck: false,
    };
    expect(inferType(hints)).toBe("function");
  });

  test("infers class when constructed", () => {
    const hints: TypeHints = {
      methodsCalled: [],
      propertiesAccessed: [],
      isCalledAsFunction: false,
      isConstructed: true,
      isAwaited: false,
      hasTypeofCheck: false,
      hasInstanceofCheck: false,
    };
    expect(inferType(hints)).toBe("class");
  });

  test("infers object when has properties", () => {
    const hints: TypeHints = {
      methodsCalled: [],
      propertiesAccessed: ["foo", "bar"],
      isCalledAsFunction: false,
      isConstructed: false,
      isAwaited: false,
      hasTypeofCheck: false,
      hasInstanceofCheck: false,
    };
    expect(inferType(hints)).toBe("object");
  });

  test("returns undefined when no signals", () => {
    const hints: TypeHints = {
      methodsCalled: [],
      propertiesAccessed: [],
      isCalledAsFunction: false,
      isConstructed: false,
      isAwaited: false,
      hasTypeofCheck: false,
      hasInstanceofCheck: false,
    };
    expect(inferType(hints)).toBeUndefined();
  });
});

describe("buildTypeHints", () => {
  test("aggregates method calls", () => {
    const useSites: UseSite[] = [
      { kind: "method_call", context: "x.map()", methodName: "map" },
      { kind: "method_call", context: "x.filter()", methodName: "filter" },
    ];
    const hints = buildTypeHints(useSites);
    expect(hints.methodsCalled).toContain("map");
    expect(hints.methodsCalled).toContain("filter");
  });

  test("aggregates property accesses", () => {
    const useSites: UseSite[] = [
      { kind: "property_access", context: "x.foo", propertyName: "foo" },
      { kind: "property_access", context: "x.bar", propertyName: "bar" },
    ];
    const hints = buildTypeHints(useSites);
    expect(hints.propertiesAccessed).toContain("foo");
    expect(hints.propertiesAccessed).toContain("bar");
  });

  test("deduplicates method calls", () => {
    const useSites: UseSite[] = [
      { kind: "method_call", context: "x.map(a)", methodName: "map" },
      { kind: "method_call", context: "x.map(b)", methodName: "map" },
    ];
    const hints = buildTypeHints(useSites);
    expect(hints.methodsCalled.filter((m) => m === "map").length).toBe(1);
  });

  test("detects function calls", () => {
    const useSites: UseSite[] = [{ kind: "call", context: "foo()" }];
    const hints = buildTypeHints(useSites);
    expect(hints.isCalledAsFunction).toBe(true);
  });

  test("detects construction", () => {
    const useSites: UseSite[] = [{ kind: "new", context: "new Foo()" }];
    const hints = buildTypeHints(useSites);
    expect(hints.isConstructed).toBe(true);
  });

  test("detects await", () => {
    const useSites: UseSite[] = [{ kind: "await", context: "await foo" }];
    const hints = buildTypeHints(useSites);
    expect(hints.isAwaited).toBe(true);
  });

  test("detects typeof", () => {
    const useSites: UseSite[] = [{ kind: "typeof", context: "typeof foo" }];
    const hints = buildTypeHints(useSites);
    expect(hints.hasTypeofCheck).toBe(true);
  });

  test("detects instanceof", () => {
    const useSites: UseSite[] = [
      { kind: "instanceof", context: "foo instanceof Bar" },
    ];
    const hints = buildTypeHints(useSites);
    expect(hints.hasInstanceofCheck).toBe(true);
  });
});

describe("extractSymbolDossiers", () => {
  test("extracts dossiers for simple variables", async () => {
    const code = `
      const a = 1;
      const b = a + 2;
    `;
    const result = await analyzeCode(code);
    const dossiers = extractSymbolDossiers(result.ast, result);

    expect(dossiers.size).toBe(2);
  });

  test("extracts declaration context", async () => {
    const code = "const myVar = 'hello';";
    const result = await analyzeCode(code);
    const dossiers = extractSymbolDossiers(result.ast, result);

    const dossier = Array.from(dossiers.values())[0];
    expect(dossier?.declarationContext).toContain("myVar");
  });

  test("extracts use sites for method calls", async () => {
    const code = `
      const arr = [1, 2, 3];
      arr.map(x => x * 2);
      arr.filter(x => x > 1);
    `;
    const result = await analyzeCode(code);
    const dossiers = extractSymbolDossiers(result.ast, result);

    const arrDossier = Array.from(dossiers.values()).find(
      (d) => d.originalName === "arr",
    );
    expect(arrDossier?.useSites.length).toBeGreaterThan(0);
    expect(arrDossier?.typeHints.methodsCalled).toContain("map");
    expect(arrDossier?.typeHints.methodsCalled).toContain("filter");
  });

  test("extracts use sites for function calls", async () => {
    const code = `
      function doSomething() {}
      doSomething();
    `;
    const result = await analyzeCode(code);
    const dossiers = extractSymbolDossiers(result.ast, result);

    const fnDossier = Array.from(dossiers.values()).find(
      (d) => d.originalName === "doSomething",
    );
    expect(fnDossier?.typeHints.isCalledAsFunction).toBe(true);
  });

  test("detects exported bindings", async () => {
    const code = `
      export const foo = 1;
      const bar = 2;
    `;
    const result = await analyzeCode(code);
    const dossiers = extractSymbolDossiers(result.ast, result);

    const fooDossier = Array.from(dossiers.values()).find(
      (d) => d.originalName === "foo",
    );
    const barDossier = Array.from(dossiers.values()).find(
      (d) => d.originalName === "bar",
    );

    expect(fooDossier?.isExported).toBe(true);
    expect(barDossier?.isExported).toBe(false);
  });

  test("handles classes", async () => {
    const code = `
      class MyClass {
        constructor() {}
        method() {}
      }
    `;
    const result = await analyzeCode(code);
    const dossiers = extractSymbolDossiers(result.ast, result);

    const classDossier = Array.from(dossiers.values()).find(
      (d) => d.originalName === "MyClass",
    );
    expect(classDossier?.declarationKind).toBe("class");
  });

  test("handles function parameters", async () => {
    const code = `
      function process(input, options) {
        return input + options.value;
      }
    `;
    const result = await analyzeCode(code);
    const dossiers = extractSymbolDossiers(result.ast, result);

    const inputDossier = Array.from(dossiers.values()).find(
      (d) => d.originalName === "input",
    );
    const optionsDossier = Array.from(dossiers.values()).find(
      (d) => d.originalName === "options",
    );

    expect(inputDossier?.declarationKind).toBe("param");
    expect(optionsDossier?.declarationKind).toBe("param");
  });
});

describe("formatDossierForLLM", () => {
  test("includes original name", async () => {
    const code = "const myVar = 1;";
    const result = await analyzeCode(code);
    const dossiers = extractSymbolDossiers(result.ast, result);
    const dossier = Array.from(dossiers.values())[0]!;

    const formatted = formatDossierForLLM(dossier);
    expect(formatted).toContain("myVar");
  });

  test("includes declaration kind", async () => {
    const code = "const myVar = 1;";
    const result = await analyzeCode(code);
    const dossiers = extractSymbolDossiers(result.ast, result);
    const dossier = Array.from(dossiers.values())[0]!;

    const formatted = formatDossierForLLM(dossier);
    expect(formatted).toContain("const");
  });

  test("includes inferred type when available", async () => {
    const code = `
      const arr = [];
      arr.map(x => x);
    `;
    const result = await analyzeCode(code);
    const dossiers = extractSymbolDossiers(result.ast, result);
    const arrDossier = Array.from(dossiers.values()).find(
      (d) => d.originalName === "arr",
    );

    if (arrDossier?.typeHints.inferredType) {
      const formatted = formatDossierForLLM(arrDossier);
      expect(formatted).toContain("Inferred type:");
    }
  });

  test("includes export warning", async () => {
    const code = "export const foo = 1;";
    const result = await analyzeCode(code);
    const dossiers = extractSymbolDossiers(result.ast, result);
    const dossier = Array.from(dossiers.values())[0]!;

    const formatted = formatDossierForLLM(dossier);
    expect(formatted).toContain("exported");
  });
});

describe("formatDossiersForBatch", () => {
  test("formats multiple dossiers with separators", async () => {
    const code = `
      const a = 1;
      const b = 2;
    `;
    const result = await analyzeCode(code);
    const dossiers = extractSymbolDossiers(result.ast, result);
    const dossiersArray = Array.from(dossiers.values());

    const formatted = formatDossiersForBatch(dossiersArray);
    expect(formatted).toContain("---");
  });
});

describe("use site detection", () => {
  test("detects arithmetic operations", async () => {
    const code = `
      const x = 5;
      const y = x + 10;
      const z = x * 2;
    `;
    const result = await analyzeCode(code);
    const dossiers = extractSymbolDossiers(result.ast, result);

    const xDossier = Array.from(dossiers.values()).find(
      (d) => d.originalName === "x",
    );
    const arithmeticSites = xDossier?.useSites.filter(
      (s) => s.kind === "arithmetic",
    );
    expect(arithmeticSites?.length).toBeGreaterThan(0);
  });

  test("detects comparison operations", async () => {
    const code = `
      const x = 5;
      if (x === 5) {}
      if (x > 3) {}
    `;
    const result = await analyzeCode(code);
    const dossiers = extractSymbolDossiers(result.ast, result);

    const xDossier = Array.from(dossiers.values()).find(
      (d) => d.originalName === "x",
    );
    const comparisonSites = xDossier?.useSites.filter(
      (s) => s.kind === "comparison",
    );
    expect(comparisonSites?.length).toBeGreaterThan(0);
  });

  test("detects spread operator", async () => {
    const code = `
      const arr = [1, 2, 3];
      const copy = [...arr];
    `;
    const result = await analyzeCode(code);
    const dossiers = extractSymbolDossiers(result.ast, result);

    const arrDossier = Array.from(dossiers.values()).find(
      (d) => d.originalName === "arr",
    );
    const spreadSites = arrDossier?.useSites.filter((s) => s.kind === "spread");
    expect(spreadSites?.length).toBeGreaterThan(0);
  });

  test("detects return statements", async () => {
    const code = `
      function foo() {
        const result = 42;
        return result;
      }
    `;
    const result = await analyzeCode(code);
    const dossiers = extractSymbolDossiers(result.ast, result);

    const resultDossier = Array.from(dossiers.values()).find(
      (d) => d.originalName === "result",
    );
    const returnSites = resultDossier?.useSites.filter(
      (s) => s.kind === "return",
    );
    expect(returnSites?.length).toBeGreaterThan(0);
  });

  test("detects shorthand properties", async () => {
    const code = `
      const foo = 1;
      const obj = { foo };
    `;
    const result = await analyzeCode(code);
    const dossiers = extractSymbolDossiers(result.ast, result);

    const fooDossier = Array.from(dossiers.values()).find(
      (d) => d.originalName === "foo",
    );
    const shorthandSites = fooDossier?.useSites.filter(
      (s) => s.kind === "shorthand_property",
    );
    expect(shorthandSites?.length).toBeGreaterThan(0);
  });
});

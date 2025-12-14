import { describe, expect, test } from "bun:test";
import {
  analyzeSymbols,
  getBindingsSortedByScopeSize,
  getScopesBySize,
  groupBindingsByScope,
} from "./symbol-analysis";

describe("analyzeSymbols", () => {
  test("parses simple variable declaration", async () => {
    const code = "const a = 1;";
    const result = await analyzeSymbols(code);

    expect(result.bindings.size).toBe(1);
    expect(result.scopes.size).toBeGreaterThanOrEqual(1);

    const binding = [...result.bindings.values()][0]!;
    expect(binding.name).toBe("a");
    expect(binding.kind).toBe("const");
  });

  test("parses let and var declarations", async () => {
    const code = `
      let a = 1;
      var b = 2;
    `;
    const result = await analyzeSymbols(code);

    expect(result.bindings.size).toBe(2);

    const bindings = [...result.bindings.values()];
    const letBinding = bindings.find((b) => b.name === "a");
    const varBinding = bindings.find((b) => b.name === "b");

    expect(letBinding?.kind).toBe("let");
    expect(varBinding?.kind).toBe("var");
  });

  test("parses function declarations", async () => {
    const code = `
      function foo() {
        const x = 1;
      }
    `;
    const result = await analyzeSymbols(code);

    expect(result.bindings.size).toBe(2);

    const bindings = [...result.bindings.values()];
    const fooBinding = bindings.find((b) => b.name === "foo");
    const xBinding = bindings.find((b) => b.name === "x");

    expect(fooBinding?.kind).toBe("function");
    expect(xBinding?.kind).toBe("const");
  });

  test("parses class declarations", async () => {
    const code = `
      class Foo {
        bar() {}
      }
    `;
    const result = await analyzeSymbols(code);

    const bindings = [...result.bindings.values()];
    const fooBinding = bindings.find((b) => b.name === "Foo");

    expect(fooBinding?.kind).toBe("class");
  });

  test("parses function parameters", async () => {
    const code = `
      function foo(a, b) {
        return a + b;
      }
    `;
    const result = await analyzeSymbols(code);

    const bindings = [...result.bindings.values()];
    const paramA = bindings.find((b) => b.name === "a");
    const paramB = bindings.find((b) => b.name === "b");

    expect(paramA?.kind).toBe("param");
    expect(paramB?.kind).toBe("param");
  });

  test("collects references for bindings", async () => {
    const code = `
      const a = 1;
      const b = a + 2;
      console.log(a, b);
    `;
    const result = await analyzeSymbols(code);

    const bindings = [...result.bindings.values()];
    const aBinding = bindings.find((b) => b.name === "a");

    expect(aBinding?.references.length).toBeGreaterThanOrEqual(2); // used in b declaration and console.log
  });

  test("identifies call references", async () => {
    const code = `
      function foo() {}
      foo();
    `;
    const result = await analyzeSymbols(code);

    const bindings = [...result.bindings.values()];
    const fooBinding = bindings.find((b) => b.name === "foo");

    const callRef = fooBinding?.references.find((r) => r.type === "call");
    expect(callRef).toBeDefined();
  });

  test("identifies property access references", async () => {
    const code = `
      const arr = [1, 2, 3];
      arr.map(x => x * 2);
    `;
    const result = await analyzeSymbols(code);

    const bindings = [...result.bindings.values()];
    const arrBinding = bindings.find((b) => b.name === "arr");

    const propRef = arrBinding?.references.find(
      (r) => r.type === "property-access",
    );
    expect(propRef).toBeDefined();
    expect(propRef?.context).toBe("map");
  });

  test("identifies write references", async () => {
    const code = `
      let a = 1;
      a = 2;
    `;
    const result = await analyzeSymbols(code);

    const bindings = [...result.bindings.values()];
    const aBinding = bindings.find((b) => b.name === "a");

    const writeRef = aBinding?.references.find((r) => r.type === "write");
    expect(writeRef).toBeDefined();
  });

  test("identifies shorthand references", async () => {
    const code = `
      const a = 1;
      const obj = { a };
    `;
    const result = await analyzeSymbols(code);

    const bindings = [...result.bindings.values()];
    const aBinding = bindings.find((b) => b.name === "a");

    const shorthandRef = aBinding?.references.find(
      (r) => r.type === "shorthand",
    );
    expect(shorthandRef).toBeDefined();
  });

  test("detects eval as dynamic feature", async () => {
    const code = `
      const a = 1;
      eval("a");
    `;
    const result = await analyzeSymbols(code);

    expect(result.hasDynamicFeatures).toBe(true);
  });

  test("detects with statement as dynamic feature", async () => {
    const code = `
      const obj = { a: 1 };
      with (obj) {
        console.log(a);
      }
    `;
    const result = await analyzeSymbols(code);

    expect(result.hasDynamicFeatures).toBe(true);
  });

  test("handles nested scopes", async () => {
    const code = `
      const a = 1;
      function outer() {
        const b = 2;
        function inner() {
          const c = 3;
        }
      }
    `;
    const result = await analyzeSymbols(code);

    expect(result.bindings.size).toBe(5); // a, outer, b, inner, c
    expect(result.scopes.size).toBeGreaterThanOrEqual(3); // program, outer, inner
  });

  test("handles shadowed variables", async () => {
    const code = `
      const a = 1;
      function foo() {
        const a = 2;
      }
    `;
    const result = await analyzeSymbols(code);

    const bindings = [...result.bindings.values()];
    const aBindings = bindings.filter((b) => b.name === "a");

    expect(aBindings.length).toBe(2);
    expect(aBindings[0]?.scopeId).not.toBe(aBindings[1]?.scopeId);
  });

  test("identifies exported bindings", async () => {
    const code = `
      export const a = 1;
    `;
    const result = await analyzeSymbols(code);

    const bindings = [...result.bindings.values()];
    const aBinding = bindings.find((b) => b.name === "a");

    expect(aBinding?.isExported).toBe(true);
  });

  test("extracts usage hints", async () => {
    const code = `
      const arr = [1, 2, 3];
      arr.map(x => x);
      arr.filter(x => x > 1);
    `;
    const result = await analyzeSymbols(code);

    const bindings = [...result.bindings.values()];
    const arrBinding = bindings.find((b) => b.name === "arr");

    expect(arrBinding?.usageHints.length).toBeGreaterThan(0);
    const mapHint = arrBinding?.usageHints.find((h) => h.hint.includes("map"));
    expect(mapHint).toBeDefined();
  });

  test("extracts surrounding code context", async () => {
    const code = `
      const a = 1;
      const b = a + 2;
    `;
    const result = await analyzeSymbols(code);

    const bindings = [...result.bindings.values()];
    const aBinding = bindings.find((b) => b.name === "a");

    expect(aBinding?.surroundingCode).toContain("const a = 1");
  });

  test("handles empty code", async () => {
    const code = "";
    const result = await analyzeSymbols(code);
    expect(result.bindings.size).toBe(0);
    expect(result.scopes.size).toBeGreaterThanOrEqual(1); // At least program scope
  });

  test("handles code with no identifiers", async () => {
    const code = "1 + 2;";
    const result = await analyzeSymbols(code);

    expect(result.bindings.size).toBe(0);
  });

  test("handles arrow functions", async () => {
    const code = `
      const add = (a, b) => a + b;
    `;
    const result = await analyzeSymbols(code);

    const bindings = [...result.bindings.values()];
    expect(bindings.some((b) => b.name === "add")).toBe(true);
    expect(bindings.some((b) => b.name === "a")).toBe(true);
    expect(bindings.some((b) => b.name === "b")).toBe(true);
  });

  test("handles destructuring", async () => {
    const code = `
      const { a, b } = { a: 1, b: 2 };
    `;
    const result = await analyzeSymbols(code);

    const bindings = [...result.bindings.values()];
    expect(bindings.some((b) => b.name === "a")).toBe(true);
    expect(bindings.some((b) => b.name === "b")).toBe(true);
  });

  test("handles array destructuring", async () => {
    const code = `
      const [a, b] = [1, 2];
    `;
    const result = await analyzeSymbols(code);

    const bindings = [...result.bindings.values()];
    expect(bindings.some((b) => b.name === "a")).toBe(true);
    expect(bindings.some((b) => b.name === "b")).toBe(true);
  });

  test("handles catch clause bindings", async () => {
    const code = `
      try {
        throw new Error();
      } catch (e) {
        console.log(e);
      }
    `;
    const result = await analyzeSymbols(code);

    const bindings = [...result.bindings.values()];
    const eBinding = bindings.find((b) => b.name === "e");

    expect(eBinding?.kind).toBe("catch");
  });
});

describe("getBindingsSortedByScopeSize", () => {
  test("returns bindings sorted by scope size descending", async () => {
    const code = `
      const a = 1;
      function foo() {
        const b = 2;
        function bar() {
          const c = 3;
        }
      }
    `;
    const result = await analyzeSymbols(code);
    const sorted = getBindingsSortedByScopeSize(result);

    // Outer scope bindings should come first
    const names = sorted.map((b) => b.name);
    expect(names.indexOf("a")).toBeLessThan(names.indexOf("b"));
    expect(names.indexOf("b")).toBeLessThan(names.indexOf("c"));
  });
});

describe("groupBindingsByScope", () => {
  test("groups bindings by their scope", async () => {
    const code = `
      const a = 1;
      const b = 2;
      function foo() {
        const c = 3;
      }
    `;
    const result = await analyzeSymbols(code);
    const groups = groupBindingsByScope(result);

    // Should have at least 2 groups (program scope and function scope)
    expect(groups.size).toBeGreaterThanOrEqual(2);

    // Program scope should have at least a, b, and foo
    const programScopeGroup = [...groups.values()].find(
      (bindings) => bindings.length >= 3,
    );
    expect(programScopeGroup).toBeDefined();
  });
});

describe("getScopesBySize", () => {
  test("returns scopes sorted by size descending", async () => {
    const code = `
      const a = 1;
      function foo() {
        const b = 2;
      }
    `;
    const result = await analyzeSymbols(code);
    const sorted = getScopesBySize(result);

    // First scope should be the largest (program)
    expect(sorted[0]?.kind).toBe("program");
  });
});

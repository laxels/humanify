import { describe, expect, test } from "bun:test";
import { applyRenames, applyRenamesDirect } from "./apply-renames";
import { analyzeSymbols } from "./symbol-analysis";
import type { ResolvedRename } from "./types";

describe("applyRenamesDirect", () => {
  test("renames a simple variable", async () => {
    const code = "const a = 1;";
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()][0]!;

    const renames: ResolvedRename[] = [
      {
        bindingId: binding.id,
        originalName: "a",
        newName: "count",
        confidence: 0.9,
      },
    ];

    const renamed = await applyRenamesDirect(result, renames);

    expect(renamed).toContain("count");
    expect(renamed).not.toContain("const a");
  });

  test("renames multiple variables", async () => {
    const code = `
      const a = 1;
      const b = 2;
      const c = a + b;
    `;
    const result = await analyzeSymbols(code);
    const bindings = [...result.bindings.values()];

    const renames: ResolvedRename[] = bindings.map((b, i) => ({
      bindingId: b.id,
      originalName: b.name,
      newName: ["first", "second", "sum"][i]!,
      confidence: 0.9,
    }));

    const renamed = await applyRenamesDirect(result, renames);

    expect(renamed).toContain("first");
    expect(renamed).toContain("second");
    expect(renamed).toContain("sum");
    expect(renamed).toContain("first + second");
  });

  test("renames function declarations", async () => {
    const code = `
      function foo() {
        return 42;
      }
      foo();
    `;
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()].find(
      (b) => b.name === "foo",
    )!;

    const renames: ResolvedRename[] = [
      {
        bindingId: binding.id,
        originalName: "foo",
        newName: "getAnswer",
        confidence: 0.9,
      },
    ];

    const renamed = await applyRenamesDirect(result, renames);

    expect(renamed).toContain("function getAnswer");
    expect(renamed).toContain("getAnswer()");
    expect(renamed).not.toContain("foo");
  });

  test("renames function parameters", async () => {
    const code = `
      function add(a, b) {
        return a + b;
      }
    `;
    const result = await analyzeSymbols(code);
    const paramA = [...result.bindings.values()].find((b) => b.name === "a")!;
    const paramB = [...result.bindings.values()].find((b) => b.name === "b")!;

    const renames: ResolvedRename[] = [
      {
        bindingId: paramA.id,
        originalName: "a",
        newName: "left",
        confidence: 0.9,
      },
      {
        bindingId: paramB.id,
        originalName: "b",
        newName: "right",
        confidence: 0.9,
      },
    ];

    const renamed = await applyRenamesDirect(result, renames);

    expect(renamed).toContain("left");
    expect(renamed).toContain("right");
    expect(renamed).toContain("left + right");
  });

  test("renames class declarations", async () => {
    const code = `
      class Foo {
        bar() { return 1; }
      }
      const f = new Foo();
    `;
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()].find(
      (b) => b.name === "Foo",
    )!;

    const renames: ResolvedRename[] = [
      {
        bindingId: binding.id,
        originalName: "Foo",
        newName: "Calculator",
        confidence: 0.9,
      },
    ];

    const renamed = await applyRenamesDirect(result, renames);

    expect(renamed).toContain("class Calculator");
    expect(renamed).toContain("new Calculator");
    expect(renamed).not.toContain("Foo");
  });

  test("expands object shorthand when renaming", async () => {
    const code = `
      const a = 1;
      const obj = { a };
    `;
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()].find((b) => b.name === "a")!;

    const renames: ResolvedRename[] = [
      {
        bindingId: binding.id,
        originalName: "a",
        newName: "count",
        confidence: 0.9,
      },
    ];

    const renamed = await applyRenamesDirect(result, renames);

    // Should expand shorthand to preserve object key
    expect(renamed).toContain("count");
    // The shorthand { a } should become { a: count } to preserve the key
    expect(renamed).toMatch(/\{\s*a:\s*count\s*\}/);
  });

  test("renames shadowed variables correctly", async () => {
    const code = `
      const a = 1;
      function foo() {
        const a = 2;
        return a;
      }
      console.log(a);
    `;
    const result = await analyzeSymbols(code);
    const bindings = [...result.bindings.values()].filter(
      (b) => b.name === "a",
    );

    // Sort by scope size to match the order in the test
    const sortedBindings = bindings.sort((x, y) => {
      const scopeA = result.scopes.get(x.scopeId)!;
      const scopeB = result.scopes.get(y.scopeId)!;
      return scopeB.end - scopeB.start - (scopeA.end - scopeA.start);
    });

    const renames: ResolvedRename[] = sortedBindings.map((b, i) => ({
      bindingId: b.id,
      originalName: "a",
      newName: ["outer", "inner"][i]!,
      confidence: 0.9,
    }));

    const renamed = await applyRenamesDirect(result, renames);

    expect(renamed).toContain("outer");
    expect(renamed).toContain("inner");
    // The outer 'a' should be 'outer' in console.log
    expect(renamed).toContain("console.log(outer)");
    // The inner 'a' should be 'inner' in the function
    expect(renamed).toContain("return inner");
  });

  test("handles empty renames array", async () => {
    const code = "const a = 1;";
    const result = await analyzeSymbols(code);

    const renamed = await applyRenamesDirect(result, []);

    expect(renamed).toContain("const a = 1");
  });

  test("preserves code structure", async () => {
    const code = `
      function calculate(x, y) {
        const sum = x + y;
        const product = x * y;
        return { sum, product };
      }
    `;
    const result = await analyzeSymbols(code);

    // Get all bindings
    const bindings = [...result.bindings.values()];
    const calcBinding = bindings.find((b) => b.name === "calculate")!;
    const xBinding = bindings.find((b) => b.name === "x")!;
    const yBinding = bindings.find((b) => b.name === "y")!;

    const renames: ResolvedRename[] = [
      {
        bindingId: calcBinding.id,
        originalName: "calculate",
        newName: "compute",
        confidence: 0.9,
      },
      {
        bindingId: xBinding.id,
        originalName: "x",
        newName: "first",
        confidence: 0.9,
      },
      {
        bindingId: yBinding.id,
        originalName: "y",
        newName: "second",
        confidence: 0.9,
      },
    ];

    const renamed = await applyRenamesDirect(result, renames);

    expect(renamed).toContain("function compute");
    expect(renamed).toContain("first + second");
    expect(renamed).toContain("first * second");
  });

  test("renames arrow function assigned to variable", async () => {
    const code = `
      const fn = (x) => x * 2;
      fn(5);
    `;
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()].find((b) => b.name === "fn")!;

    const renames: ResolvedRename[] = [
      {
        bindingId: binding.id,
        originalName: "fn",
        newName: "double",
        confidence: 0.9,
      },
    ];

    const renamed = await applyRenamesDirect(result, renames);

    expect(renamed).toContain("const double");
    expect(renamed).toContain("double(5)");
  });

  test("renames let variable with reassignment", async () => {
    const code = `
      let a = 1;
      a = 2;
      a++;
    `;
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()].find((b) => b.name === "a")!;

    const renames: ResolvedRename[] = [
      {
        bindingId: binding.id,
        originalName: "a",
        newName: "counter",
        confidence: 0.9,
      },
    ];

    const renamed = await applyRenamesDirect(result, renames);

    expect(renamed).toContain("let counter");
    expect(renamed).toContain("counter = 2");
    expect(renamed).toContain("counter++");
  });

  test("renames a single array destructured variable", async () => {
    const code = `
      const [a] = [1];
      console.log(a);
    `;
    const result = await analyzeSymbols(code);
    const aBinding = [...result.bindings.values()].find((b) => b.name === "a")!;

    const renames: ResolvedRename[] = [
      {
        bindingId: aBinding.id,
        originalName: "a",
        newName: "first",
        confidence: 0.9,
      },
    ];

    const renamed = await applyRenamesDirect(result, renames);

    expect(renamed).toContain("first");
    expect(renamed).toContain("console.log(first)");
  });
});

describe("applyRenames", () => {
  test("renames a simple variable", async () => {
    const code = "const a = 1;";
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()][0]!;

    const renames: ResolvedRename[] = [
      {
        bindingId: binding.id,
        originalName: "a",
        newName: "count",
        confidence: 0.9,
      },
    ];

    const renamed = await applyRenames(result, renames);

    expect(renamed).toContain("count");
    expect(renamed).not.toContain("const a");
  });
});

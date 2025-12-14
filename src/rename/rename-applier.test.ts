import { beforeEach, describe, expect, test } from "bun:test";
import { applyRenamesAndGenerate, generateCode } from "./rename-applier";
import { buildSymbolTable, resetIdCounters } from "./symbol-table";

beforeEach(() => {
  resetIdCounters();
});

describe("generateCode", () => {
  test("generates code from AST", async () => {
    const code = `const a = 1;`;
    const table = await buildSymbolTable(code);

    const generated = await generateCode(table);

    expect(generated).toContain("const");
    expect(generated).toContain("a");
    expect(generated).toContain("1");
  });

  test("preserves code semantics", async () => {
    const code = `
function add(a, b) {
  return a + b;
}
const result = add(1, 2);
    `;
    const table = await buildSymbolTable(code);

    const generated = await generateCode(table);

    expect(generated).toContain("function");
    expect(generated).toContain("add");
    expect(generated).toContain("return");
  });
});

describe("applyRenamesAndGenerate", () => {
  test("applies single rename", async () => {
    const code = `const a = 1;`;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values())[0]!;

    const decisions = [
      {
        symbolId: symbol.id,
        originalName: "a",
        newName: "count",
        confidence: 0.9,
      },
    ];

    const result = await applyRenamesAndGenerate(table, decisions);

    expect(result.code).toContain("count");
    expect(result.code).not.toContain("const a");
    expect(result.appliedRenames).toBe(1);
    expect(result.skippedRenames).toBe(0);
  });

  test("applies multiple renames", async () => {
    const code = `const a = 1; const b = 2; const c = a + b;`;
    const table = await buildSymbolTable(code);
    const symbols = Array.from(table.symbols.values());

    const decisions = [
      {
        symbolId: symbols.find((s) => s.name === "a")!.id,
        originalName: "a",
        newName: "first",
        confidence: 0.9,
      },
      {
        symbolId: symbols.find((s) => s.name === "b")!.id,
        originalName: "b",
        newName: "second",
        confidence: 0.9,
      },
      {
        symbolId: symbols.find((s) => s.name === "c")!.id,
        originalName: "c",
        newName: "sum",
        confidence: 0.9,
      },
    ];

    const result = await applyRenamesAndGenerate(table, decisions);

    expect(result.code).toContain("first");
    expect(result.code).toContain("second");
    expect(result.code).toContain("sum");
    expect(result.appliedRenames).toBe(3);
  });

  test("renames all references", async () => {
    const code = `
const a = 1;
console.log(a);
const b = a + 1;
function foo() {
  return a * 2;
}
    `;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values()).find(
      (s) => s.name === "a",
    )!;

    const decisions = [
      {
        symbolId: symbol.id,
        originalName: "a",
        newName: "value",
        confidence: 0.9,
      },
    ];

    const result = await applyRenamesAndGenerate(table, decisions);

    // Count occurrences of 'value' - should replace all 'a' references
    const valueCount = (result.code.match(/\bvalue\b/g) || []).length;
    expect(valueCount).toBeGreaterThanOrEqual(4); // Declaration + 3 references
  });

  test("handles nested scope renames", async () => {
    const code = `
const a = 1;
function foo() {
  const b = 2;
  return a + b;
}
    `;
    const table = await buildSymbolTable(code);
    const symbols = Array.from(table.symbols.values());

    const decisions = [
      {
        symbolId: symbols.find((s) => s.name === "a")!.id,
        originalName: "a",
        newName: "outer",
        confidence: 0.9,
      },
      {
        symbolId: symbols.find((s) => s.name === "b")!.id,
        originalName: "b",
        newName: "inner",
        confidence: 0.9,
      },
    ];

    const result = await applyRenamesAndGenerate(table, decisions);

    expect(result.code).toContain("outer");
    expect(result.code).toContain("inner");
    expect(result.code).toContain("outer + inner");
  });

  test("handles shadowed variables", async () => {
    const code = `
const a = 1;
function foo() {
  const a = 2;
  return a;
}
console.log(a);
    `;
    const table = await buildSymbolTable(code);
    const symbols = Array.from(table.symbols.values()).filter(
      (s) => s.name === "a",
    );

    // Rename both 'a' variables to different names
    const decisions = [
      {
        symbolId: symbols[0]!.id,
        originalName: "a",
        newName: "outer",
        confidence: 0.9,
      },
      {
        symbolId: symbols[1]!.id,
        originalName: "a",
        newName: "inner",
        confidence: 0.9,
      },
    ];

    const result = await applyRenamesAndGenerate(table, decisions);

    expect(result.code).toContain("outer");
    expect(result.code).toContain("inner");
    expect(result.appliedRenames).toBe(2);
  });

  test("handles function parameters", async () => {
    const code = `
function add(a, b) {
  return a + b;
}
    `;
    const table = await buildSymbolTable(code);
    const symbols = Array.from(table.symbols.values());

    const decisions = [
      {
        symbolId: symbols.find((s) => s.name === "a")!.id,
        originalName: "a",
        newName: "first",
        confidence: 0.9,
      },
      {
        symbolId: symbols.find((s) => s.name === "b")!.id,
        originalName: "b",
        newName: "second",
        confidence: 0.9,
      },
    ];

    const result = await applyRenamesAndGenerate(table, decisions);

    expect(result.code).toContain("first");
    expect(result.code).toContain("second");
    expect(result.code).toContain("first + second");
  });

  test("handles empty decisions", async () => {
    const code = `const a = 1;`;
    const table = await buildSymbolTable(code);

    const result = await applyRenamesAndGenerate(table, []);

    expect(result.code).toContain("const a");
    expect(result.appliedRenames).toBe(0);
  });

  test("handles class renames", async () => {
    const code = `
class Foo {
  constructor() {
    this.value = 1;
  }
}
const instance = new Foo();
    `;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values()).find(
      (s) => s.name === "Foo",
    )!;

    const decisions = [
      {
        symbolId: symbol.id,
        originalName: "Foo",
        newName: "MyClass",
        confidence: 0.9,
      },
    ];

    const result = await applyRenamesAndGenerate(table, decisions);

    expect(result.code).toContain("class MyClass");
    expect(result.code).toContain("new MyClass");
  });

  test("handles arrow function renames", async () => {
    const code = `
const add = (x, y) => x + y;
console.log(add(1, 2));
    `;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values()).find(
      (s) => s.name === "add",
    )!;

    const decisions = [
      {
        symbolId: symbol.id,
        originalName: "add",
        newName: "sum",
        confidence: 0.9,
      },
    ];

    const result = await applyRenamesAndGenerate(table, decisions);

    expect(result.code).toContain("sum =");
    expect(result.code).toContain("sum(1, 2)");
  });

  test("reports errors for invalid symbols", async () => {
    const code = `const a = 1;`;
    const table = await buildSymbolTable(code);

    const decisions = [
      {
        symbolId: "nonexistent",
        originalName: "a",
        newName: "count",
        confidence: 0.9,
      },
    ];

    const result = await applyRenamesAndGenerate(table, decisions);

    expect(result.skippedRenames).toBe(1);
    expect(result.errors.some((e) => e.includes("not found"))).toBe(true);
  });
});

import { beforeEach, describe, expect, test } from "bun:test";
import {
  buildSymbolTable,
  getAllSymbolsSortedByScope,
  getScopeChain,
  getSymbolsForScope,
  isSymbolSafeToRename,
  resetIdCounters,
} from "./symbol-table";

beforeEach(() => {
  resetIdCounters();
});

describe("buildSymbolTable", () => {
  test("parses simple variable declaration", async () => {
    const code = `const a = 1;`;
    const table = await buildSymbolTable(code);

    expect(table.symbols.size).toBe(1);
    expect(table.scopes.size).toBe(1);

    const symbol = Array.from(table.symbols.values())[0]!;
    expect(symbol.name).toBe("a");
    expect(symbol.declarationKind).toBe("const");
  });

  test("parses multiple variable declarations", async () => {
    const code = `const a = 1; let b = 2; var c = 3;`;
    const table = await buildSymbolTable(code);

    expect(table.symbols.size).toBe(3);

    const symbols = Array.from(table.symbols.values());
    expect(symbols.map((s) => s.name).sort()).toEqual(["a", "b", "c"]);
    expect(symbols.find((s) => s.name === "a")?.declarationKind).toBe("const");
    expect(symbols.find((s) => s.name === "b")?.declarationKind).toBe("let");
    expect(symbols.find((s) => s.name === "c")?.declarationKind).toBe("var");
  });

  test("parses function declarations", async () => {
    const code = `function foo() { return 1; }`;
    const table = await buildSymbolTable(code);

    expect(table.symbols.size).toBe(1);

    const symbol = Array.from(table.symbols.values())[0]!;
    expect(symbol.name).toBe("foo");
    expect(symbol.declarationKind).toBe("function");
  });

  test("parses function parameters", async () => {
    const code = `function foo(a, b) { return a + b; }`;
    const table = await buildSymbolTable(code);

    expect(table.symbols.size).toBe(3); // foo, a, b

    const symbols = Array.from(table.symbols.values());
    expect(symbols.find((s) => s.name === "a")?.declarationKind).toBe("param");
    expect(symbols.find((s) => s.name === "b")?.declarationKind).toBe("param");
  });

  test("parses class declarations", async () => {
    const code = `class Foo {}`;
    const table = await buildSymbolTable(code);

    expect(table.symbols.size).toBe(1);

    const symbol = Array.from(table.symbols.values())[0]!;
    expect(symbol.name).toBe("Foo");
    expect(symbol.declarationKind).toBe("class");
  });

  test("parses nested scopes", async () => {
    const code = `
const a = 1;
function foo() {
  const b = 2;
  function bar() {
    const c = 3;
  }
}
    `;
    const table = await buildSymbolTable(code);

    expect(table.symbols.size).toBe(5); // a, foo, b, bar, c
    expect(table.scopes.size).toBe(3); // program, foo, bar
  });

  test("detects eval in scope", async () => {
    const code = `
function foo() {
  eval("console.log('hello')");
  const a = 1;
}
    `;
    const table = await buildSymbolTable(code);

    // The program scope doesn't have eval, but foo's body does
    const symbolA = Array.from(table.symbols.values()).find(
      (s) => s.name === "a",
    );
    const aScope = table.scopes.get(symbolA?.scopeId ?? "");
    expect(aScope?.hasEval).toBe(true);
  });

  test("detects with statement in scope", async () => {
    const code = `
function foo() {
  with (obj) {
    const a = 1;
  }
}
    `;
    const table = await buildSymbolTable(code);

    const symbolA = Array.from(table.symbols.values()).find(
      (s) => s.name === "a",
    );
    // The with statement creates a new scope, so a's direct scope doesn't have it,
    // but the isSymbolSafeToRename function checks ancestor scopes
    expect(isSymbolSafeToRename(table, symbolA!.id)).toBe(false);
  });

  test("tracks references correctly", async () => {
    const code = `
const a = 1;
console.log(a);
const b = a + 1;
    `;
    const table = await buildSymbolTable(code);

    const symbolA = Array.from(table.symbols.values()).find(
      (s) => s.name === "a",
    );
    expect(symbolA?.references.length).toBeGreaterThanOrEqual(2);
  });

  test("handles shadowed variables", async () => {
    const code = `
const a = 1;
function foo() {
  const a = 2; // shadows outer a
}
    `;
    const table = await buildSymbolTable(code);

    const aSymbols = Array.from(table.symbols.values()).filter(
      (s) => s.name === "a",
    );
    expect(aSymbols.length).toBe(2);
    expect(aSymbols[0]?.scopeId).not.toBe(aSymbols[1]?.scopeId);
  });

  test("handles arrow functions", async () => {
    const code = `const add = (a, b) => a + b;`;
    const table = await buildSymbolTable(code);

    expect(table.symbols.size).toBe(3); // add, a, b
  });

  test("handles destructuring", async () => {
    const code = `const { a, b } = obj;`;
    const table = await buildSymbolTable(code);

    // Should have bindings for a and b
    const names = Array.from(table.symbols.values()).map((s) => s.name);
    expect(names).toContain("a");
    expect(names).toContain("b");
  });

  test("handles array destructuring", async () => {
    const code = `const [a, b] = arr;`;
    const table = await buildSymbolTable(code);

    // Should have bindings for a and b
    const names = Array.from(table.symbols.values()).map((s) => s.name);
    expect(names).toContain("a");
    expect(names).toContain("b");
  });

  test("handles catch clause binding", async () => {
    const code = `try { } catch (e) { console.log(e); }`;
    const table = await buildSymbolTable(code);

    const names = Array.from(table.symbols.values()).map((s) => s.name);
    expect(names).toContain("e");
  });

  test("handles empty code", async () => {
    const code = ``;
    const table = await buildSymbolTable(code);

    expect(table.symbols.size).toBe(0);
    expect(table.scopes.size).toBe(1); // Just the program scope
  });
});

describe("getAllSymbolsSortedByScope", () => {
  test("sorts symbols by scope size descending", async () => {
    const code = `
const a = 1;
function foo() {
  const b = 2;
  function bar() {
    const c = 3;
  }
}
    `;
    const table = await buildSymbolTable(code);
    const sorted = getAllSymbolsSortedByScope(table);

    // Outer scopes should come first
    const names = sorted.map((s) => s.name);
    const aIndex = names.indexOf("a");
    const bIndex = names.indexOf("b");
    const cIndex = names.indexOf("c");

    // a and foo are in program scope (largest)
    // b and bar are in foo scope
    // c is in bar scope (smallest)
    expect(aIndex).toBeLessThan(cIndex);
    expect(bIndex).toBeLessThan(cIndex);
  });
});

describe("isSymbolSafeToRename", () => {
  test("returns true for symbols without eval/with", async () => {
    const code = `const a = 1;`;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values())[0]!;

    expect(isSymbolSafeToRename(table, symbol.id)).toBe(true);
  });

  test("returns false for symbols in scope with eval", async () => {
    const code = `
function foo() {
  eval("x = 1");
  const a = 1;
}
    `;
    const table = await buildSymbolTable(code);
    const symbolA = Array.from(table.symbols.values()).find(
      (s) => s.name === "a",
    );

    expect(isSymbolSafeToRename(table, symbolA!.id)).toBe(false);
  });
});

describe("getScopeChain", () => {
  test("returns chain from inner to outer", async () => {
    const code = `
function outer() {
  function inner() {
    const a = 1;
  }
}
    `;
    const table = await buildSymbolTable(code);
    const symbolA = Array.from(table.symbols.values()).find(
      (s) => s.name === "a",
    );
    const chain = getScopeChain(table, symbolA!.scopeId);

    expect(chain.length).toBeGreaterThanOrEqual(2);
  });
});

describe("getSymbolsForScope", () => {
  test("returns symbols in a specific scope", async () => {
    const code = `
const a = 1;
function foo() {
  const b = 2;
}
    `;
    const table = await buildSymbolTable(code);
    const programSymbols = getSymbolsForScope(table, table.rootScopeId);

    const names = programSymbols.map((s) => s.name);
    expect(names).toContain("a");
    expect(names).toContain("foo");
    expect(names).not.toContain("b");
  });
});

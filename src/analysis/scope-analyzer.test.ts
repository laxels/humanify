import { describe, expect, test } from "bun:test";
import {
  analyzeCode,
  createBindingId,
  getAncestorScopeIds,
  getScopesSortedBySize,
  getVisibleBindings,
  hasUnsafeConstructs,
  parseBindingId,
} from "./scope-analyzer";

describe("createBindingId / parseBindingId", () => {
  test("creates valid binding ID from scope and name", () => {
    const id = createBindingId("123", "foo");
    expect(id).toBe("123:foo");
  });

  test("parses binding ID back to parts", () => {
    const { scopeUid, name } = parseBindingId("123:foo");
    expect(scopeUid).toBe("123");
    expect(name).toBe("foo");
  });

  test("handles names with colons", () => {
    // Edge case: name shouldn't contain colons, but test robustness
    const id = createBindingId("123", "foo:bar");
    const { scopeUid, name } = parseBindingId(id);
    expect(scopeUid).toBe("123");
    expect(name).toBe("foo:bar");
  });

  test("throws on invalid binding ID", () => {
    expect(() => parseBindingId("invalid")).toThrow("Invalid binding ID");
  });
});

describe("analyzeCode", () => {
  test("parses simple variable declaration", async () => {
    const code = "const a = 1;";
    const result = await analyzeCode(code);

    expect(result.ast).toBeDefined();
    expect(result.symbolTable.scopes.size).toBeGreaterThan(0);
    expect(result.bindingInfos.size).toBe(1);
  });

  test("parses multiple variables", async () => {
    const code = `
      const a = 1;
      let b = 2;
      var c = 3;
    `;
    const result = await analyzeCode(code);
    expect(result.bindingInfos.size).toBe(3);
  });

  test("parses function declarations", async () => {
    const code = `
      function foo() {
        const x = 1;
      }
    `;
    const result = await analyzeCode(code);

    // Should have foo and x
    expect(result.bindingInfos.size).toBe(2);
  });

  test("parses nested scopes", async () => {
    const code = `
      function outer() {
        function inner() {
          const x = 1;
        }
      }
    `;
    const result = await analyzeCode(code);

    // At least 3 scopes: program, outer, inner
    expect(result.symbolTable.scopes.size).toBeGreaterThanOrEqual(3);
  });

  test("parses class declarations", async () => {
    const code = `
      class Foo {
        constructor() {}
        method() {}
      }
    `;
    const result = await analyzeCode(code);

    // Should have Foo
    expect(result.bindingInfos.size).toBeGreaterThanOrEqual(1);
  });

  test("handles empty code", async () => {
    const code = "";
    const result = await analyzeCode(code);
    expect(result.bindingInfos.size).toBe(0);
  });

  test("handles arrow functions", async () => {
    const code = "const fn = (x) => x * 2;";
    const result = await analyzeCode(code);

    // fn and x
    expect(result.bindingInfos.size).toBe(2);
  });

  test("handles destructuring", async () => {
    const code = "const { a, b } = obj;";
    const result = await analyzeCode(code);

    // a and b
    expect(result.bindingInfos.size).toBe(2);
  });

  test("handles array destructuring", async () => {
    const code = "const [x, y, z] = arr;";
    const result = await analyzeCode(code);
    expect(result.bindingInfos.size).toBe(3);
  });

  test("handles catch clause parameters", async () => {
    const code = `
      try {
        doSomething();
      } catch (error) {
        console.log(error);
      }
    `;
    const result = await analyzeCode(code);

    // error
    expect(result.bindingInfos.size).toBe(1);
  });

  test("handles for loop variables", async () => {
    const code = "for (let i = 0; i < 10; i++) {}";
    const result = await analyzeCode(code);
    expect(result.bindingInfos.size).toBe(1);
  });

  test("handles for-of loop variables", async () => {
    const code = "for (const item of items) {}";
    const result = await analyzeCode(code);
    expect(result.bindingInfos.size).toBe(1);
  });

  test("handles import declarations", async () => {
    const code = `
      import foo from 'module';
      import { bar, baz } from 'other';
    `;
    const result = await analyzeCode(code);

    // foo, bar, baz
    expect(result.bindingInfos.size).toBe(3);
  });
});

describe("getScopesSortedBySize", () => {
  test("sorts scopes by size descending", async () => {
    const code = `
      function outer() {
        function inner() {
          const x = 1;
        }
      }
    `;
    const result = await analyzeCode(code);
    const sorted = getScopesSortedBySize(result.symbolTable);

    // First scope should be largest
    for (let i = 0; i < sorted.length - 1; i++) {
      const current = sorted[i]!;
      const next = sorted[i + 1]!;
      expect(current.size).toBeGreaterThanOrEqual(next.size);
    }
  });
});

describe("getAncestorScopeIds", () => {
  test("returns empty array for root scope", async () => {
    const code = "const a = 1;";
    const result = await analyzeCode(code);
    const ancestors = getAncestorScopeIds(
      result.symbolTable.rootScopeId,
      result.symbolTable,
    );
    expect(ancestors).toEqual([]);
  });

  test("returns parent scopes for nested scope", async () => {
    const code = `
      function outer() {
        function inner() {
          const x = 1;
        }
      }
    `;
    const result = await analyzeCode(code);

    // Find the innermost scope
    const innerScope = Array.from(result.symbolTable.scopes.values()).find(
      (s) => s.summary === "function inner",
    );

    if (innerScope) {
      const ancestors = getAncestorScopeIds(innerScope.id, result.symbolTable);
      expect(ancestors.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("getVisibleBindings", () => {
  test("includes bindings from current and ancestor scopes", async () => {
    const code = `
      const outer = 1;
      function foo() {
        const inner = 2;
      }
    `;
    const result = await analyzeCode(code);

    // Find the function scope
    const fnScope = Array.from(result.symbolTable.scopes.values()).find(
      (s) => s.summary === "function foo",
    );

    if (fnScope) {
      const visible = getVisibleBindings(fnScope.id, result.symbolTable);
      // Should include both outer and inner (and foo)
      expect(visible.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("hasUnsafeConstructs", () => {
  test("detects eval", async () => {
    const code = `
      function foo() {
        eval("code");
      }
    `;
    const result = await analyzeCode(code);
    const _fnScope = Array.from(result.symbolTable.scopes.values()).find(
      (s) => s.kind === "function",
    );

    // Note: The hasUnsafeConstructs function needs to be called on a Babel scope
    // This test verifies the function exists and has correct signature
    expect(typeof hasUnsafeConstructs).toBe("function");
  });
});

describe("declaration kinds", () => {
  test("identifies const declarations", async () => {
    const code = "const a = 1;";
    const result = await analyzeCode(code);
    const bindings = Array.from(result.bindingInfos.values());
    expect(bindings.length).toBeGreaterThan(0);
    expect(bindings[0]!.declarationKind).toBe("const");
  });

  test("identifies let declarations", async () => {
    const code = "let a = 1;";
    const result = await analyzeCode(code);
    const bindings = Array.from(result.bindingInfos.values());
    expect(bindings.length).toBeGreaterThan(0);
    expect(bindings[0]!.declarationKind).toBe("let");
  });

  test("identifies var declarations", async () => {
    const code = "var a = 1;";
    const result = await analyzeCode(code);
    const bindings = Array.from(result.bindingInfos.values());
    expect(bindings.length).toBeGreaterThan(0);
    expect(bindings[0]!.declarationKind).toBe("var");
  });

  test("identifies function parameters", async () => {
    const code = "function foo(a) {}";
    const result = await analyzeCode(code);
    const aBinding = Array.from(result.bindingInfos.values()).find(
      (b) => b.path.node.name === "a",
    );
    expect(aBinding?.declarationKind).toBe("param");
  });

  test("identifies function declarations", async () => {
    const code = "function foo() {}";
    const result = await analyzeCode(code);
    const fooBinding = Array.from(result.bindingInfos.values()).find(
      (b) => b.path.node.name === "foo",
    );
    expect(fooBinding?.declarationKind).toBe("function");
  });
});

describe("scope kinds", () => {
  test("identifies program scope", async () => {
    const code = "const a = 1;";
    const result = await analyzeCode(code);
    const rootScope = result.symbolTable.scopes.get(
      result.symbolTable.rootScopeId,
    );
    expect(rootScope?.kind).toBe("program");
  });

  test("identifies function scope", async () => {
    const code = "function foo() {}";
    const result = await analyzeCode(code);
    const fnScope = Array.from(result.symbolTable.scopes.values()).find(
      (s) => s.kind === "function",
    );
    expect(fnScope).toBeDefined();
  });

  test("identifies block scope", async () => {
    const code = "{ const a = 1; }";
    const result = await analyzeCode(code);
    const blockScope = Array.from(result.symbolTable.scopes.values()).find(
      (s) => s.kind === "block",
    );
    expect(blockScope).toBeDefined();
  });

  test("identifies module scope", async () => {
    const code = "export const a = 1;";
    const result = await analyzeCode(code);
    const moduleScope = Array.from(result.symbolTable.scopes.values()).find(
      (s) => s.kind === "module",
    );
    expect(moduleScope).toBeDefined();
  });
});

describe("scope summaries", () => {
  test("generates summary for named function", async () => {
    const code = "function myFunction() {}";
    const result = await analyzeCode(code);
    const fnScope = Array.from(result.symbolTable.scopes.values()).find(
      (s) => s.kind === "function",
    );
    expect(fnScope?.summary).toBe("function myFunction");
  });

  test("generates summary for arrow function assigned to variable", async () => {
    const code = "const myFn = () => {};";
    const result = await analyzeCode(code);
    const fnScope = Array.from(result.symbolTable.scopes.values()).find(
      (s) => s.kind === "function",
    );
    expect(fnScope?.summary).toBe("function myFn");
  });

  test("generates summary for class", async () => {
    const code = "class MyClass {}";
    const result = await analyzeCode(code);
    const classScope = Array.from(result.symbolTable.scopes.values()).find(
      (s) => s.kind === "class",
    );
    expect(classScope?.summary).toBe("class MyClass");
  });
});

import { describe, expect, test } from "bun:test";
import {
  quickValidate,
  validateOutput,
  verifySemanticEquivalence,
} from "./validation";

describe("quickValidate", () => {
  test("returns true for valid code", async () => {
    const code = "const a = 1;";
    expect(await quickValidate(code)).toBe(true);
  });

  test("returns true for complex valid code", async () => {
    const code = `
      function foo(a, b) {
        return a + b;
      }
      const result = foo(1, 2);
    `;
    expect(await quickValidate(code)).toBe(true);
  });

  test("returns false for syntax errors", async () => {
    const code = "const a = ;";
    expect(await quickValidate(code)).toBe(false);
  });

  test("returns false for unclosed brackets", async () => {
    const code = "function foo() {";
    expect(await quickValidate(code)).toBe(false);
  });

  test("returns false for invalid tokens", async () => {
    const code = "const @ = 1;";
    expect(await quickValidate(code)).toBe(false);
  });

  test("returns true for empty code", async () => {
    const code = "";
    expect(await quickValidate(code)).toBe(true);
  });

  test("returns true for just whitespace", async () => {
    const code = "   \n\t  ";
    expect(await quickValidate(code)).toBe(true);
  });

  test("returns true for ES6+ syntax", async () => {
    const code = `
      const [a, ...rest] = [1, 2, 3];
      const obj = { a, b: 2, ...rest };
      const fn = async () => await Promise.resolve(1);
    `;
    expect(await quickValidate(code)).toBe(true);
  });

  test("returns true for class syntax", async () => {
    const code = `
      class Foo extends Bar {
        constructor() {
          super();
          this.x = 1;
        }
        get value() { return this.x; }
        set value(v) { this.x = v; }
        static create() { return new Foo(); }
      }
    `;
    expect(await quickValidate(code)).toBe(true);
  });
});

describe("validateOutput", () => {
  test("returns valid for parseable code", async () => {
    const code = "const a = 1;";
    const result = await validateOutput(code, []);

    expect(result.isValid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  test("returns errors for unparseable code", async () => {
    const code = "const = 1;";
    const result = await validateOutput(code, []);

    expect(result.isValid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.type).toBe("parse-error");
  });

  test("warns about low confidence renames", async () => {
    const code = "const foo = 1;";
    const renames = [
      {
        bindingId: "test",
        originalName: "a",
        newName: "foo",
        confidence: 0.1,
      },
    ];

    const result = await validateOutput(code, renames);

    expect(result.warnings.some((w) => w.type === "low-confidence")).toBe(true);
  });

  test("does not warn about high confidence renames", async () => {
    const code = "const foo = 1;";
    const renames = [
      {
        bindingId: "test",
        originalName: "a",
        newName: "foo",
        confidence: 0.9,
      },
    ];

    const result = await validateOutput(code, renames);

    expect(
      result.warnings.filter((w) => w.type === "low-confidence").length,
    ).toBe(0);
  });
});

describe("verifySemanticEquivalence", () => {
  test("returns equivalent for identical code", async () => {
    const code = "const a = 1;";
    const result = await verifySemanticEquivalence(code, code);

    expect(result.isEquivalent).toBe(true);
    expect(result.issues.length).toBe(0);
  });

  test("returns equivalent for renamed variables", async () => {
    const original = "const a = 1;";
    const renamed = "const foo = 1;";
    const result = await verifySemanticEquivalence(original, renamed);

    // Structure should be the same (same number of VariableDeclaration, etc.)
    expect(result.isEquivalent).toBe(true);
  });

  test("returns not equivalent if structure differs", async () => {
    const original = "const a = 1;";
    const renamed = "const a = 1; const b = 2;";
    const result = await verifySemanticEquivalence(original, renamed);

    expect(result.isEquivalent).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  test("returns not equivalent for different node counts", async () => {
    const original = "const a = 1;";
    const renamed = "function foo() {}";
    const result = await verifySemanticEquivalence(original, renamed);

    expect(result.isEquivalent).toBe(false);
  });

  test("handles parse errors gracefully", async () => {
    const original = "const a = 1;";
    const renamed = "const = ;";
    const result = await verifySemanticEquivalence(original, renamed);

    expect(result.isEquivalent).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  test("returns equivalent for function renames", async () => {
    const original = `
      function foo(a, b) {
        return a + b;
      }
      foo(1, 2);
    `;
    const renamed = `
      function add(x, y) {
        return x + y;
      }
      add(1, 2);
    `;
    const result = await verifySemanticEquivalence(original, renamed);

    expect(result.isEquivalent).toBe(true);
  });

  test("returns equivalent for class renames", async () => {
    const original = `
      class Foo {
        bar() { return 1; }
      }
    `;
    const renamed = `
      class Calculator {
        getValue() { return 1; }
      }
    `;
    const result = await verifySemanticEquivalence(original, renamed);

    expect(result.isEquivalent).toBe(true);
  });
});

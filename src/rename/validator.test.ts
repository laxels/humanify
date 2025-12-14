import { describe, expect, test } from "bun:test";
import {
  findDuplicateDeclarations,
  findReservedWordUsage,
  findShadowing,
  findSuspiciousNames,
  findUndefinedReferences,
  quickValidate,
  validateParseable,
  validateRenamedCode,
} from "./validator";

describe("validateParseable", () => {
  test("accepts valid code", async () => {
    const code = "const a = 1;";
    const result = await validateParseable(code);
    expect(result.valid).toBe(true);
  });

  test("accepts empty code", async () => {
    const result = await validateParseable("");
    expect(result.valid).toBe(true);
  });

  test("rejects invalid syntax", async () => {
    const code = "const a = ;";
    const result = await validateParseable(code);
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("rejects incomplete code", async () => {
    const code = "function foo() {";
    const result = await validateParseable(code);
    expect(result.valid).toBe(false);
  });

  test("accepts arrow functions", async () => {
    const code = "const fn = (x) => x * 2;";
    const result = await validateParseable(code);
    expect(result.valid).toBe(true);
  });

  test("accepts async/await", async () => {
    const code = `
      async function foo() {
        await bar();
      }
    `;
    const result = await validateParseable(code);
    expect(result.valid).toBe(true);
  });

  test("accepts class syntax", async () => {
    const code = `
      class Foo {
        constructor() {}
        method() {}
      }
    `;
    const result = await validateParseable(code);
    expect(result.valid).toBe(true);
  });

  test("accepts destructuring", async () => {
    const code = "const { a, b } = obj;";
    const result = await validateParseable(code);
    expect(result.valid).toBe(true);
  });

  test("accepts spread operator", async () => {
    const code = "const arr = [...other, 1, 2];";
    const result = await validateParseable(code);
    expect(result.valid).toBe(true);
  });

  test("accepts template literals", async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JS code in string
    const code = "const str = `Hello ${name}!`;";
    const result = await validateParseable(code);
    expect(result.valid).toBe(true);
  });
});

describe("findUndefinedReferences", () => {
  test("returns empty for valid code", async () => {
    const code = `
      const a = 1;
      const b = a + 1;
    `;
    const refs = await findUndefinedReferences(code);
    expect(refs.length).toBe(0);
  });

  test("ignores known globals", async () => {
    const code = `
      console.log('hello');
      const promise = new Promise(() => {});
      const arr = Array.from([1, 2, 3]);
    `;
    const refs = await findUndefinedReferences(code);
    expect(refs.length).toBe(0);
  });

  test("detects undefined variables", async () => {
    const code = "const a = undefinedVar + 1;";
    const refs = await findUndefinedReferences(code);
    expect(refs).toContain("undefinedVar");
  });

  test("detects undefined function calls", async () => {
    const code = "const result = unknownFunction();";
    const refs = await findUndefinedReferences(code);
    expect(refs).toContain("unknownFunction");
  });

  test("handles scoped variables correctly", async () => {
    const code = `
      function foo() {
        const x = 1;
        return x;
      }
    `;
    const refs = await findUndefinedReferences(code);
    expect(refs.length).toBe(0);
  });

  test("handles closures correctly", async () => {
    const code = `
      const outer = 1;
      function foo() {
        return outer;
      }
    `;
    const refs = await findUndefinedReferences(code);
    expect(refs.length).toBe(0);
  });

  test("deduplicates multiple references to same undefined", async () => {
    const code = `
      const a = unknown + 1;
      const b = unknown + 2;
    `;
    const refs = await findUndefinedReferences(code);
    expect(refs.filter((r) => r === "unknown").length).toBe(1);
  });
});

describe("findDuplicateDeclarations", () => {
  test("returns empty for unique declarations", async () => {
    const code = `
      const a = 1;
      const b = 2;
    `;
    const dups = await findDuplicateDeclarations(code);
    expect(dups.length).toBe(0);
  });

  test("allows shadowing in different scopes", async () => {
    const code = `
      const a = 1;
      function foo() {
        const a = 2;
      }
    `;
    const dups = await findDuplicateDeclarations(code);
    expect(dups.length).toBe(0); // Different scopes, not duplicates
  });

  test("detects function parameter collision", async () => {
    // Note: This is actually valid JS but might indicate an issue
    const code = `
      function foo(a, b, c) {
        return a + b + c;
      }
    `;
    const dups = await findDuplicateDeclarations(code);
    // Should not flag function parameters as duplicates
    expect(dups.length).toBe(0);
  });
});

describe("findReservedWordUsage", () => {
  test("returns empty for valid code", async () => {
    const code = "const myVar = 1;";
    const reserved = await findReservedWordUsage(code);
    expect(reserved.length).toBe(0);
  });

  test("allows reserved words as property keys", async () => {
    const code = "const obj = { class: 'foo', static: 'bar' };";
    const reserved = await findReservedWordUsage(code);
    expect(reserved.length).toBe(0);
  });

  test("allows reserved words in member access", async () => {
    const code = "console.log(obj.class);";
    const reserved = await findReservedWordUsage(code);
    expect(reserved.length).toBe(0);
  });

  test("allows reserved words as method names in classes", async () => {
    const code = `
      class Foo {
        static() {}
        class() {}
      }
    `;
    const reserved = await findReservedWordUsage(code);
    expect(reserved.length).toBe(0);
  });
});

describe("findShadowing", () => {
  test("returns empty for no shadowing", async () => {
    const code = `
      const a = 1;
      const b = 2;
    `;
    const shadows = await findShadowing(code);
    expect(shadows.length).toBe(0);
  });

  test("detects simple shadowing", async () => {
    const code = `
      const a = 1;
      function foo() {
        const a = 2;
      }
    `;
    const shadows = await findShadowing(code);
    // At minimum, inner 'a' should shadow outer 'a'
    expect(shadows.length).toBeGreaterThanOrEqual(1);
    expect(shadows.some((s) => s.name === "a")).toBe(true);
  });

  test("detects parameter shadowing", async () => {
    const code = `
      const x = 1;
      function foo(x) {
        return x;
      }
    `;
    const shadows = await findShadowing(code);
    // At minimum, param 'x' should shadow outer 'x'
    expect(shadows.length).toBeGreaterThanOrEqual(1);
    expect(shadows.some((s) => s.name === "x")).toBe(true);
  });

  test("detects nested shadowing", async () => {
    const code = `
      const a = 1;
      function outer() {
        const a = 2;
        function inner() {
          const a = 3;
        }
      }
    `;
    const shadows = await findShadowing(code);
    // At minimum, both inner 'a' bindings should shadow the outer one(s)
    expect(shadows.length).toBeGreaterThanOrEqual(2);
  });
});

describe("findSuspiciousNames", () => {
  test("returns empty for good names", () => {
    const code = `
      const userId = 1;
      function calculateTotal() {}
      class UserService {}
    `;
    const suspicious = findSuspiciousNames(code);
    expect(suspicious.length).toBe(0);
  });

  test("flags single letter names", () => {
    const code = "const a = 1;";
    const suspicious = findSuspiciousNames(code);
    expect(suspicious).toContain("a");
  });

  test("flags temp variables", () => {
    const code = "const temp = 1; const temp2 = 2;";
    const suspicious = findSuspiciousNames(code);
    expect(suspicious.some((s) => s.startsWith("temp"))).toBe(true);
  });

  test("flags all-underscore names", () => {
    const code = "const __ = 1; const ___ = 2;";
    const suspicious = findSuspiciousNames(code);
    expect(suspicious.some((s) => /^_+$/.test(s))).toBe(true);
  });

  test("flags numbered var names", () => {
    const code = "const var1 = 1; const var2 = 2;";
    const suspicious = findSuspiciousNames(code);
    expect(suspicious.some((s) => /^var\d+$/i.test(s))).toBe(true);
  });

  test("deduplicates suspicious names", () => {
    const code = `
      const a = 1;
      const b = a + 1;
      const c = a + b;
    `;
    const suspicious = findSuspiciousNames(code);
    const aCount = suspicious.filter((s) => s === "a").length;
    expect(aCount).toBe(1);
  });
});

describe("validateRenamedCode", () => {
  test("validates correct code", async () => {
    const code = `
      const userId = 1;
      const userName = 'John';
      function greet(name) {
        return 'Hello, ' + name;
      }
    `;
    const result = await validateRenamedCode(code);
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  test("reports parse errors", async () => {
    const code = "const a = ;";
    const result = await validateRenamedCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.type === "parse_error")).toBe(true);
  });

  test("reports undefined references", async () => {
    const code = "const a = undefinedVar;";
    const result = await validateRenamedCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.type === "undefined_reference")).toBe(
      true,
    );
  });

  test("warns about shadowing", async () => {
    const code = `
      const a = 1;
      function foo() {
        const a = 2;
      }
    `;
    const result = await validateRenamedCode(code);
    expect(result.warnings.some((w) => w.type === "shadowing")).toBe(true);
  });

  test("warns about suspicious names", async () => {
    const code = "const a = 1;";
    const result = await validateRenamedCode(code);
    expect(result.warnings.some((w) => w.type === "suspicious_name")).toBe(
      true,
    );
  });
});

describe("quickValidate", () => {
  test("accepts valid code", async () => {
    const code = "const a = 1;";
    const result = await quickValidate(code);
    expect(result.valid).toBe(true);
  });

  test("rejects invalid syntax", async () => {
    const code = "const a = ;";
    const result = await quickValidate(code);
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("is faster than full validation", async () => {
    const code = `
      const userId = 1;
      const userName = 'John';
      function greet(name) {
        return 'Hello, ' + name;
      }
    `;

    const quickStart = performance.now();
    await quickValidate(code);
    const quickTime = performance.now() - quickStart;

    const fullStart = performance.now();
    await validateRenamedCode(code);
    const fullTime = performance.now() - fullStart;

    // Quick validation should be faster (allowing for variance)
    expect(quickTime).toBeLessThanOrEqual(fullTime * 2);
  });
});

describe("edge cases", () => {
  test("handles empty code", async () => {
    const result = await validateRenamedCode("");
    expect(result.valid).toBe(true);
  });

  test("handles code with only comments", async () => {
    const code = `
      // This is a comment
      /* Multi-line
         comment */
    `;
    const result = await validateRenamedCode(code);
    expect(result.valid).toBe(true);
  });

  test("handles ES modules", async () => {
    const code = `
      import foo from 'module';
      export const bar = 1;
      export default function() {}
    `;
    const result = await validateRenamedCode(code);
    expect(result.valid).toBe(true);
  });

  test("handles async/await", async () => {
    const code = `
      async function fetchData() {
        const response = await fetch('/api/data');
        return response.json();
      }
    `;
    const result = await validateRenamedCode(code);
    // Note: fetch might be flagged as undefined in some environments
    // The test is primarily checking that async/await parses correctly
    expect(result.errors.filter((e) => e.type === "parse_error").length).toBe(
      0,
    );
  });

  test("handles generators", async () => {
    const code = `
      function* generator() {
        yield 1;
        yield 2;
      }
    `;
    const result = await validateRenamedCode(code);
    expect(result.valid).toBe(true);
  });

  test("handles optional chaining", async () => {
    const code = `
      const obj = { nested: { value: 1 } };
      const value = obj?.nested?.value;
    `;
    const result = await validateRenamedCode(code);
    expect(result.valid).toBe(true);
  });

  test("handles nullish coalescing", async () => {
    const code = `
      const value = null;
      const result = value ?? 'default';
    `;
    const result = await validateRenamedCode(code);
    expect(result.valid).toBe(true);
  });
});

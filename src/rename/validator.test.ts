import { describe, expect, test } from "bun:test";
import { fullValidation, validateCode, validateRenamedCode } from "./validator";

describe("validateCode", () => {
  test("validates parseable code", async () => {
    const code = `const a = 1; const b = 2;`;
    const result = await validateCode(code);

    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  test("detects parse errors", async () => {
    const code = `const a = ;`; // Invalid syntax
    const result = await validateCode(code);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Parse error"))).toBe(true);
  });

  test("detects undefined references", async () => {
    const code = `console.log(undefinedVar);`;
    const result = await validateCode(code, { checkUndefinedReferences: true });

    // Should warn about undefinedVar
    expect(result.warnings.some((w) => w.includes("undefinedVar"))).toBe(true);
  });

  test("ignores common globals", async () => {
    const code = `
console.log("test");
Math.random();
JSON.parse("{}");
Array.isArray([]);
    `;
    const result = await validateCode(code, { checkUndefinedReferences: true });

    // Should not warn about console, Math, JSON, Array
    expect(result.warnings.length).toBe(0);
  });

  test("ignores member expression properties", async () => {
    const code = `
const obj = {};
obj.someProperty;
    `;
    const result = await validateCode(code, { checkUndefinedReferences: true });

    // Should not warn about someProperty since it's a property access
    expect(result.warnings.some((w) => w.includes("someProperty"))).toBe(false);
  });

  test("ignores object property keys", async () => {
    const code = `
const obj = { someKey: 1 };
    `;
    const result = await validateCode(code, { checkUndefinedReferences: true });

    // Should not warn about someKey since it's an object key
    expect(result.warnings.some((w) => w.includes("someKey"))).toBe(false);
  });

  test("handles empty code", async () => {
    const code = ``;
    const result = await validateCode(code);

    expect(result.valid).toBe(true);
  });

  test("handles complex valid code", async () => {
    const code = `
function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

class Calculator {
  add(a, b) {
    return a + b;
  }

  async fetchAndAdd(url) {
    const response = await fetch(url);
    const data = await response.json();
    return this.add(data.a, data.b);
  }
}

const calc = new Calculator();
console.log(fibonacci(10));
    `;
    const result = await validateCode(code);

    expect(result.valid).toBe(true);
  });

  test("handles arrow functions", async () => {
    const code = `
const add = (a, b) => a + b;
const multiply = (a, b) => {
  return a * b;
};
    `;
    const result = await validateCode(code);

    expect(result.valid).toBe(true);
  });

  test("handles destructuring", async () => {
    const code = `
const { a, b } = obj;
const [x, y, ...rest] = arr;
    `;
    const result = await validateCode(code, { checkUndefinedReferences: true });

    // obj and arr are undefined, should warn
    expect(result.warnings.some((w) => w.includes("obj"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("arr"))).toBe(true);
  });

  test("handles template literals", async () => {
    const code = `
const name = "World";
const greeting = \`Hello, \${name}!\`;
    `;
    const result = await validateCode(code);

    expect(result.valid).toBe(true);
  });

  test("handles async/await", async () => {
    const code = `
async function fetchData() {
  const response = await fetch('/api');
  return response.json();
}
    `;
    const result = await validateCode(code);

    expect(result.valid).toBe(true);
  });

  test("handles generators", async () => {
    const code = `
function* generator() {
  yield 1;
  yield 2;
  yield 3;
}
    `;
    const result = await validateCode(code);

    expect(result.valid).toBe(true);
  });

  test("handles ES modules", async () => {
    const code = `
export const a = 1;
export function foo() {}
export default class Bar {}
    `;
    const result = await validateCode(code);

    expect(result.valid).toBe(true);
  });
});

describe("validateRenamedCode", () => {
  test("detects significant size changes", () => {
    const original = "const a = 1;";
    const renamed = "a"; // Much smaller

    const result = validateRenamedCode(original, renamed);

    expect(result.warnings.some((w) => w.includes("size changed"))).toBe(true);
  });

  test("accepts similar size code", () => {
    const original = "const a = 1;";
    const renamed = "const count = 1;";

    const result = validateRenamedCode(original, renamed);

    expect(result.warnings.length).toBe(0);
  });
});

describe("fullValidation", () => {
  test("performs complete validation", async () => {
    const code = `
const add = (a, b) => a + b;
const result = add(1, 2);
console.log(result);
    `;

    const result = await fullValidation(code);

    expect(result.valid).toBe(true);
  });

  test("catches all validation issues", async () => {
    const code = `const a = ; // syntax error`;

    const result = await fullValidation(code);

    expect(result.valid).toBe(false);
  });
});

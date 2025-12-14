import { expect, test } from "bun:test";
import { renameSymbols } from "./rename-symbols";
import type { SuggestNames } from "./types";
import { analyzeCode } from "./symbol-analysis";
import { buildSymbolDossier } from "./symbol-dossier";

function suggestNoOp(): SuggestNames {
  return async ({ symbols }) =>
    symbols.map((s) => ({
      symbolId: s.symbolId,
      candidates: [{ name: s.originalName, confidence: 1 }],
    }));
}

function suggestFromMap(map: Record<string, string>): SuggestNames {
  return async ({ symbols }) =>
    symbols.map((s) => ({
      symbolId: s.symbolId,
      candidates: [
        { name: map[s.originalName] ?? s.originalName, confidence: 1 },
      ],
    }));
}

function suggestFromSequence(names: string[]): SuggestNames {
  let i = 0;
  return async ({ symbols }) =>
    symbols.map((s) => ({
      symbolId: s.symbolId,
      candidates: [{ name: names[i++] ?? s.originalName, confidence: 1 }],
    }));
}

test("no-op returns the same code", async () => {
  const code = `let a = 1;`;
  expect(
    await renameSymbols(code, {
      contextWindowSize: 200,
      suggestNames: suggestNoOp(),
      concurrency: 1,
    }),
  ).toBe(code);
});

test("no-op returns the same empty code", async () => {
  const code = "";
  expect(
    await renameSymbols(code, {
      contextWindowSize: 200,
      suggestNames: suggestNoOp(),
      concurrency: 1,
    }),
  ).toBe(code);
});

test("renames a simple variable", async () => {
  const code = `let a = 1;`;
  expect(
    await renameSymbols(code, {
      contextWindowSize: 200,
      suggestNames: suggestFromMap({ a: "b" }),
      concurrency: 1,
    }),
  ).toBe(`let b = 1;`);
});

test("renames variables even if they have different scopes", async () => {
  const code = `
let a = 1;
(function () {
  a = 2;
});
  `.trim();

  const expected = `
let b = 1;
(function () {
  b = 2;
});
  `.trim();

  expect(
    await renameSymbols(code, {
      contextWindowSize: 200,
      suggestNames: suggestFromMap({ a: "b" }),
      concurrency: 1,
    }),
  ).toBe(expected);
});

test("renames shadowed variables", async () => {
  const code = `
let a = 1;
(function () {
  let a = 2;
});
    `.trim();

  const expected = `
let c = 1;
(function () {
  let d = 2;
});
    `.trim();

  expect(
    await renameSymbols(code, {
      contextWindowSize: 200,
      suggestNames: suggestFromSequence(["c", "d"]),
      concurrency: 1,
    }),
  ).toBe(expected);
});

test("does not rename class methods", async () => {
  const code = `
class Foo {
  bar() {}
}
    `.trim();

  const expected = `
class _Foo {
  bar() {}
}`.trim();

  expect(
    await renameSymbols(code, {
      contextWindowSize: 200,
      suggestNames: suggestFromMap({ Foo: "_Foo" }),
      concurrency: 1,
    }),
  ).toBe(expected);
});

test("should not rename object properties", async () => {
  const code = `
let c = 2;
let a = {
  b: c
};
a.b;
  `.trim();

  const expected = `
let d = 2;
let e = {
  b: d
};
e.b;
  `.trim();

  expect(
    await renameSymbols(code, {
      contextWindowSize: 200,
      suggestNames: suggestFromMap({ c: "d", a: "e" }),
      concurrency: 1,
    }),
  ).toBe(expected);
});

test("should handle invalid identifiers", async () => {
  const code = `let a = 1`;
  const result = await renameSymbols(code, {
    contextWindowSize: 200,
    suggestNames: suggestFromMap({ a: "this.kLength" }),
    concurrency: 1,
  });
  expect(result).toBe("let thisKLength = 1;");
});

test("should handle space in identifier name", async () => {
  const code = `let a = 1`;
  const result = await renameSymbols(code, {
    contextWindowSize: 200,
    suggestNames: suggestFromMap({ a: "foo bar" }),
    concurrency: 1,
  });
  expect(result).toBe("let fooBar = 1;");
});

test("should handle reserved identifiers", async () => {
  const code = `let a = 1`;
  const result = await renameSymbols(code, {
    contextWindowSize: 200,
    suggestNames: suggestFromMap({ a: "static" }),
    concurrency: 1,
  });
  expect(result).toBe("let _static = 1;");
});

test("should handle multiple identifiers named the same (collision resolution is per-scope)", async () => {
  const code = `
let a = 1;
let b = 1;
`.trim();

  const result = await renameSymbols(code, {
    contextWindowSize: 200,
    suggestNames: suggestFromMap({ a: "foo", b: "foo" }),
    concurrency: 1,
  });

  expect(result).toBe(
    `
let foo = 1;
let _foo = 1;
`.trim(),
  );
});

test("should handle collisions against existing bindings", async () => {
  const code = `
let foo = 1;
let bar = 2;
`.trim();

  const result = await renameSymbols(code, {
    contextWindowSize: 200,
    suggestNames: suggestFromMap({ foo: "bar", bar: "bar" }),
    concurrency: 1,
  });

  expect(result).toBe(
    `
let _bar = 1;
let bar = 2;
`.trim(),
  );
});

test("per-scope constraints allow the same chosen name in different nested scopes", async () => {
  const code = `
function outer() {
  let a = 1;
  function inner() {
    let b = 2;
  }
}
`.trim();

  const result = await renameSymbols(code, {
    contextWindowSize: 400,
    suggestNames: suggestFromMap({ a: "value", b: "value" }),
    concurrency: 1,
  });

  expect(result).toBe(
    `
function outer() {
  let value = 1;
  function inner() {
    let value = 2;
  }
}
`.trim(),
  );
});

test("expands object shorthand in ObjectExpression when renaming", async () => {
  const code = `
let a = 1;
const obj = { a };
`.trim();

  const result = await renameSymbols(code, {
    contextWindowSize: 200,
    suggestNames: suggestFromMap({ a: "userId" }),
    concurrency: 1,
  });

  expect(result).toBe(
    `
let userId = 1;
const obj = {
  a: userId
};
`.trim(),
  );
});

test("expands object shorthand in ObjectPattern when renaming", async () => {
  const code = `
const { a } = obj;
`.trim();

  const result = await renameSymbols(code, {
    contextWindowSize: 200,
    suggestNames: suggestFromMap({ a: "userId" }),
    concurrency: 1,
  });

  expect(result).toBe(
    `
const {
  a: userId
} = obj;
`.trim(),
  );
});

test("preserves named export interface for exported function declarations", async () => {
  const code = `
export function a() {
  return 1;
}
`.trim();

  const result = await renameSymbols(code, {
    contextWindowSize: 400,
    suggestNames: suggestFromMap({ a: "getValue" }),
    concurrency: 1,
  });

  expect(result).toBe(
    `
function getValue() {
  return 1;
}
export { getValue as a };
`.trim(),
  );
});

test("preserves named export interface for exported const declarations", async () => {
  const code = `
export const a = 1;
`.trim();

  const result = await renameSymbols(code, {
    contextWindowSize: 200,
    suggestNames: suggestFromMap({ a: "maxRetries" }),
    concurrency: 1,
  });

  // `a` is a top-level primitive const: nameStyle enforces UPPER_SNAKE.
  expect(result).toBe(
    `
const MAX_RETRIES = 1;
export { MAX_RETRIES as a };
`.trim(),
  );
});

test("keeps export specifier exported name stable (export { a } should become export { value as a })", async () => {
  const code = `
const a = 1;
export { a };
`.trim();

  const result = await renameSymbols(code, {
    contextWindowSize: 200,
    suggestNames: suggestFromMap({ a: "value" }),
    concurrency: 1,
  });

  expect(result).toBe(
    `
const value = 1;
export {
  value as a
};
`.trim(),
  );
});

test("renaming an imported local keeps imported name stable (import { a } => import { a as value })", async () => {
  const code = `
import { a } from "x";
console.log(a);
`.trim();

  const result = await renameSymbols(code, {
    contextWindowSize: 200,
    suggestNames: suggestFromMap({ a: "value" }),
    concurrency: 1,
  });

  expect(result).toBe(
    `
import { a as value } from "x";
console.log(value);
`.trim(),
  );
});

test("skips renaming in unsafe scopes (direct eval)", async () => {
  const code = `
function foo() {
  let a = 1;
  eval("a");
  return a;
}
`.trim();

  const result = await renameSymbols(code, {
    contextWindowSize: 400,
    suggestNames: suggestFromMap({ a: "value", foo: "doThing" }),
    concurrency: 1,
  });

  // When global eval is present, renaming is conservatively disabled in reachable scopes.
  expect(result).toBe(code);
});

test("symbol dossiers include useful usage signals (array-like hint)", async () => {
  const code = `
function foo(arr, cb) {
  return arr.map(cb).filter(cb);
}
`.trim();

  const analyzed = await analyzeCode(code);
  const arrSymbol = analyzed.symbols.find((s) => s.originalName === "arr");
  expect(arrSymbol).toBeTruthy();

  const dossier = buildSymbolDossier(arrSymbol!, { contextWindowSize: 400 });
  expect(dossier.usageSummary.calledMethods).toEqual(["filter", "map"]);
  expect(dossier.typeHints.some((h) => h.includes("array-like"))).toBe(true);
});
import { expect, test } from "bun:test";
import { renameIdentifiersWithProvider } from "./rename-engine";
import type { NameSuggestionProvider, SymbolDossier } from "./types";

function makeProvider(
  fn: (originalName: string, dossier: SymbolDossier) => string | string[],
): NameSuggestionProvider {
  return async ({ dossiers }) => {
    return {
      suggestions: dossiers.map((d) => {
        const names = fn(d.originalName, d);
        const arr = Array.isArray(names) ? names : [names];
        return {
          id: d.id,
          candidates: arr.map((name, i) => ({
            name,
            confidence: Math.max(0, 1 - i * 0.1),
            rationale: "test",
          })),
        };
      }),
    };
  };
}

test("no-op returns the same code", async () => {
  const code = `const a = 1;`;
  const provider = makeProvider((name) => name);
  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 200 },
    provider,
  );
  expect(result.trim()).toBe(code.trim());
});

test("no-op returns the same empty code", async () => {
  const code = "";
  const provider = makeProvider((name) => name);
  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 200 },
    provider,
  );
  expect(result.trim()).toBe(code.trim());
});

test("renames a simple variable", async () => {
  const code = `const a = 1;`;
  const provider = makeProvider((name) => (name === "a" ? "b" : name));
  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 200 },
    provider,
  );
  expect(result.trim()).toBe(`const b = 1;`);
});

test("renames variables even if they have different scopes", async () => {
  const code = `
const a = 1;
(function () {
  a = 2;
});
  `.trim();
  const expected = `
const b = 1;
(function () {
  b = 2;
});
  `.trim();

  const provider = makeProvider((name) => (name === "a" ? "b" : name));
  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 200 },
    provider,
  );
  expect(result.trim()).toBe(expected.trim());
});

test("renames shadowed variables", async () => {
  const code = `
const a = 1;
(function () {
  const a = 2;
});
    `.trim();

  const provider = makeProvider((name, dossier) => {
    if (name !== "a") return name;
    // Differentiate the two bindings by the declaration snippet.
    if (dossier.declarationSnippet.includes("const a = 1")) return "c";
    return "d";
  });

  const expected = `
const c = 1;
(function () {
  const d = 2;
});
    `.trim();

  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 200 },
    provider,
  );

  expect(result.trim()).toBe(expected.trim());
});

test(`does not rename class methods`, async () => {
  const code = `
class Foo {
  bar() {}
}
    `.trim();

  const provider = makeProvider((name) => "_" + name);

  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 200 },
    provider,
  );

  expect(result.trim()).toBe(
    `
class _Foo {
  bar() {}
}`.trim(),
  );
});

test("should not rename object properties", async () => {
  const code = `
const c = 2;
const a = {
  b: c
};
a.b;
  `.trim();

  const provider = makeProvider((name) => {
    if (name === "c") return "d";
    if (name === "a") return "e";
    return name;
  });

  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 200 },
    provider,
  );

  expect(result.trim()).toBe(
    `
const d = 2;
const e = {
  b: d
};
e.b;
  `.trim(),
  );
});

test("should handle invalid identifiers", async () => {
  const code = `const a = 1`;
  const provider = makeProvider((name) =>
    name === "a" ? "this.kLength" : name,
  );
  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 200 },
    provider,
  );
  expect(result.trim()).toBe("const thisKLength = 1;");
});

test("should handle space in identifier name", async () => {
  const code = `const a = 1`;
  const provider = makeProvider((name) => (name === "a" ? "foo bar" : name));
  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 200 },
    provider,
  );
  expect(result.trim()).toBe("const fooBar = 1;");
});

test("should handle reserved identifiers", async () => {
  const code = `const a = 1`;
  const provider = makeProvider((name) => (name === "a" ? "static" : name));
  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 200 },
    provider,
  );
  expect(result.trim()).toBe("const _static = 1;");
});

test("should handle multiple identifiers renamed to the same name", async () => {
  const code = `
const a = 1;
const b = 1;
`.trim();

  const provider = makeProvider(() => "foo");
  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 200 },
    provider,
  );

  expect(result.trim()).toBe(
    `
const foo = 1;
const foo2 = 1;
`.trim(),
  );
});

test("should avoid colliding with existing identifiers", async () => {
  const code = `
const foo = 1;
const bar = 2;
`.trim();

  const provider = makeProvider((name) => (name === "foo" ? "bar" : name));
  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 200 },
    provider,
  );

  expect(result.trim()).toBe(
    `
const bar2 = 1;
const bar = 2;
`.trim(),
  );
});

test("should not crash on assigning to 'arguments'", async () => {
  const code = `
function foo() {
  arguments = '??';
}
`.trim();

  const provider = makeProvider((name) => (name === "foo" ? "foobar" : name));
  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 200 },
    provider,
  );

  expect(result.trim()).toBe(
    `
function foobar() {
  arguments = '??';
}
    `.trim(),
  );
});

test("preserves object literal shorthand keys when renaming", async () => {
  const code = `
const a = 1;
const obj = { a };
obj.a;
`.trim();

  const provider = makeProvider((name) => (name === "a" ? "userId" : name));
  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 400 },
    provider,
  );

  expect(result).toContain(`const userId = 1;`);
  expect(result).toContain(`const obj = { a: userId };`);
  expect(result).toContain(`obj.a;`);
});

test("preserves object pattern shorthand keys when renaming", async () => {
  const code = `
const obj = { a: 1 };
const { a } = obj;
`.trim();

  const provider = makeProvider((name) => (name === "a" ? "value" : name));
  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 400 },
    provider,
  );

  expect(result).toContain(`const { a: value } = obj;`);
});

test("preserves named export names when renaming export declarations", async () => {
  const code = `
export function a() {
  return 1;
}
`.trim();

  const provider = makeProvider((name) => (name === "a" ? "getOne" : name));
  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 400 },
    provider,
  );

  expect(result).toContain(`function getOne() {`);
  expect(result).toContain(`export { getOne as a };`);
});

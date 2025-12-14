import { expect, test } from "bun:test";
import { renameIdentifiersWithProvider } from "./rename-identifiers";

test("no-op returns the same code", async () => {
  const code = `const a = 1;`;
  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 500 },
    async ({ dossiers }) => {
      return dossiers.map((d) => ({
        id: d.id,
        candidates: [{ name: d.originalName, confidence: 1 }],
      }));
    },
  );
  expect(result).toBe(code);
});

test("no-op returns the same empty code", async () => {
  const code = "";
  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 500 },
    async () => [],
  );
  expect(result).toBe(code);
});

test("renames a simple variable", async () => {
  const code = `const a = 1;`;
  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 500 },
    async ({ dossiers }) => {
      return dossiers.map((d) => ({
        id: d.id,
        candidates: [{ name: d.originalName === "a" ? "b" : d.originalName, confidence: 1 }],
      }));
    },
  );
  expect(result).toBe(`const b = 1;`);
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

  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 800 },
    async ({ dossiers }) => {
      return dossiers.map((d) => ({
        id: d.id,
        candidates: [{ name: d.originalName === "a" ? "b" : d.originalName, confidence: 1 }],
      }));
    },
  );

  expect(result).toBe(expected);
});

test("renames two scopes", async () => {
  const code = `
const a = 1;
(function () {
  const b = 2;
});
  `.trim();

  const expected = `
const c = 1;
(function () {
  const d = 2;
});
  `.trim();

  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 800 },
    async ({ dossiers }) => {
      return dossiers.map((d) => ({
        id: d.id,
        candidates: [
          {
            name:
              d.originalName === "a" ? "c" : d.originalName === "b" ? "d" : d.originalName,
            confidence: 1,
          },
        ],
      }));
    },
  );

  expect(result).toBe(expected);
});

test("renames shadowed variables", async () => {
  const code = `
const a = 1;
(function () {
  const a = 2;
});
    `.trim();

  const expected = `
const c = 1;
(function () {
  const d = 2;
});
    `.trim();

  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 800 },
    async ({ dossiers }) => {
      return dossiers.map((d) => {
        // Disambiguate shadowed `a` bindings by declaration context.
        if (d.originalName === "a" && d.declaration.includes("= 1")) {
          return { id: d.id, candidates: [{ name: "c", confidence: 1 }] };
        }
        if (d.originalName === "a" && d.declaration.includes("= 2")) {
          return { id: d.id, candidates: [{ name: "d", confidence: 1 }] };
        }
        return { id: d.id, candidates: [{ name: d.originalName, confidence: 1 }] };
      });
    },
  );

  expect(result).toBe(expected);
});

test(`does not rename class methods`, async () => {
  const code = `
class Foo {
  bar() {}
}
    `.trim();

  const expected = `
class _Foo {
  bar() {}
}`.trim();

  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 800 },
    async ({ dossiers }) => {
      return dossiers.map((d) => ({
        id: d.id,
        candidates: [{ name: `_${d.originalName}`, confidence: 1 }],
      }));
    },
  );

  expect(result).toBe(expected);
});

test("should not rename object properties", async () => {
  const code = `
const c = 2;
const a = {
  b: c
};
a.b;
  `.trim();

  const expected = `
const d = 2;
const e = {
  b: d
};
e.b;
  `.trim();

  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 800 },
    async ({ dossiers }) => {
      return dossiers.map((d) => {
        if (d.originalName === "c") return { id: d.id, candidates: [{ name: "d", confidence: 1 }] };
        if (d.originalName === "a") return { id: d.id, candidates: [{ name: "e", confidence: 1 }] };
        return { id: d.id, candidates: [{ name: d.originalName, confidence: 1 }] };
      });
    },
  );

  expect(result).toBe(expected);
});

test("preserves object literal shorthand keys when renaming", async () => {
  const code = `
const a = 1;
const obj = {
  a
};
obj.a;
  `.trim();

  const expected = `
const userId = 1;
const obj = {
  a: userId
};
obj.a;
  `.trim();

  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 800 },
    async ({ dossiers }) => {
      return dossiers.map((d) => ({
        id: d.id,
        candidates: [{ name: d.originalName === "a" ? "userId" : d.originalName, confidence: 1 }],
      }));
    },
  );

  expect(result).toBe(expected);
});

test("preserves destructuring shorthand keys when renaming", async () => {
  const code = `
const obj = { a: 1 };
const { a } = obj;
a;
  `.trim();

  const expected = `
const obj = {
  a: 1
};
const {
  a: userId
} = obj;
userId;
  `.trim();

  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 1000 },
    async ({ dossiers }) => {
      return dossiers.map((d) => ({
        id: d.id,
        candidates: [{ name: d.originalName === "a" ? "userId" : d.originalName, confidence: 1 }],
      }));
    },
  );

  expect(result).toBe(expected);
});

test("should handle invalid identifiers", async () => {
  const code = `const a = 1`;
  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 500 },
    async ({ dossiers }) => {
      return dossiers.map((d) => ({
        id: d.id,
        candidates: [{ name: "this.kLength", confidence: 1 }],
      }));
    },
  );
  expect(result).toBe("const thisKLength = 1;");
});

test("should handle space in identifier name", async () => {
  const code = `const a = 1`;
  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 500 },
    async ({ dossiers }) => {
      return dossiers.map((d) => ({
        id: d.id,
        candidates: [{ name: "foo bar", confidence: 1 }],
      }));
    },
  );
  expect(result).toBe("const fooBar = 1;");
});

test("should handle reserved identifiers", async () => {
  const code = `const a = 1`;
  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 500 },
    async ({ dossiers }) => {
      return dossiers.map((d) => ({
        id: d.id,
        candidates: [{ name: "static", confidence: 1 }],
      }));
    },
  );
  expect(result).toBe("const _static = 1;");
});

test("should handle multiple identifiers named the same", async () => {
  const code = `
const a = 1;
const b = 1;
`.trim();

  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 600 },
    async ({ dossiers }) => {
      return dossiers.map((d) => ({
        id: d.id,
        candidates: [{ name: "foo", confidence: 1 }],
      }));
    },
  );

  expect(result).toBe(
    `
const foo = 1;
const _foo = 1;
`.trim(),
  );
});

test("should handle multiple properties with the same name", async () => {
  const code = `
const foo = 1;
const bar = 2;
`.trim();

  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 600 },
    async ({ dossiers }) => {
      // Suggest "bar" for both bindings; solver should keep the symbol already named "bar"
      // and rename the other to avoid collision.
      return dossiers.map((d) => ({
        id: d.id,
        candidates: [{ name: "bar", confidence: 1 }],
      }));
    },
  );

  expect(result).toBe(
    `
const _bar = 1;
const bar = 2;
`.trim(),
  );
});

test("should not crash on 'arguments' assigning", async () => {
  const code = `
function foo() {
  arguments = '??';
}
`.trim();

  const result = await renameIdentifiersWithProvider(
    code,
    { contextWindowSize: 800 },
    async ({ dossiers }) => {
      return dossiers.map((d) => ({
        id: d.id,
        candidates: [{ name: d.originalName === "foo" ? "foobar" : d.originalName, confidence: 1 }],
      }));
    },
  );

  expect(result).toBe(
    `
function foobar() {
  arguments = '??';
}
    `.trim(),
  );
});

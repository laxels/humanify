import { describe, expect, test } from "bun:test";
import { analyzeCode } from "../analysis/scope-analyzer";
import { extractSymbolDossiers } from "../analysis/symbol-dossier";
import type {
  BatchRenameResult,
  NameCandidate,
  SymbolDossier,
} from "../analysis/types";
import {
  applyNamingConventions,
  DEFAULT_CONVENTIONS,
  getConflictingNames,
  isValidIdentifier,
  makeValidIdentifier,
  RESERVED_WORDS,
  resolveConflict,
  selectBestCandidate,
  solveConstraints,
  toCamelCase,
  toPascalCase,
  toUpperSnakeCase,
  validateRenames,
} from "./constraint-solver";

describe("isValidIdentifier", () => {
  test("accepts valid identifiers", () => {
    expect(isValidIdentifier("foo")).toBe(true);
    expect(isValidIdentifier("_foo")).toBe(true);
    expect(isValidIdentifier("$foo")).toBe(true);
    expect(isValidIdentifier("foo123")).toBe(true);
    expect(isValidIdentifier("myVariable")).toBe(true);
    expect(isValidIdentifier("MY_CONSTANT")).toBe(true);
  });

  test("rejects empty string", () => {
    expect(isValidIdentifier("")).toBe(false);
  });

  test("rejects reserved words", () => {
    expect(isValidIdentifier("const")).toBe(false);
    expect(isValidIdentifier("let")).toBe(false);
    expect(isValidIdentifier("function")).toBe(false);
    expect(isValidIdentifier("class")).toBe(false);
    expect(isValidIdentifier("return")).toBe(false);
  });

  test("rejects identifiers starting with numbers", () => {
    expect(isValidIdentifier("123foo")).toBe(false);
  });

  test("rejects identifiers with special characters", () => {
    expect(isValidIdentifier("foo-bar")).toBe(false);
    expect(isValidIdentifier("foo.bar")).toBe(false);
    expect(isValidIdentifier("foo bar")).toBe(false);
  });
});

describe("makeValidIdentifier", () => {
  test("returns valid identifiers unchanged", () => {
    expect(makeValidIdentifier("foo")).toBe("foo");
    expect(makeValidIdentifier("myVariable")).toBe("myVariable");
  });

  test("handles reserved words by prefixing", () => {
    expect(makeValidIdentifier("const")).toBe("_const");
    expect(makeValidIdentifier("class")).toBe("_class");
  });

  test("converts spaces to camelCase", () => {
    expect(makeValidIdentifier("foo bar")).toBe("fooBar");
  });

  test("handles dots", () => {
    const result = makeValidIdentifier("this.kLength");
    expect(isValidIdentifier(result)).toBe(true);
  });

  test("handles empty string", () => {
    expect(makeValidIdentifier("")).toBe("unnamed");
  });

  test("handles whitespace-only string", () => {
    expect(makeValidIdentifier("   ")).toBe("unnamed");
  });
});

describe("case conversion functions", () => {
  describe("toPascalCase", () => {
    test("converts camelCase", () => {
      expect(toPascalCase("myVariable")).toBe("MyVariable");
    });

    test("converts snake_case", () => {
      expect(toPascalCase("my_variable")).toBe("MyVariable");
    });

    test("converts kebab-case", () => {
      expect(toPascalCase("my-variable")).toBe("MyVariable");
    });

    test("converts space-separated", () => {
      expect(toPascalCase("my variable")).toBe("MyVariable");
    });

    test("handles single word", () => {
      expect(toPascalCase("foo")).toBe("Foo");
    });
  });

  describe("toCamelCase", () => {
    test("converts PascalCase", () => {
      expect(toCamelCase("MyVariable")).toBe("myVariable");
    });

    test("converts snake_case", () => {
      expect(toCamelCase("my_variable")).toBe("myVariable");
    });

    test("handles single word", () => {
      expect(toCamelCase("Foo")).toBe("foo");
    });
  });

  describe("toUpperSnakeCase", () => {
    test("converts camelCase", () => {
      expect(toUpperSnakeCase("myVariable")).toBe("MY_VARIABLE");
    });

    test("converts PascalCase", () => {
      expect(toUpperSnakeCase("MyVariable")).toBe("MY_VARIABLE");
    });

    test("handles already uppercase", () => {
      expect(toUpperSnakeCase("MY_VARIABLE")).toBe("MY_VARIABLE");
    });
  });
});

describe("resolveConflict", () => {
  test("returns name unchanged if no conflict", () => {
    const used = new Set(["other", "names"]);
    expect(resolveConflict("foo", used)).toBe("foo");
  });

  test("adds underscore prefix for first conflict", () => {
    const used = new Set(["foo"]);
    expect(resolveConflict("foo", used)).toBe("_foo");
  });

  test("adds number suffix for multiple conflicts", () => {
    const used = new Set(["foo", "_foo"]);
    const result = resolveConflict("foo", used);
    expect(result).toBe("foo2");
  });

  test("increments number until unique", () => {
    const used = new Set(["foo", "_foo", "foo2", "foo3"]);
    const result = resolveConflict("foo", used);
    expect(result).toBe("foo4");
  });
});

describe("applyNamingConventions", () => {
  const createMockDossier = (kind: string): SymbolDossier => ({
    id: "test:foo",
    originalName: "foo",
    declarationKind: kind as any,
    declarationContext: "",
    useSites: [],
    typeHints: {
      methodsCalled: [],
      propertiesAccessed: [],
      isCalledAsFunction: false,
      isConstructed: false,
      isAwaited: false,
      hasTypeofCheck: false,
      hasInstanceofCheck: false,
    },
    scopeId: "test",
    isExported: false,
    isUnsafe: false,
  });

  test("applies PascalCase for classes", () => {
    const dossier = createMockDossier("class");
    const result = applyNamingConventions(
      "myClass",
      dossier,
      DEFAULT_CONVENTIONS,
    );
    expect(result).toBe("MyClass");
  });

  test("doesn't force camelCase on already valid names", () => {
    const dossier = createMockDossier("const");
    const result = applyNamingConventions(
      "myVariable",
      dossier,
      DEFAULT_CONVENTIONS,
    );
    expect(result).toBe("myVariable");
  });
});

describe("selectBestCandidate", () => {
  const createMockDossier = (): SymbolDossier => ({
    id: "test:foo",
    originalName: "foo",
    declarationKind: "const",
    declarationContext: "",
    useSites: [],
    typeHints: {
      methodsCalled: [],
      propertiesAccessed: [],
      isCalledAsFunction: false,
      isConstructed: false,
      isAwaited: false,
      hasTypeofCheck: false,
      hasInstanceofCheck: false,
    },
    scopeId: "test",
    isExported: false,
    isUnsafe: false,
  });

  test("selects highest confidence candidate", () => {
    const candidates: NameCandidate[] = [
      { name: "low", confidence: 0.3, rationale: "" },
      { name: "high", confidence: 0.9, rationale: "" },
      { name: "medium", confidence: 0.5, rationale: "" },
    ];
    const { name } = selectBestCandidate(
      candidates,
      createMockDossier(),
      new Set(),
    );
    expect(name).toBe("high");
  });

  test("skips conflicting names", () => {
    const candidates: NameCandidate[] = [
      { name: "taken", confidence: 0.9, rationale: "" },
      { name: "available", confidence: 0.7, rationale: "" },
    ];
    const { name } = selectBestCandidate(
      candidates,
      createMockDossier(),
      new Set(["taken"]),
    );
    expect(name).toBe("available");
  });

  test("resolves conflict for all candidates taken", () => {
    const candidates: NameCandidate[] = [
      { name: "taken", confidence: 0.9, rationale: "" },
    ];
    const { name } = selectBestCandidate(
      candidates,
      createMockDossier(),
      new Set(["taken"]),
    );
    expect(name).toBe("_taken");
  });

  test("falls back to original name when no candidates", () => {
    const dossier = createMockDossier();
    const { name } = selectBestCandidate([], dossier, new Set());
    expect(name).toBe("foo");
  });

  test("fixes invalid identifiers", () => {
    const candidates: NameCandidate[] = [
      { name: "this.length", confidence: 0.9, rationale: "" },
    ];
    const { name } = selectBestCandidate(
      candidates,
      createMockDossier(),
      new Set(),
    );
    expect(isValidIdentifier(name)).toBe(true);
  });
});

describe("getConflictingNames", () => {
  test("returns empty set for simple case", async () => {
    const code = "const a = 1;";
    const result = await analyzeCode(code);
    extractSymbolDossiers(result.ast, result);

    const bindingId = Array.from(result.bindingInfos.keys())[0]!;
    const conflicting = getConflictingNames(
      bindingId,
      result.symbolTable,
      new Map(),
    );

    // No other bindings, so no conflicts
    expect(conflicting.size).toBe(0);
  });

  test("includes sibling bindings in same scope", async () => {
    const code = `
      const a = 1;
      const b = 2;
    `;
    const result = await analyzeCode(code);
    extractSymbolDossiers(result.ast, result);

    const aId = Array.from(result.bindingInfos.keys()).find((id) =>
      id.endsWith(":a"),
    )!;
    const conflicting = getConflictingNames(aId, result.symbolTable, new Map());

    expect(conflicting.has("b")).toBe(true);
  });

  test("includes parent scope bindings", async () => {
    const code = `
      const outer = 1;
      function foo() {
        const inner = 2;
      }
    `;
    const result = await analyzeCode(code);
    extractSymbolDossiers(result.ast, result);

    const innerId = Array.from(result.bindingInfos.keys()).find((id) =>
      id.endsWith(":inner"),
    )!;
    const conflicting = getConflictingNames(
      innerId,
      result.symbolTable,
      new Map(),
    );

    expect(conflicting.has("outer")).toBe(true);
    expect(conflicting.has("foo")).toBe(true);
  });

  test("uses resolved names when available", async () => {
    const code = `
      const a = 1;
      const b = 2;
    `;
    const result = await analyzeCode(code);
    extractSymbolDossiers(result.ast, result);

    const aId = Array.from(result.bindingInfos.keys()).find((id) =>
      id.endsWith(":a"),
    )!;
    const bId = Array.from(result.bindingInfos.keys()).find((id) =>
      id.endsWith(":b"),
    )!;

    // Pretend b was already resolved to "renamed"
    const resolved = new Map([[bId, "renamed"]]);
    const conflicting = getConflictingNames(aId, result.symbolTable, resolved);

    expect(conflicting.has("renamed")).toBe(true);
    expect(conflicting.has("b")).toBe(false);
  });
});

describe("solveConstraints", () => {
  test("handles empty input", async () => {
    const code = "";
    const result = await analyzeCode(code);
    extractSymbolDossiers(result.ast, result);

    const renameResults: BatchRenameResult = { renames: [] };
    const resolved = solveConstraints(result.symbolTable, renameResults);

    expect(resolved).toEqual([]);
  });

  test("applies renames from candidates", async () => {
    const code = "const a = 1;";
    const result = await analyzeCode(code);
    extractSymbolDossiers(result.ast, result);

    const bindingIds = Array.from(result.symbolTable.bindings.keys());
    expect(bindingIds.length).toBeGreaterThan(0);
    const bindingId = bindingIds[0]!;
    const renameResults: BatchRenameResult = {
      renames: [
        {
          bindingId,
          candidates: [{ name: "myVariable", confidence: 0.9, rationale: "" }],
        },
      ],
    };

    const resolved = solveConstraints(result.symbolTable, renameResults);

    expect(resolved.length).toBe(1);
    expect(resolved[0]!.newName).toBe("myVariable");
  });

  test("resolves conflicts between candidates", async () => {
    const code = `
      const a = 1;
      const b = 2;
    `;
    const result = await analyzeCode(code);
    extractSymbolDossiers(result.ast, result);

    const ids = Array.from(result.symbolTable.bindings.keys());
    const renameResults: BatchRenameResult = {
      renames: ids.map((id) => ({
        bindingId: id,
        candidates: [{ name: "sameName", confidence: 0.9, rationale: "" }],
      })),
    };

    const resolved = solveConstraints(result.symbolTable, renameResults);

    // Should have unique names
    const names = resolved.map((r) => r.newName);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  test("keeps original name when no candidates", async () => {
    const code = "const myVar = 1;";
    const result = await analyzeCode(code);
    extractSymbolDossiers(result.ast, result);

    const bindingIds = Array.from(result.symbolTable.bindings.keys());
    expect(bindingIds.length).toBeGreaterThan(0);
    const bindingId = bindingIds[0]!;
    const renameResults: BatchRenameResult = {
      renames: [{ bindingId, candidates: [] }],
    };

    const resolved = solveConstraints(result.symbolTable, renameResults);

    expect(resolved[0]!.newName).toBe("myVar");
  });

  test("respects minimum confidence threshold", async () => {
    const code = "const a = 1;";
    const result = await analyzeCode(code);
    extractSymbolDossiers(result.ast, result);

    const bindingIds = Array.from(result.symbolTable.bindings.keys());
    expect(bindingIds.length).toBeGreaterThan(0);
    const bindingId = bindingIds[0]!;
    const renameResults: BatchRenameResult = {
      renames: [
        {
          bindingId,
          candidates: [{ name: "myVariable", confidence: 0.3, rationale: "" }],
        },
      ],
    };

    const resolved = solveConstraints(result.symbolTable, renameResults, {
      minConfidence: 0.5,
    });

    expect(resolved[0]!.newName).toBe("a"); // Original name
  });

  test("processes scopes in correct order", async () => {
    const code = `
      const outer = 1;
      function foo() {
        const inner = outer + 1;
      }
    `;
    const result = await analyzeCode(code);
    extractSymbolDossiers(result.ast, result);

    const ids = Array.from(result.symbolTable.bindings.keys());
    const renameResults: BatchRenameResult = {
      renames: ids.map((id) => ({
        bindingId: id,
        candidates: [{ name: "renamed", confidence: 0.9, rationale: "" }],
      })),
    };

    const resolved = solveConstraints(result.symbolTable, renameResults);

    // All should have unique names
    const names = resolved.map((r) => r.newName);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });
});

describe("validateRenames", () => {
  test("passes for valid renames", async () => {
    const code = `
      const a = 1;
      const b = 2;
    `;
    const result = await analyzeCode(code);
    extractSymbolDossiers(result.ast, result);

    const ids = Array.from(result.symbolTable.bindings.keys());
    const renames = ids.map((id, i) => ({
      bindingId: id,
      originalName: "x",
      newName: `var${i}`,
      confidence: 1,
    }));

    const validation = validateRenames(renames, result.symbolTable);
    expect(validation.valid).toBe(true);
    expect(validation.errors.length).toBe(0);
  });

  test("detects invalid identifiers", async () => {
    const code = "const a = 1;";
    const result = await analyzeCode(code);
    extractSymbolDossiers(result.ast, result);

    const bindingId = Array.from(result.symbolTable.bindings.keys())[0]!;
    const renames = [
      {
        bindingId,
        originalName: "a",
        newName: "123invalid",
        confidence: 1,
      },
    ];

    const validation = validateRenames(renames, result.symbolTable);
    expect(validation.valid).toBe(false);
    expect(
      validation.errors.some((e) => e.includes("Invalid identifier")),
    ).toBe(true);
  });

  test("detects duplicates in same scope", async () => {
    const code = `
      const a = 1;
      const b = 2;
    `;
    const result = await analyzeCode(code);
    extractSymbolDossiers(result.ast, result);

    const ids = Array.from(result.symbolTable.bindings.keys());
    const renames = ids.map((id) => ({
      bindingId: id,
      originalName: "x",
      newName: "sameName", // Same name for both
      confidence: 1,
    }));

    const validation = validateRenames(renames, result.symbolTable);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e) => e.includes("Duplicate name"))).toBe(
      true,
    );
  });
});

describe("RESERVED_WORDS", () => {
  test("includes common keywords", () => {
    expect(RESERVED_WORDS.has("const")).toBe(true);
    expect(RESERVED_WORDS.has("let")).toBe(true);
    expect(RESERVED_WORDS.has("function")).toBe(true);
    expect(RESERVED_WORDS.has("class")).toBe(true);
    expect(RESERVED_WORDS.has("return")).toBe(true);
    expect(RESERVED_WORDS.has("if")).toBe(true);
    expect(RESERVED_WORDS.has("else")).toBe(true);
  });

  test("includes future reserved words", () => {
    expect(RESERVED_WORDS.has("enum")).toBe(true);
    expect(RESERVED_WORDS.has("implements")).toBe(true);
    expect(RESERVED_WORDS.has("interface")).toBe(true);
  });

  test("includes special identifiers", () => {
    expect(RESERVED_WORDS.has("undefined")).toBe(true);
    expect(RESERVED_WORDS.has("null")).toBe(true);
    expect(RESERVED_WORDS.has("true")).toBe(true);
    expect(RESERVED_WORDS.has("false")).toBe(true);
  });
});

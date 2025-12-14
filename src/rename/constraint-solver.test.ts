import { beforeEach, describe, expect, test } from "bun:test";
import {
  applyNamingConvention,
  collectCandidatesBySymbol,
  isValidIdentifier,
  sanitizeIdentifier,
  solveConstraints,
  validateDecisions,
} from "./constraint-solver";
import type { NamingResult } from "./llm-namer";
import type { ScopeChunk } from "./scope-chunker";
import { buildSymbolTable, resetIdCounters } from "./symbol-table";

beforeEach(() => {
  resetIdCounters();
});

describe("isValidIdentifier", () => {
  test("returns true for valid identifiers", () => {
    expect(isValidIdentifier("foo")).toBe(true);
    expect(isValidIdentifier("_bar")).toBe(true);
    expect(isValidIdentifier("$baz")).toBe(true);
    expect(isValidIdentifier("camelCase")).toBe(true);
    expect(isValidIdentifier("PascalCase")).toBe(true);
    expect(isValidIdentifier("snake_case")).toBe(true);
    expect(isValidIdentifier("a1")).toBe(true);
  });

  test("returns false for reserved words", () => {
    expect(isValidIdentifier("const")).toBe(false);
    expect(isValidIdentifier("let")).toBe(false);
    expect(isValidIdentifier("var")).toBe(false);
    expect(isValidIdentifier("function")).toBe(false);
    expect(isValidIdentifier("class")).toBe(false);
    expect(isValidIdentifier("if")).toBe(false);
    expect(isValidIdentifier("return")).toBe(false);
    expect(isValidIdentifier("static")).toBe(false);
  });

  test("returns false for invalid identifiers", () => {
    expect(isValidIdentifier("123abc")).toBe(false);
    expect(isValidIdentifier("foo-bar")).toBe(false);
    expect(isValidIdentifier("foo bar")).toBe(false);
    expect(isValidIdentifier("foo.bar")).toBe(false);
  });
});

describe("sanitizeIdentifier", () => {
  test("converts invalid characters", () => {
    expect(sanitizeIdentifier("foo-bar")).toBe("fooBar");
    expect(sanitizeIdentifier("foo bar")).toBe("fooBar");
    expect(sanitizeIdentifier("foo.bar")).toBe("fooBar");
  });

  test("prefixes reserved words", () => {
    expect(sanitizeIdentifier("const")).toBe("_const");
    expect(sanitizeIdentifier("static")).toBe("_static");
  });

  test("handles empty or invalid input", () => {
    expect(sanitizeIdentifier("")).toBe("unnamed");
  });

  test("keeps valid identifiers unchanged", () => {
    expect(sanitizeIdentifier("validName")).toBe("validName");
    expect(sanitizeIdentifier("_private")).toBe("_private");
  });
});

describe("applyNamingConvention", () => {
  test("converts class names to PascalCase", async () => {
    const code = `class foo {}`;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values())[0]!;

    expect(applyNamingConvention("myClass", symbol)).toBe("MyClass");
  });

  test("converts variable names to camelCase", async () => {
    const code = `const MyVar = 1;`;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values())[0]!;

    expect(applyNamingConvention("MyVar", symbol)).toBe("myVar");
  });

  test("handles snake_case input", async () => {
    const code = `const foo = 1;`;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values())[0]!;

    expect(applyNamingConvention("my_variable_name", symbol)).toBe(
      "myVariableName",
    );
  });
});

describe("collectCandidatesBySymbol", () => {
  test("groups candidates by symbol ID", () => {
    const mockChunk = {
      scopeId: "scope_0",
      scopeSummary: "test",
      scopeCode: "",
      symbols: [],
      dossiers: [],
      formattedPrompt: "",
    } as ScopeChunk;

    const results: NamingResult[] = [
      {
        chunk: mockChunk,
        candidates: [
          {
            symbolId: "sym_0",
            originalName: "a",
            newName: "count",
            confidence: 0.9,
            rationale: "test",
          },
        ],
      },
      {
        chunk: mockChunk,
        candidates: [
          {
            symbolId: "sym_0",
            originalName: "a",
            newName: "total",
            confidence: 0.8,
            rationale: "test",
          },
          {
            symbolId: "sym_1",
            originalName: "b",
            newName: "value",
            confidence: 0.7,
            rationale: "test",
          },
        ],
      },
    ];

    const grouped = collectCandidatesBySymbol(results);

    expect(grouped.get("sym_0")?.length).toBe(2);
    expect(grouped.get("sym_1")?.length).toBe(1);
  });
});

describe("solveConstraints", () => {
  test("applies rename decisions", async () => {
    const code = `const a = 1;`;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values())[0]!;

    const mockChunk = {
      scopeId: symbol.scopeId,
      scopeSummary: "test",
      scopeCode: "",
      symbols: [symbol],
      dossiers: [],
      formattedPrompt: "",
    } as ScopeChunk;

    const results: NamingResult[] = [
      {
        chunk: mockChunk,
        candidates: [
          {
            symbolId: symbol.id,
            originalName: "a",
            newName: "count",
            confidence: 0.9,
            rationale: "test",
          },
        ],
      },
    ];

    const decisions = solveConstraints(table, results);

    expect(decisions.length).toBe(1);
    expect(decisions[0]?.newName).toBe("count");
  });

  test("avoids name collisions", async () => {
    const code = `const a = 1; const b = 2;`;
    const table = await buildSymbolTable(code);
    const symbols = Array.from(table.symbols.values());
    const symbolA = symbols.find((s) => s.name === "a")!;
    const symbolB = symbols.find((s) => s.name === "b")!;

    const mockChunk = {
      scopeId: symbolA.scopeId,
      scopeSummary: "test",
      scopeCode: "",
      symbols: [symbolA, symbolB],
      dossiers: [],
      formattedPrompt: "",
    } as ScopeChunk;

    const results: NamingResult[] = [
      {
        chunk: mockChunk,
        candidates: [
          {
            symbolId: symbolA.id,
            originalName: "a",
            newName: "count",
            confidence: 0.9,
            rationale: "test",
          },
          {
            symbolId: symbolB.id,
            originalName: "b",
            newName: "count", // Same name!
            confidence: 0.8,
            rationale: "test",
          },
        ],
      },
    ];

    const decisions = solveConstraints(table, results);

    const newNames = decisions.map((d) => d.newName);
    // Should have unique names
    expect(new Set(newNames).size).toBe(newNames.length);
    expect(newNames.some((n) => n.startsWith("_count") || n === "count")).toBe(
      true,
    );
  });

  test("filters by confidence threshold", async () => {
    const code = `const a = 1;`;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values())[0]!;

    const mockChunk = {
      scopeId: symbol.scopeId,
      scopeSummary: "test",
      scopeCode: "",
      symbols: [symbol],
      dossiers: [],
      formattedPrompt: "",
    } as ScopeChunk;

    const results: NamingResult[] = [
      {
        chunk: mockChunk,
        candidates: [
          {
            symbolId: symbol.id,
            originalName: "a",
            newName: "count",
            confidence: 0.1, // Low confidence
            rationale: "test",
          },
        ],
      },
    ];

    const decisions = solveConstraints(table, results, {
      minConfidenceThreshold: 0.5,
    });

    expect(decisions.length).toBe(0);
  });

  test("sanitizes invalid identifiers", async () => {
    const code = `const a = 1;`;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values())[0]!;

    const mockChunk = {
      scopeId: symbol.scopeId,
      scopeSummary: "test",
      scopeCode: "",
      symbols: [symbol],
      dossiers: [],
      formattedPrompt: "",
    } as ScopeChunk;

    const results: NamingResult[] = [
      {
        chunk: mockChunk,
        candidates: [
          {
            symbolId: symbol.id,
            originalName: "a",
            newName: "static", // Reserved word
            confidence: 0.9,
            rationale: "test",
          },
        ],
      },
    ];

    const decisions = solveConstraints(table, results);

    expect(decisions[0]?.newName).toBe("_static");
  });
});

describe("validateDecisions", () => {
  test("validates correct decisions", async () => {
    const code = `const a = 1; const b = 2;`;
    const table = await buildSymbolTable(code);
    const symbols = Array.from(table.symbols.values());

    const decisions = [
      {
        symbolId: symbols[0]!.id,
        originalName: "a",
        newName: "count",
        confidence: 0.9,
      },
      {
        symbolId: symbols[1]!.id,
        originalName: "b",
        newName: "total",
        confidence: 0.8,
      },
    ];

    const result = validateDecisions(table, decisions);

    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  test("detects duplicate names in same scope", async () => {
    const code = `const a = 1; const b = 2;`;
    const table = await buildSymbolTable(code);
    const symbols = Array.from(table.symbols.values());

    const decisions = [
      {
        symbolId: symbols[0]!.id,
        originalName: "a",
        newName: "count",
        confidence: 0.9,
      },
      {
        symbolId: symbols[1]!.id,
        originalName: "b",
        newName: "count", // Duplicate!
        confidence: 0.8,
      },
    ];

    const result = validateDecisions(table, decisions);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Duplicate"))).toBe(true);
  });

  test("detects invalid identifiers", async () => {
    const code = `const a = 1;`;
    const table = await buildSymbolTable(code);
    const symbol = Array.from(table.symbols.values())[0]!;

    const decisions = [
      {
        symbolId: symbol.id,
        originalName: "a",
        newName: "123invalid",
        confidence: 0.9,
      },
    ];

    const result = validateDecisions(table, decisions);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Invalid identifier"))).toBe(
      true,
    );
  });
});

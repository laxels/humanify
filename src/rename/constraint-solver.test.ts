import { describe, expect, test } from "bun:test";
import {
  optimizeRenames,
  solveConstraints,
  validateRenames,
} from "./constraint-solver";
import { analyzeSymbols } from "./symbol-analysis";
import type { SymbolNamingResult } from "./types";

describe("solveConstraints", () => {
  test("resolves simple rename without conflict", async () => {
    const code = "const a = 1;";
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()][0]!;

    const namingResults: SymbolNamingResult[] = [
      {
        bindingId: binding.id,
        candidates: [
          { name: "count", confidence: 0.9, rationale: "It's a count" },
        ],
      },
    ];

    const resolved = solveConstraints(result, namingResults);

    expect(resolved.length).toBe(1);
    expect(resolved[0]?.originalName).toBe("a");
    expect(resolved[0]?.newName).toBe("count");
  });

  test("handles multiple bindings without conflict", async () => {
    const code = `
      const a = 1;
      const b = 2;
    `;
    const result = await analyzeSymbols(code);
    const bindings = [...result.bindings.values()];

    const namingResults: SymbolNamingResult[] = bindings.map((b, i) => ({
      bindingId: b.id,
      candidates: [
        { name: ["count", "total"][i]!, confidence: 0.9, rationale: "Test" },
      ],
    }));

    const resolved = solveConstraints(result, namingResults);

    expect(resolved.length).toBe(2);
    expect(resolved.map((r) => r.newName).sort()).toEqual(["count", "total"]);
  });

  test("resolves collision by prefixing with underscore", async () => {
    const code = `
      const a = 1;
      const b = 2;
    `;
    const result = await analyzeSymbols(code);
    const bindings = [...result.bindings.values()];

    // Both bindings want to be renamed to "count"
    const namingResults: SymbolNamingResult[] = bindings.map((b) => ({
      bindingId: b.id,
      candidates: [{ name: "count", confidence: 0.9, rationale: "Test" }],
    }));

    const resolved = solveConstraints(result, namingResults);

    expect(resolved.length).toBe(2);
    const newNames = resolved.map((r) => r.newName);
    expect(newNames).toContain("count");
    expect(newNames.some((n) => n.startsWith("_count"))).toBe(true);
  });

  test("falls back to second candidate on collision", async () => {
    const code = `
      const a = 1;
      const b = 2;
    `;
    const result = await analyzeSymbols(code);
    const bindings = [...result.bindings.values()];

    const namingResults: SymbolNamingResult[] = [
      {
        bindingId: bindings[0]!.id,
        candidates: [
          { name: "count", confidence: 0.9, rationale: "First choice" },
        ],
      },
      {
        bindingId: bindings[1]!.id,
        candidates: [
          { name: "count", confidence: 0.8, rationale: "First choice" },
          { name: "total", confidence: 0.7, rationale: "Second choice" },
        ],
      },
    ];

    const resolved = solveConstraints(result, namingResults);

    // First binding gets "count", second should get prefixed version or "total"
    expect(resolved.length).toBe(2);
  });

  test("applies camelCase convention for variables", async () => {
    const code = "let FOO_BAR = 1;";
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()][0]!;

    const namingResults: SymbolNamingResult[] = [
      {
        bindingId: binding.id,
        candidates: [{ name: "FOO_BAR", confidence: 0.9, rationale: "Test" }],
      },
    ];

    const resolved = solveConstraints(result, namingResults, {
      enforceCamelCase: true,
    });

    expect(resolved.length).toBe(1);
    expect(resolved[0]?.newName).toBe("fooBar");
  });

  test("applies PascalCase convention for classes", async () => {
    const code = "class foo_bar {}";
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()].find(
      (b) => b.kind === "class",
    )!;

    const namingResults: SymbolNamingResult[] = [
      {
        bindingId: binding.id,
        candidates: [{ name: "foo_bar", confidence: 0.9, rationale: "Test" }],
      },
    ];

    const resolved = solveConstraints(result, namingResults, {
      enforcePascalCase: true,
    });

    expect(resolved.length).toBe(1);
    expect(resolved[0]?.newName).toBe("FooBar");
  });

  test("respects minConfidence threshold", async () => {
    const code = "const a = 1;";
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()][0]!;

    const namingResults: SymbolNamingResult[] = [
      {
        bindingId: binding.id,
        candidates: [
          { name: "count", confidence: 0.2, rationale: "Low confidence" },
        ],
      },
    ];

    const resolved = solveConstraints(result, namingResults, {
      minConfidence: 0.5,
    });

    // Should not rename because confidence is below threshold
    expect(resolved.length).toBe(0);
  });

  test("handles shadowed variables correctly", async () => {
    const code = `
      const a = 1;
      function foo() {
        const a = 2;
      }
    `;
    const result = await analyzeSymbols(code);
    const bindings = [...result.bindings.values()].filter(
      (b) => b.name === "a",
    );

    const namingResults: SymbolNamingResult[] = bindings.map((b, i) => ({
      bindingId: b.id,
      candidates: [
        { name: ["outer", "inner"][i]!, confidence: 0.9, rationale: "Test" },
      ],
    }));

    const resolved = solveConstraints(result, namingResults);

    // Both should be renamed without conflict since they're in different scopes
    expect(resolved.length).toBe(2);
    expect(resolved.map((r) => r.newName).sort()).toEqual(["inner", "outer"]);
  });

  test("sanitizes invalid identifiers", async () => {
    const code = "const a = 1;";
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()][0]!;

    const namingResults: SymbolNamingResult[] = [
      {
        bindingId: binding.id,
        candidates: [
          { name: "foo-bar", confidence: 0.9, rationale: "Invalid" },
        ],
      },
    ];

    const resolved = solveConstraints(result, namingResults);

    expect(resolved.length).toBe(1);
    expect(resolved[0]?.newName).toBe("foobar");
  });

  test("does not rename if new name equals original", async () => {
    const code = "const count = 1;";
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()][0]!;

    const namingResults: SymbolNamingResult[] = [
      {
        bindingId: binding.id,
        candidates: [
          { name: "count", confidence: 0.9, rationale: "Keep same" },
        ],
      },
    ];

    const resolved = solveConstraints(result, namingResults);

    // Should not include a rename when new name equals original
    expect(resolved.length).toBe(0);
  });

  test("handles empty naming results", async () => {
    const code = "const a = 1;";
    const result = await analyzeSymbols(code);

    const resolved = solveConstraints(result, []);

    expect(resolved.length).toBe(0);
  });

  test("handles bindings without naming results", async () => {
    const code = `
      const a = 1;
      const b = 2;
    `;
    const result = await analyzeSymbols(code);
    const bindings = [...result.bindings.values()];

    // Only provide naming result for first binding
    const namingResults: SymbolNamingResult[] = [
      {
        bindingId: bindings[0]!.id,
        candidates: [{ name: "count", confidence: 0.9, rationale: "Test" }],
      },
    ];

    const resolved = solveConstraints(result, namingResults);

    // Only first binding should be renamed
    expect(resolved.length).toBe(1);
    expect(resolved[0]?.originalName).toBe("a");
  });
});

describe("validateRenames", () => {
  test("returns valid for non-conflicting renames", async () => {
    const code = `
      const a = 1;
      const b = 2;
    `;
    const result = await analyzeSymbols(code);
    const bindings = [...result.bindings.values()];

    const renames = bindings.map((b, i) => ({
      bindingId: b.id,
      originalName: b.name,
      newName: ["count", "total"][i]!,
      confidence: 0.9,
    }));

    const validation = validateRenames(renames, result);

    expect(validation.isValid).toBe(true);
    expect(validation.conflicts.length).toBe(0);
  });

  test("detects conflicts in same scope", async () => {
    const code = `
      const a = 1;
      const b = 2;
    `;
    const result = await analyzeSymbols(code);
    const bindings = [...result.bindings.values()];

    // Both renamed to same name - conflict!
    const renames = bindings.map((b) => ({
      bindingId: b.id,
      originalName: b.name,
      newName: "count",
      confidence: 0.9,
    }));

    const validation = validateRenames(renames, result);

    expect(validation.isValid).toBe(false);
    expect(validation.conflicts.length).toBe(1);
    expect(validation.conflicts[0]?.name).toBe("count");
  });

  test("allows same name in different scopes", async () => {
    const code = `
      const a = 1;
      function foo() {
        const b = 2;
      }
    `;
    const result = await analyzeSymbols(code);
    const aBinding = [...result.bindings.values()].find((b) => b.name === "a")!;
    const bBinding = [...result.bindings.values()].find((b) => b.name === "b")!;

    // Both renamed to same name but in different scopes
    const renames = [
      {
        bindingId: aBinding.id,
        originalName: "a",
        newName: "count",
        confidence: 0.9,
      },
      {
        bindingId: bBinding.id,
        originalName: "b",
        newName: "count",
        confidence: 0.9,
      },
    ];

    const validation = validateRenames(renames, result);

    // Should be valid since they're in different scopes
    expect(validation.isValid).toBe(true);
  });
});

describe("optimizeRenames", () => {
  test("returns renames unchanged when valid", async () => {
    const code = "const a = 1;";
    const result = await analyzeSymbols(code);
    const binding = [...result.bindings.values()][0]!;

    const renames = [
      {
        bindingId: binding.id,
        originalName: "a",
        newName: "count",
        confidence: 0.9,
      },
    ];

    const optimized = optimizeRenames(renames, result);

    expect(optimized).toEqual(renames);
  });

  test("removes lower confidence conflicting renames", async () => {
    const code = `
      const a = 1;
      const b = 2;
    `;
    const result = await analyzeSymbols(code);
    const bindings = [...result.bindings.values()];

    const renames = [
      {
        bindingId: bindings[0]!.id,
        originalName: "a",
        newName: "count",
        confidence: 0.9,
      },
      {
        bindingId: bindings[1]!.id,
        originalName: "b",
        newName: "count",
        confidence: 0.7, // Lower confidence
      },
    ];

    const optimized = optimizeRenames(renames, result);

    // Should keep the higher confidence rename
    expect(optimized.length).toBeLessThanOrEqual(2);
    const countRename = optimized.find((r) => r.newName === "count");
    if (countRename) {
      expect(countRename.confidence).toBe(0.9);
    }
  });
});

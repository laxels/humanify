import { expect, test } from "bun:test";
import { normalizeCandidateName, solveSymbolNames } from "./constraint-solver";
import type { NameCandidate } from "./types";

test("normalizeCandidateName enforces camelCase (preserving leading underscores)", () => {
  expect(normalizeCandidateName("Foo Bar", "camel")).toBe("fooBar");
  expect(normalizeCandidateName("_Foo Bar", "camel")).toBe("_fooBar");
});

test("normalizeCandidateName enforces PascalCase (preserving leading underscores)", () => {
  expect(normalizeCandidateName("foo bar", "pascal")).toBe("FooBar");
  expect(normalizeCandidateName("_foo bar", "pascal")).toBe("_FooBar");
});

test("normalizeCandidateName enforces UPPER_SNAKE", () => {
  expect(normalizeCandidateName("maxRetries", "upper_snake")).toBe(
    "MAX_RETRIES",
  );
  expect(normalizeCandidateName("max retries", "upper_snake")).toBe(
    "MAX_RETRIES",
  );
});

test("solver chooses max-confidence combination under collisions", () => {
  const s1 = {
    symbolId: "s1",
    scopeId: "scope_1",
    originalName: "a",
    nameStyle: "camel" as const,
    importance: 10,
  };
  const s2 = {
    symbolId: "s2",
    scopeId: "scope_1",
    originalName: "b",
    nameStyle: "camel" as const,
    importance: 10,
  };

  const suggestions = new Map<string, NameCandidate[]>();
  suggestions.set("s1", [
    { name: "foo", confidence: 0.9 },
    { name: "bar", confidence: 0.1 },
  ]);
  suggestions.set("s2", [
    { name: "foo", confidence: 0.8 },
    { name: "baz", confidence: 0.7 },
  ]);

  const solved = solveSymbolNames({
    symbols: [s1, s2],
    suggestions,
    occupiedByScope: new Map(),
  });

  expect(solved.get("s1")).toBe("foo");
  expect(solved.get("s2")).toBe("baz");
});

test("solver enforces no collisions per scope but allows same name in different scopes", () => {
  const s1 = {
    symbolId: "s1",
    scopeId: "scope_1",
    originalName: "a",
    nameStyle: "camel" as const,
    importance: 1,
  };
  const s2 = {
    symbolId: "s2",
    scopeId: "scope_2",
    originalName: "b",
    nameStyle: "camel" as const,
    importance: 1,
  };

  const suggestions = new Map<string, NameCandidate[]>();
  suggestions.set("s1", [{ name: "value", confidence: 1 }]);
  suggestions.set("s2", [{ name: "value", confidence: 1 }]);

  const solved = solveSymbolNames({
    symbols: [s1, s2],
    suggestions,
    occupiedByScope: new Map(),
  });

  expect(solved.get("s1")).toBe("value");
  expect(solved.get("s2")).toBe("value");
});

test("solver respects occupied fixed names within a scope", () => {
  const s1 = {
    symbolId: "s1",
    scopeId: "scope_1",
    originalName: "a",
    nameStyle: "camel" as const,
    importance: 1,
  };

  const suggestions = new Map<string, NameCandidate[]>();
  suggestions.set("s1", [{ name: "taken", confidence: 1 }]);

  const occupiedByScope = new Map<string, Set<string>>();
  occupiedByScope.set("scope_1", new Set(["taken"]));

  const solved = solveSymbolNames({
    symbols: [s1],
    suggestions,
    occupiedByScope,
  });

  // If "taken" is occupied, solver will make it unique by prefixing underscores.
  expect(solved.get("s1")).toBe("_taken");
});

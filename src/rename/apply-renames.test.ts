import { describe, expect, test } from "bun:test";
import { analyzeCode } from "../analysis/scope-analyzer";
import { extractSymbolDossiers } from "../analysis/symbol-dossier";
import type { ResolvedRename } from "../analysis/types";
import {
  applyRenames,
  applyRenamesWithDiagnostics,
  createRenameLookup,
  createRenameSummary,
  groupRenamesByScope,
} from "./apply-renames";

describe("groupRenamesByScope", () => {
  test("groups renames by scope UID", () => {
    const renames: ResolvedRename[] = [
      {
        bindingId: "1:a",
        originalName: "a",
        newName: "renamed",
        confidence: 1,
      },
      { bindingId: "1:b", originalName: "b", newName: "other", confidence: 1 },
      { bindingId: "2:c", originalName: "c", newName: "third", confidence: 1 },
    ];

    const grouped = groupRenamesByScope(renames);

    expect(grouped.size).toBe(2);
    expect(grouped.get("1")?.size).toBe(2);
    expect(grouped.get("2")?.size).toBe(1);
  });

  test("skips unchanged renames", () => {
    const renames: ResolvedRename[] = [
      { bindingId: "1:a", originalName: "a", newName: "a", confidence: 0 }, // No change
      {
        bindingId: "1:b",
        originalName: "b",
        newName: "renamed",
        confidence: 1,
      },
    ];

    const grouped = groupRenamesByScope(renames);

    expect(grouped.get("1")?.size).toBe(1);
    expect(grouped.get("1")?.has("a")).toBe(false);
    expect(grouped.get("1")?.has("b")).toBe(true);
  });
});

describe("createRenameLookup", () => {
  test("creates lookup function", () => {
    const renames: ResolvedRename[] = [
      {
        bindingId: "1:a",
        originalName: "a",
        newName: "renamed",
        confidence: 1,
      },
    ];

    const lookup = createRenameLookup(renames);

    expect(lookup("1", "a")).toBe("renamed");
    expect(lookup("1", "b")).toBeUndefined();
    expect(lookup("2", "a")).toBeUndefined();
  });
});

describe("applyRenames", () => {
  test("renames a simple variable", async () => {
    const code = "const a = 1;";
    const result = await analyzeCode(code);
    extractSymbolDossiers(result.ast, result);

    const bindingId = Array.from(result.symbolTable.bindings.keys())[0]!;
    const renames: ResolvedRename[] = [
      { bindingId, originalName: "a", newName: "myValue", confidence: 1 },
    ];

    const renamed = await applyRenames(result.ast, renames, result.symbolTable);

    expect(renamed).toContain("myValue");
    expect(renamed).not.toContain("const a");
  });

  test("renames multiple variables", async () => {
    const code = `
      const a = 1;
      const b = 2;
      const c = a + b;
    `;
    const result = await analyzeCode(code);
    extractSymbolDossiers(result.ast, result);

    const renames: ResolvedRename[] = [];
    for (const [id, dossier] of result.symbolTable.bindings) {
      const newName =
        dossier.originalName === "a"
          ? "first"
          : dossier.originalName === "b"
            ? "second"
            : "sum";
      renames.push({
        bindingId: id,
        originalName: dossier.originalName,
        newName,
        confidence: 1,
      });
    }

    const renamed = await applyRenames(result.ast, renames, result.symbolTable);

    expect(renamed).toContain("first");
    expect(renamed).toContain("second");
    expect(renamed).toContain("sum");
    expect(renamed).toContain("first + second"); // References are updated
  });

  test("handles unchanged renames gracefully", async () => {
    const code = "const a = 1;";
    const result = await analyzeCode(code);
    extractSymbolDossiers(result.ast, result);

    const bindingId = Array.from(result.symbolTable.bindings.keys())[0]!;
    const renames: ResolvedRename[] = [
      { bindingId, originalName: "a", newName: "a", confidence: 0 }, // No change
    ];

    const renamed = await applyRenames(result.ast, renames, result.symbolTable);

    expect(renamed).toContain("const a");
  });

  test("renames function parameters", async () => {
    const code = `
      function foo(x, y) {
        return x + y;
      }
    `;
    const result = await analyzeCode(code);
    extractSymbolDossiers(result.ast, result);

    const renames: ResolvedRename[] = [];
    for (const [id, dossier] of result.symbolTable.bindings) {
      if (dossier.originalName === "x") {
        renames.push({
          bindingId: id,
          originalName: "x",
          newName: "first",
          confidence: 1,
        });
      } else if (dossier.originalName === "y") {
        renames.push({
          bindingId: id,
          originalName: "y",
          newName: "second",
          confidence: 1,
        });
      }
    }

    const renamed = await applyRenames(result.ast, renames, result.symbolTable);

    expect(renamed).toContain("first");
    expect(renamed).toContain("second");
    expect(renamed).toContain("first + second");
  });

  test("handles nested scopes with shadowing", async () => {
    const code = `
      const a = 1;
      function foo() {
        const a = 2;
        return a;
      }
    `;
    const result = await analyzeCode(code);
    extractSymbolDossiers(result.ast, result);

    // Find the two 'a' bindings and rename them differently
    const renames: ResolvedRename[] = [];
    const aBindings = Array.from(result.symbolTable.bindings.entries()).filter(
      ([_, d]) => d.originalName === "a",
    );

    // Sort by scope size to determine which is outer
    aBindings.sort((a, b) => {
      const scopeA = result.symbolTable.scopes.get(a[1].scopeId);
      const scopeB = result.symbolTable.scopes.get(b[1].scopeId);
      return (scopeB?.size ?? 0) - (scopeA?.size ?? 0);
    });

    const outerBinding = aBindings[0];
    const innerBinding = aBindings[1];

    if (outerBinding && innerBinding) {
      renames.push({
        bindingId: outerBinding[0],
        originalName: "a",
        newName: "outer",
        confidence: 1,
      });
      renames.push({
        bindingId: innerBinding[0],
        originalName: "a",
        newName: "inner",
        confidence: 1,
      });
    }

    const renamed = await applyRenames(result.ast, renames, result.symbolTable);

    expect(renamed).toContain("outer");
    expect(renamed).toContain("inner");
  });

  test("expands object shorthand properties", async () => {
    const code = `
      const foo = 1;
      const obj = { foo };
    `;
    const result = await analyzeCode(code);
    extractSymbolDossiers(result.ast, result);

    const fooBinding = Array.from(result.symbolTable.bindings.entries()).find(
      ([_, d]) => d.originalName === "foo",
    );

    const renames: ResolvedRename[] = [
      {
        bindingId: fooBinding![0],
        originalName: "foo",
        newName: "myValue",
        confidence: 1,
      },
    ];

    const renamed = await applyRenames(result.ast, renames, result.symbolTable);

    // Should preserve the object key
    expect(renamed).toContain("foo:");
    expect(renamed).toContain("myValue");
  });

  test("handles export specifiers", async () => {
    const code = `
      const foo = 1;
      export { foo };
    `;
    const result = await analyzeCode(code);
    extractSymbolDossiers(result.ast, result);

    const fooBinding = Array.from(result.symbolTable.bindings.entries()).find(
      ([_, d]) => d.originalName === "foo",
    );

    const renames: ResolvedRename[] = [
      {
        bindingId: fooBinding![0],
        originalName: "foo",
        newName: "myValue",
        confidence: 1,
      },
    ];

    const renamed = await applyRenames(result.ast, renames, result.symbolTable);

    // Should preserve the exported name
    expect(renamed).toContain("myValue");
    expect(renamed).toContain("foo"); // The exported name should still be 'foo'
  });

  test("renames class declarations", async () => {
    const code = `
      class Foo {
        constructor() {}
      }
      const instance = new Foo();
    `;
    const result = await analyzeCode(code);
    extractSymbolDossiers(result.ast, result);

    const classBinding = Array.from(result.symbolTable.bindings.entries()).find(
      ([_, d]) => d.originalName === "Foo",
    );

    const renames: ResolvedRename[] = [
      {
        bindingId: classBinding![0],
        originalName: "Foo",
        newName: "MyClass",
        confidence: 1,
      },
    ];

    const renamed = await applyRenames(result.ast, renames, result.symbolTable);

    expect(renamed).toContain("class MyClass");
    expect(renamed).toContain("new MyClass");
  });

  test("handles arrow functions", async () => {
    const code = `
      const fn = (x) => x * 2;
      const result = fn(5);
    `;
    const result = await analyzeCode(code);
    extractSymbolDossiers(result.ast, result);

    const fnBinding = Array.from(result.symbolTable.bindings.entries()).find(
      ([_, d]) => d.originalName === "fn",
    );
    const xBinding = Array.from(result.symbolTable.bindings.entries()).find(
      ([_, d]) => d.originalName === "x",
    );

    const renames: ResolvedRename[] = [
      {
        bindingId: fnBinding![0],
        originalName: "fn",
        newName: "double",
        confidence: 1,
      },
      {
        bindingId: xBinding![0],
        originalName: "x",
        newName: "num",
        confidence: 1,
      },
    ];

    const renamed = await applyRenames(result.ast, renames, result.symbolTable);

    expect(renamed).toContain("double");
    expect(renamed).toContain("num");
    expect(renamed).toContain("double(5)");
  });
});

describe("applyRenamesWithDiagnostics", () => {
  test("returns applied count", async () => {
    const code = `
      const a = 1;
      const b = 2;
    `;
    const result = await analyzeCode(code);
    extractSymbolDossiers(result.ast, result);

    const renames: ResolvedRename[] = [];
    for (const [id, dossier] of result.symbolTable.bindings) {
      renames.push({
        bindingId: id,
        originalName: dossier.originalName,
        newName: dossier.originalName + "_renamed",
        confidence: 1,
      });
    }

    const { appliedCount, skippedCount } = await applyRenamesWithDiagnostics(
      result.ast,
      renames,
      result.symbolTable,
    );

    expect(appliedCount).toBe(2);
    expect(skippedCount).toBe(0);
  });

  test("counts skipped unchanged renames", async () => {
    const code = `
      const a = 1;
      const b = 2;
    `;
    const result = await analyzeCode(code);
    extractSymbolDossiers(result.ast, result);

    const renames: ResolvedRename[] = [];
    for (const [id, dossier] of result.symbolTable.bindings) {
      renames.push({
        bindingId: id,
        originalName: dossier.originalName,
        newName: dossier.originalName, // No change
        confidence: 0,
      });
    }

    const { appliedCount, skippedCount } = await applyRenamesWithDiagnostics(
      result.ast,
      renames,
      result.symbolTable,
    );

    expect(appliedCount).toBe(0);
    expect(skippedCount).toBe(0); // Unchanged renames aren't "skipped", they're just not applied
  });
});

describe("createRenameSummary", () => {
  test("summarizes changed vs unchanged", () => {
    const renames: ResolvedRename[] = [
      {
        bindingId: "1:a",
        originalName: "a",
        newName: "renamed",
        confidence: 0.9,
      },
      { bindingId: "1:b", originalName: "b", newName: "b", confidence: 0 },
    ];

    const summary = createRenameSummary(renames);

    expect(summary).toContain("Total bindings: 2");
    expect(summary).toContain("Changed: 1");
    expect(summary).toContain("Unchanged: 1");
  });

  test("lists changes with confidence", () => {
    const renames: ResolvedRename[] = [
      {
        bindingId: "1:a",
        originalName: "a",
        newName: "myVar",
        confidence: 0.85,
      },
    ];

    const summary = createRenameSummary(renames);

    expect(summary).toContain("a -> myVar");
    expect(summary).toContain("85%");
  });

  test("truncates long lists", () => {
    const renames: ResolvedRename[] = [];
    for (let i = 0; i < 30; i++) {
      renames.push({
        bindingId: `1:var${i}`,
        originalName: `var${i}`,
        newName: `renamed${i}`,
        confidence: 1,
      });
    }

    const summary = createRenameSummary(renames);

    expect(summary).toContain("... and 10 more");
  });
});

describe("edge cases", () => {
  test("handles empty code", async () => {
    const code = "";
    const result = await analyzeCode(code);

    const renamed = await applyRenames(result.ast, [], result.symbolTable);

    // Empty code should produce empty or near-empty output
    expect(renamed.trim()).toBe("");
  });

  test("handles code with no bindings", async () => {
    const code = "console.log('hello');";
    const result = await analyzeCode(code);

    const renamed = await applyRenames(result.ast, [], result.symbolTable);

    expect(renamed).toContain("console.log");
  });

  test("handles destructuring", async () => {
    const code = `
      const { a, b } = obj;
      console.log(a, b);
    `;
    const result = await analyzeCode(code);
    extractSymbolDossiers(result.ast, result);

    const aBinding = Array.from(result.symbolTable.bindings.entries()).find(
      ([_, d]) => d.originalName === "a",
    );
    const bBinding = Array.from(result.symbolTable.bindings.entries()).find(
      ([_, d]) => d.originalName === "b",
    );

    const renames: ResolvedRename[] = [
      {
        bindingId: aBinding![0],
        originalName: "a",
        newName: "first",
        confidence: 1,
      },
      {
        bindingId: bBinding![0],
        originalName: "b",
        newName: "second",
        confidence: 1,
      },
    ];

    const renamed = await applyRenames(result.ast, renames, result.symbolTable);

    expect(renamed).toContain("first");
    expect(renamed).toContain("second");
  });

  test("handles catch clause", async () => {
    const code = `
      try {
        doSomething();
      } catch (e) {
        console.log(e);
      }
    `;
    const result = await analyzeCode(code);
    extractSymbolDossiers(result.ast, result);

    const eBinding = Array.from(result.symbolTable.bindings.entries()).find(
      ([_, d]) => d.originalName === "e",
    );

    if (eBinding) {
      const renames: ResolvedRename[] = [
        {
          bindingId: eBinding[0],
          originalName: "e",
          newName: "error",
          confidence: 1,
        },
      ];

      const renamed = await applyRenames(
        result.ast,
        renames,
        result.symbolTable,
      );

      expect(renamed).toContain("catch (error)");
      expect(renamed).toContain("console.log(error)");
    }
  });
});

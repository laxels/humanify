import { describe, expect, test } from "bun:test";
import type { ScopeInfo, SymbolDossier } from "../analysis/types";
import {
  batchDossiers,
  createBatchRenameContent,
  createBatchRenameSystemPrompt,
  createBatchRenameTool,
  getScopeContextForBatch,
} from "./batch-rename";

const createMockDossier = (name: string): SymbolDossier => ({
  id: `1:${name}`,
  originalName: name,
  declarationKind: "const",
  declarationContext: `const ${name} = 1;`,
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
  scopeId: "1",
  isExported: false,
  isUnsafe: false,
});

const createMockScope = (code: string): ScopeInfo => ({
  id: "1",
  parentId: null,
  kind: "program",
  summary: "Program",
  bindingIds: [],
  code,
  size: code.length,
});

describe("createBatchRenameSystemPrompt", () => {
  test("returns non-empty string", () => {
    const prompt = createBatchRenameSystemPrompt();
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("includes naming conventions guidance", () => {
    const prompt = createBatchRenameSystemPrompt();
    expect(prompt).toContain("camelCase");
    expect(prompt).toContain("PascalCase");
  });

  test("includes prefix guidance", () => {
    const prompt = createBatchRenameSystemPrompt();
    expect(prompt).toContain("is");
    expect(prompt).toContain("handle");
  });
});

describe("createBatchRenameContent", () => {
  test("includes scope context", () => {
    const dossiers = [createMockDossier("foo")];
    const content = createBatchRenameContent("const foo = 1;", dossiers);

    expect(content).toContain("Scope Context");
    expect(content).toContain("const foo = 1;");
  });

  test("includes identifiers section", () => {
    const dossiers = [createMockDossier("foo")];
    const content = createBatchRenameContent("const foo = 1;", dossiers);

    expect(content).toContain("Identifiers to Rename");
    expect(content).toContain("foo");
  });

  test("handles multiple dossiers", () => {
    const dossiers = [
      createMockDossier("foo"),
      createMockDossier("bar"),
      createMockDossier("baz"),
    ];
    const content = createBatchRenameContent("const foo = 1;", dossiers);

    expect(content).toContain("foo");
    expect(content).toContain("bar");
    expect(content).toContain("baz");
  });
});

describe("createBatchRenameTool", () => {
  test("returns valid tool definition", () => {
    const dossiers = [createMockDossier("foo")];
    const tool = createBatchRenameTool(dossiers);

    expect(tool.name).toBe("suggest_renames");
    expect(tool.description).toBeDefined();
    expect(tool.input_schema).toBeDefined();
  });

  test("tool schema has required fields", () => {
    const dossiers = [createMockDossier("foo")];
    const tool = createBatchRenameTool(dossiers);
    const schema = tool.input_schema as any;

    expect(schema.type).toBe("object");
    expect(schema.properties.renames).toBeDefined();
    expect(schema.required).toContain("renames");
  });

  test("renames schema has correct structure", () => {
    const dossiers = [createMockDossier("foo")];
    const tool = createBatchRenameTool(dossiers);
    const schema = tool.input_schema as any;
    const renamesSchema = schema.properties.renames;

    expect(renamesSchema.type).toBe("array");
    expect(renamesSchema.items.properties.originalName).toBeDefined();
    expect(renamesSchema.items.properties.candidates).toBeDefined();
  });

  test("candidates schema limits count", () => {
    const dossiers = [createMockDossier("foo")];
    const tool = createBatchRenameTool(dossiers);
    const schema = tool.input_schema as any;
    const candidatesSchema =
      schema.properties.renames.items.properties.candidates;

    expect(candidatesSchema.minItems).toBe(1);
    expect(candidatesSchema.maxItems).toBe(3);
  });
});

describe("batchDossiers", () => {
  test("returns single batch for small input", () => {
    const dossiers = [
      createMockDossier("a"),
      createMockDossier("b"),
      createMockDossier("c"),
    ];

    const batches = batchDossiers(dossiers, 10);

    expect(batches.length).toBe(1);
    expect(batches[0]!.length).toBe(3);
  });

  test("splits into multiple batches", () => {
    const dossiers = [];
    for (let i = 0; i < 10; i++) {
      dossiers.push(createMockDossier(`var${i}`));
    }

    const batches = batchDossiers(dossiers, 3);

    expect(batches.length).toBe(4); // 3 + 3 + 3 + 1
    expect(batches[0]!.length).toBe(3);
    expect(batches[3]!.length).toBe(1);
  });

  test("handles empty input", () => {
    const batches = batchDossiers([], 10);
    expect(batches.length).toBe(0);
  });

  test("handles exact batch size match", () => {
    const dossiers = [];
    for (let i = 0; i < 6; i++) {
      dossiers.push(createMockDossier(`var${i}`));
    }

    const batches = batchDossiers(dossiers, 3);

    expect(batches.length).toBe(2);
    expect(batches[0]!.length).toBe(3);
    expect(batches[1]!.length).toBe(3);
  });

  test("preserves dossier order", () => {
    const dossiers = [
      createMockDossier("first"),
      createMockDossier("second"),
      createMockDossier("third"),
    ];

    const batches = batchDossiers(dossiers, 2);

    expect(batches[0]![0]!.originalName).toBe("first");
    expect(batches[0]![1]!.originalName).toBe("second");
    expect(batches[1]![0]!.originalName).toBe("third");
  });
});

describe("getScopeContextForBatch", () => {
  test("returns short code unchanged", () => {
    const scope = createMockScope("const a = 1;");
    const context = getScopeContextForBatch(scope, 100);
    expect(context).toBe("const a = 1;");
  });

  test("truncates long code", () => {
    const longCode = "a".repeat(1000);
    const scope = createMockScope(longCode);
    const context = getScopeContextForBatch(scope, 100);

    expect(context.length).toBeLessThanOrEqual(120); // 100 + truncation message
    expect(context).toContain("truncated");
  });

  test("uses default max size", () => {
    const longCode = "a".repeat(5000);
    const scope = createMockScope(longCode);
    const context = getScopeContextForBatch(scope);

    // Default is 3000
    expect(context.length).toBeLessThanOrEqual(3050);
  });
});

describe("integration", () => {
  test("creates complete rename request", () => {
    const dossiers = [createMockDossier("a"), createMockDossier("b")];
    const scope = createMockScope("const a = 1; const b = 2;");

    const systemPrompt = createBatchRenameSystemPrompt();
    const content = createBatchRenameContent(scope.code, dossiers);
    const tool = createBatchRenameTool(dossiers);

    // Verify all parts are present
    expect(systemPrompt).toContain("JavaScript");
    expect(content).toContain("a");
    expect(content).toContain("b");
    expect(tool.name).toBe("suggest_renames");
  });

  test("batching and context work together", () => {
    const dossiers = [];
    for (let i = 0; i < 20; i++) {
      dossiers.push(createMockDossier(`var${i}`));
    }

    const scope = createMockScope("// Large scope\n" + "x".repeat(5000));

    const batches = batchDossiers(dossiers, 5);
    const context = getScopeContextForBatch(scope, 1000);

    // Should have 4 batches
    expect(batches.length).toBe(4);

    // Each batch can use the same truncated context
    for (const batch of batches) {
      const content = createBatchRenameContent(context, batch);
      expect(content).toContain("truncated");
      expect(content.length).toBeLessThan(10000);
    }
  });
});

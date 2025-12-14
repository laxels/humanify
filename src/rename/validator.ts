import { parseAsync } from "@babel/core";
import type { ParseResult } from "@babel/parser";
import * as babelTraverse from "@babel/traverse";
import type { File } from "@babel/types";

const traverse = (
  typeof (babelTraverse as unknown as { default?: unknown }).default ===
  "function"
    ? (babelTraverse as unknown as { default: typeof babelTraverse.default })
        .default
    : (
        babelTraverse as unknown as {
          default: { default: typeof babelTraverse.default };
        }
      ).default.default
) as typeof babelTraverse.default;

export type ValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export type ValidationOptions = {
  checkUndefinedReferences?: boolean;
  checkDuplicateDeclarations?: boolean;
  checkReservedWords?: boolean;
};

const DEFAULT_OPTIONS: ValidationOptions = {
  checkUndefinedReferences: true,
  checkDuplicateDeclarations: true,
  checkReservedWords: true,
};

export async function validateCode(
  code: string,
  options: ValidationOptions = {},
): Promise<ValidationResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const errors: string[] = [];
  const warnings: string[] = [];

  // First, check if the code is parseable
  let ast: ParseResult<File> | null | undefined;
  try {
    ast = await parseAsync(code, { sourceType: "unambiguous" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      valid: false,
      errors: [`Parse error: ${message}`],
      warnings: [],
    };
  }

  if (!ast) {
    return {
      valid: false,
      errors: ["Failed to parse code"],
      warnings: [],
    };
  }

  // Check for undefined references
  if (opts.checkUndefinedReferences) {
    const undefinedRefs = findUndefinedReferences(ast);
    for (const ref of undefinedRefs) {
      warnings.push(`Potentially undefined reference: ${ref}`);
    }
  }

  // Check for duplicate declarations in the same scope
  if (opts.checkDuplicateDeclarations) {
    const duplicates = findDuplicateDeclarations(ast);
    for (const dup of duplicates) {
      errors.push(`Duplicate declaration: ${dup}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function findUndefinedReferences(
  ast: ReturnType<typeof parseAsync> extends Promise<infer T>
    ? NonNullable<T>
    : never,
): string[] {
  const undefined_refs: string[] = [];
  const globalNames = new Set([
    // Browser globals
    "window",
    "document",
    "navigator",
    "location",
    "history",
    "localStorage",
    "sessionStorage",
    "fetch",
    "console",
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "clearInterval",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "alert",
    "confirm",
    "prompt",
    "XMLHttpRequest",
    "WebSocket",
    "Event",
    "CustomEvent",
    "Error",
    "TypeError",
    "ReferenceError",
    "SyntaxError",
    "JSON",
    "Math",
    "Date",
    "RegExp",
    "Array",
    "Object",
    "String",
    "Number",
    "Boolean",
    "Symbol",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "Promise",
    "Proxy",
    "Reflect",
    "Int8Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Uint32Array",
    "Float32Array",
    "Float64Array",
    "BigInt64Array",
    "BigUint64Array",
    "ArrayBuffer",
    "SharedArrayBuffer",
    "DataView",
    "Atomics",
    "Intl",
    "URL",
    "URLSearchParams",
    "FormData",
    "Blob",
    "File",
    "FileReader",
    "Headers",
    "Request",
    "Response",
    "AbortController",
    "AbortSignal",
    "MutationObserver",
    "IntersectionObserver",
    "ResizeObserver",
    "PerformanceObserver",
    // Node.js globals
    "process",
    "global",
    "Buffer",
    "require",
    "module",
    "exports",
    "__dirname",
    "__filename",
    // Common globals
    "undefined",
    "NaN",
    "Infinity",
    "eval",
    "isFinite",
    "isNaN",
    "parseFloat",
    "parseInt",
    "decodeURI",
    "decodeURIComponent",
    "encodeURI",
    "encodeURIComponent",
    "escape",
    "unescape",
    "globalThis",
    "queueMicrotask",
    "structuredClone",
  ]);

  traverse(ast, {
    ReferencedIdentifier(path) {
      const name = path.node.name;

      // Skip if it's a binding in the current scope
      if (path.scope.hasBinding(name)) {
        return;
      }

      // Skip known globals
      if (globalNames.has(name)) {
        return;
      }

      // Skip member expression properties
      if (
        path.parentPath?.isMemberExpression() &&
        path.parentPath.get("property") === path &&
        !path.parentPath.node.computed
      ) {
        return;
      }

      // Skip object property keys
      if (
        path.parentPath?.isObjectProperty() &&
        path.parentPath.get("key") === path &&
        !path.parentPath.node.computed
      ) {
        return;
      }

      // This might be an undefined reference
      if (!undefined_refs.includes(name)) {
        undefined_refs.push(name);
      }
    },
  });

  return undefined_refs;
}

function findDuplicateDeclarations(
  ast: ReturnType<typeof parseAsync> extends Promise<infer T>
    ? NonNullable<T>
    : never,
): string[] {
  const duplicates: string[] = [];

  traverse(ast, {
    Scope(path) {
      const bindings = path.scope.bindings;
      const declarations = new Map<string, number>();

      for (const [name, binding] of Object.entries(bindings)) {
        // Skip hoisted function declarations which can be redeclared
        if (binding.kind === "hoisted") continue;

        const count = declarations.get(name) || 0;
        declarations.set(name, count + 1);

        if (count > 0 && !duplicates.includes(name)) {
          duplicates.push(name);
        }
      }
    },
  });

  return duplicates;
}

export function validateRenamedCode(
  originalCode: string,
  renamedCode: string,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Basic length check - renamed code shouldn't be dramatically different in size
  const originalLength = originalCode.length;
  const renamedLength = renamedCode.length;
  const ratio = renamedLength / originalLength;

  if (ratio < 0.5 || ratio > 2) {
    warnings.push(
      `Code size changed significantly: ${originalLength} -> ${renamedLength} (${(ratio * 100).toFixed(1)}%)`,
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export async function fullValidation(
  renamedCode: string,
): Promise<ValidationResult> {
  const parseResult = await validateCode(renamedCode);

  // Combine all results
  return {
    valid: parseResult.valid,
    errors: [...parseResult.errors],
    warnings: [...parseResult.warnings],
  };
}

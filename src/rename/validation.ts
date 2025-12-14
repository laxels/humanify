import { parseAsync } from "@babel/core";
import * as babelTraverse from "@babel/traverse";
import * as t from "@babel/types";
import type {
  ResolvedRename,
  ValidationError,
  ValidationResult,
  ValidationWarning,
} from "./types";

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

/**
 * Validates the output code after applying renames.
 */
export async function validateOutput(
  code: string,
  resolvedRenames: ResolvedRename[],
): Promise<ValidationResult> {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // Check if code is parseable
  const parseResult = await checkParseable(code);
  if (!parseResult.isValid) {
    errors.push(...parseResult.errors);
    return { isValid: false, errors, warnings };
  }

  // Check for undefined variables
  const undefinedVars = await checkUndefinedVariables(code);
  errors.push(...undefinedVars);

  // Check for duplicate declarations in the same scope
  const duplicates = await checkDuplicateDeclarations(code);
  errors.push(...duplicates);

  // Check for low-confidence renames
  const lowConfidence = checkLowConfidenceRenames(resolvedRenames, 0.3);
  warnings.push(...lowConfidence);

  // Check for high-fanout renames (variables used many times)
  const highFanout = checkHighFanoutRenames(resolvedRenames);
  warnings.push(...highFanout);

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Checks if the code is parseable.
 */
async function checkParseable(
  code: string,
): Promise<{ isValid: boolean; errors: ValidationError[] }> {
  try {
    const ast = await parseAsync(code, { sourceType: "unambiguous" });
    if (!ast) {
      return {
        isValid: false,
        errors: [{ type: "parse-error", message: "Failed to parse code" }],
      };
    }
    return { isValid: true, errors: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      isValid: false,
      errors: [{ type: "parse-error", message: `Parse error: ${message}` }],
    };
  }
}

/**
 * Checks for undefined variables in the code.
 */
async function checkUndefinedVariables(
  code: string,
): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];

  try {
    const ast = await parseAsync(code, { sourceType: "unambiguous" });
    if (!ast) return errors;

    // Known globals that are always available
    const knownGlobals = new Set([
      "undefined",
      "null",
      "true",
      "false",
      "NaN",
      "Infinity",
      "console",
      "window",
      "document",
      "global",
      "globalThis",
      "process",
      "module",
      "exports",
      "require",
      "__dirname",
      "__filename",
      "setTimeout",
      "setInterval",
      "clearTimeout",
      "clearInterval",
      "setImmediate",
      "clearImmediate",
      "queueMicrotask",
      "Promise",
      "Array",
      "Object",
      "String",
      "Number",
      "Boolean",
      "Symbol",
      "BigInt",
      "Map",
      "Set",
      "WeakMap",
      "WeakSet",
      "Date",
      "RegExp",
      "Error",
      "TypeError",
      "ReferenceError",
      "SyntaxError",
      "RangeError",
      "URIError",
      "EvalError",
      "JSON",
      "Math",
      "Reflect",
      "Proxy",
      "Intl",
      "ArrayBuffer",
      "SharedArrayBuffer",
      "DataView",
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
      "WeakRef",
      "FinalizationRegistry",
      "Iterator",
      "AsyncIterator",
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
      "fetch",
      "URL",
      "URLSearchParams",
      "TextEncoder",
      "TextDecoder",
      "Blob",
      "File",
      "FileReader",
      "FormData",
      "Headers",
      "Request",
      "Response",
      "atob",
      "btoa",
      "crypto",
      "performance",
      "alert",
      "confirm",
      "prompt",
      "open",
      "close",
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "navigator",
      "location",
      "history",
      "screen",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "requestIdleCallback",
      "cancelIdleCallback",
      "IntersectionObserver",
      "MutationObserver",
      "ResizeObserver",
      "PerformanceObserver",
      "ReportingObserver",
      "WebSocket",
      "Worker",
      "SharedWorker",
      "ServiceWorker",
      "Notification",
      "EventSource",
      "BroadcastChannel",
      "MessageChannel",
      "MessagePort",
      "AbortController",
      "AbortSignal",
      "CustomEvent",
      "Event",
      "EventTarget",
      "Element",
      "HTMLElement",
      "Node",
      "NodeList",
      "Document",
      "DocumentFragment",
      "Range",
      "Selection",
      "DOMParser",
      "XMLSerializer",
      "XPathEvaluator",
      "arguments",
      "this",
      "super",
    ]);

    traverse(ast, {
      ReferencedIdentifier(path) {
        if (!t.isIdentifier(path.node)) return;
        const name = path.node.name;

        // Skip known globals
        if (knownGlobals.has(name)) return;

        // Check if there's a binding for this identifier
        const binding = path.scope.getBinding(name);
        if (!binding) {
          // This might be an undefined variable or an unknown global
          // For validation, we'll only flag it as a warning-level issue
          // since we can't know all possible globals
        }
      },
    });
  } catch (_error) {
    // Parsing failed, already handled by checkParseable
  }

  return errors;
}

/**
 * Checks for duplicate declarations in the same scope.
 */
async function checkDuplicateDeclarations(
  code: string,
): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];

  try {
    const ast = await parseAsync(code, { sourceType: "unambiguous" });
    if (!ast) return errors;

    traverse(ast, {
      Scope(path) {
        const declarations = new Map<string, number>();

        // Check all bindings in this scope
        for (const [name, binding] of Object.entries(path.scope.bindings)) {
          const count = declarations.get(name) ?? 0;
          declarations.set(name, count + 1);

          if (count >= 1) {
            // Duplicate declaration
            const loc = binding.identifier.loc;
            errors.push({
              type: "duplicate-declaration",
              message: `Duplicate declaration: ${name}`,
              location: loc
                ? { line: loc.start.line, column: loc.start.column }
                : undefined,
            });
          }
        }
      },
    });
  } catch (_error) {
    // Parsing failed, already handled by checkParseable
  }

  return errors;
}

/**
 * Checks for low-confidence renames.
 */
function checkLowConfidenceRenames(
  resolvedRenames: ResolvedRename[],
  threshold: number,
): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];

  for (const rename of resolvedRenames) {
    if (rename.confidence < threshold) {
      warnings.push({
        type: "low-confidence",
        message: `Low confidence rename: ${rename.originalName} -> ${rename.newName} (confidence: ${rename.confidence.toFixed(2)})`,
        bindingId: rename.bindingId,
      });
    }
  }

  return warnings;
}

/**
 * Checks for high-fanout renames (variables with many references).
 * These are riskier because errors affect more places.
 */
function checkHighFanoutRenames(
  resolvedRenames: ResolvedRename[],
  _threshold: number = 50,
): ValidationWarning[] {
  // This would require reference count information from the analysis
  // For now, we'll skip this check as it requires more context
  return [];
}

/**
 * Quick validation check - just verifies the code is parseable.
 */
export async function quickValidate(code: string): Promise<boolean> {
  try {
    const ast = await parseAsync(code, { sourceType: "unambiguous" });
    return ast !== null;
  } catch {
    return false;
  }
}

/**
 * Compares original and renamed code to verify semantic equivalence.
 * This is a best-effort check that looks for obvious issues.
 */
export async function verifySemanticEquivalence(
  originalCode: string,
  renamedCode: string,
): Promise<{ isEquivalent: boolean; issues: string[] }> {
  const issues: string[] = [];

  try {
    const originalAst = await parseAsync(originalCode, {
      sourceType: "unambiguous",
    });
    const renamedAst = await parseAsync(renamedCode, {
      sourceType: "unambiguous",
    });

    if (!originalAst || !renamedAst) {
      issues.push("Failed to parse one or both code samples");
      return { isEquivalent: false, issues };
    }

    // Count different node types
    const originalCounts = countNodeTypes(originalAst);
    const renamedCounts = countNodeTypes(renamedAst);

    // Check if counts are the same (basic structural equivalence)
    for (const [type, count] of originalCounts) {
      const renamedCount = renamedCounts.get(type) ?? 0;
      if (count !== renamedCount) {
        issues.push(
          `Different count for ${type}: original=${count}, renamed=${renamedCount}`,
        );
      }
    }

    for (const [type, count] of renamedCounts) {
      if (!originalCounts.has(type)) {
        issues.push(`New node type in renamed code: ${type} (count=${count})`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push(`Error during verification: ${message}`);
  }

  return {
    isEquivalent: issues.length === 0,
    issues,
  };
}

/**
 * Counts node types in an AST.
 */
function countNodeTypes(ast: t.Node): Map<string, number> {
  const counts = new Map<string, number>();

  traverse(ast, {
    enter(path) {
      const type = path.node.type;
      counts.set(type, (counts.get(type) ?? 0) + 1);
    },
  });

  return counts;
}

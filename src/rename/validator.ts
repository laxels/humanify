import { parseAsync } from "@babel/core";
import * as babelTraverse from "@babel/traverse";
import { RESERVED_WORDS } from "./constraint-solver";

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
  errors: ValidationError[];
  warnings: ValidationWarning[];
};

export type ValidationError = {
  type:
    | "parse_error"
    | "undefined_reference"
    | "duplicate_declaration"
    | "reserved_word";
  message: string;
  location?: { line: number; column: number };
};

export type ValidationWarning = {
  type: "suspicious_name" | "low_confidence" | "shadowing";
  message: string;
  location?: { line: number; column: number };
};

/**
 * Validates that the code is parseable.
 */
export async function validateParseable(
  code: string,
): Promise<{ valid: boolean; error?: string }> {
  try {
    const ast = await parseAsync(code, { sourceType: "unambiguous" });
    if (!ast) {
      return { valid: false, error: "Failed to parse code" };
    }
    return { valid: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { valid: false, error: message };
  }
}

/**
 * Checks for undefined references in the code.
 */
export async function findUndefinedReferences(code: string): Promise<string[]> {
  const ast = await parseAsync(code, { sourceType: "unambiguous" });
  if (!ast) return [];

  const undefinedRefs: string[] = [];

  // Common globals that are expected to be undefined
  const knownGlobals = new Set([
    // Browser globals
    "window",
    "document",
    "console",
    "navigator",
    "location",
    "history",
    "localStorage",
    "sessionStorage",
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "clearInterval",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "Promise",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "Symbol",
    "Proxy",
    "Reflect",
    "JSON",
    "Math",
    "Date",
    "RegExp",
    "Error",
    "TypeError",
    "SyntaxError",
    "ReferenceError",
    "Array",
    "Object",
    "String",
    "Number",
    "Boolean",
    "Function",
    "parseInt",
    "parseFloat",
    "isNaN",
    "isFinite",
    "encodeURI",
    "decodeURI",
    "encodeURIComponent",
    "decodeURIComponent",
    "escape",
    "unescape",
    "Infinity",
    "NaN",
    "undefined",
    "null",
    // Node.js globals
    "process",
    "global",
    "Buffer",
    "require",
    "module",
    "exports",
    "__dirname",
    "__filename",
    "setImmediate",
    "clearImmediate",
    // ES6+ globals
    "Intl",
    "ArrayBuffer",
    "DataView",
    "Float32Array",
    "Float64Array",
    "Int8Array",
    "Int16Array",
    "Int32Array",
    "Uint8Array",
    "Uint16Array",
    "Uint32Array",
    "Uint8ClampedArray",
    "BigInt",
    "BigInt64Array",
    "BigUint64Array",
    "globalThis",
    "queueMicrotask",
    "structuredClone",
    "atob",
    "btoa",
    // Common library globals
    "jQuery",
    "$",
    "React",
    "ReactDOM",
    "Vue",
    "angular",
  ]);

  traverse(ast, {
    ReferencedIdentifier(path) {
      const name = path.node.name;

      // Skip known globals
      if (knownGlobals.has(name)) return;

      // Skip if it's bound in some scope
      if (path.scope.hasBinding(name)) return;

      // This reference is undefined
      undefinedRefs.push(name);
    },
  });

  return [...new Set(undefinedRefs)];
}

/**
 * Checks for duplicate declarations in the same scope.
 */
export async function findDuplicateDeclarations(
  code: string,
): Promise<Array<{ name: string; scopeId: string }>> {
  const ast = await parseAsync(code, { sourceType: "unambiguous" });
  if (!ast) return [];

  const duplicates: Array<{ name: string; scopeId: string }> = [];
  const declarationsByScope = new Map<string, Set<string>>();

  traverse(ast, {
    BindingIdentifier(path) {
      const name = path.node.name;
      const scopeId = String(path.scope.uid);

      // Get or create the set for this scope
      let scopeDeclarations = declarationsByScope.get(scopeId);
      if (!scopeDeclarations) {
        scopeDeclarations = new Set();
        declarationsByScope.set(scopeId, scopeDeclarations);
      }

      // Check for duplicate
      if (scopeDeclarations.has(name)) {
        // This could be legitimate (function overloading, etc.) so just record it
        duplicates.push({ name, scopeId });
      }

      scopeDeclarations.add(name);
    },
  });

  return duplicates;
}

/**
 * Checks for reserved words used as identifiers.
 */
export async function findReservedWordUsage(code: string): Promise<string[]> {
  const ast = await parseAsync(code, { sourceType: "unambiguous" });
  if (!ast) return [];

  const reservedUsed: string[] = [];

  traverse(ast, {
    Identifier(path) {
      const name = path.node.name;

      if (RESERVED_WORDS.has(name)) {
        // Check if it's actually used as an identifier (not a property key, etc.)
        const parent = path.parentPath;

        // Property access on the right side is okay: obj.class
        if (
          parent?.isMemberExpression() &&
          parent.node.property === path.node &&
          !parent.node.computed
        ) {
          return;
        }

        // Object property key is okay: { class: value }
        if (
          parent?.isObjectProperty() &&
          parent.node.key === path.node &&
          !parent.node.computed
        ) {
          return;
        }

        // Method definition key is okay: class { static() {} }
        if (parent?.isClassMethod() || parent?.isObjectMethod()) {
          return;
        }

        reservedUsed.push(name);
      }
    },
  });

  return [...new Set(reservedUsed)];
}

/**
 * Finds cases where a variable shadows another in an outer scope.
 */
export async function findShadowing(
  code: string,
): Promise<Array<{ name: string; innerScope: string; outerScope: string }>> {
  const ast = await parseAsync(code, { sourceType: "unambiguous" });
  if (!ast) return [];

  const shadowing: Array<{
    name: string;
    innerScope: string;
    outerScope: string;
  }> = [];

  traverse(ast, {
    BindingIdentifier(path) {
      const name = path.node.name;
      const scope = path.scope;

      // Check if this name exists in a parent scope
      let parentScope = scope.parent;
      while (parentScope) {
        if (parentScope.hasOwnBinding(name)) {
          shadowing.push({
            name,
            innerScope: String(scope.uid),
            outerScope: String(parentScope.uid),
          });
          break;
        }
        parentScope = parentScope.parent;
      }
    },
  });

  return shadowing;
}

/**
 * Checks for suspicious identifier names that might indicate poor renaming.
 */
export function findSuspiciousNames(code: string): string[] {
  // Patterns that might indicate poor renaming
  const suspiciousPatterns = [
    /^_+$/, // All underscores
    /^[a-z]$/, // Single letter
    /^[a-z]\d+$/, // Letter followed by digits
    /^temp\d*$/i, // temp, temp1, temp2
    /^var\d+$/i, // var1, var2
    /^arg\d+$/i, // arg1, arg2
    /^param\d+$/i, // param1, param2
    /^unnamed\d*$/i, // unnamed
    /thisKLength/i, // Common LLM failure mode
    /fooBar/i, // Placeholder names
  ];

  const suspicious: string[] = [];

  // Simple regex-based extraction of identifiers
  const identifierRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g;

  for (const match of code.matchAll(identifierRegex)) {
    const name = match[1];
    if (!name) continue;

    for (const pattern of suspiciousPatterns) {
      if (pattern.test(name)) {
        suspicious.push(name);
        break;
      }
    }
  }

  return [...new Set(suspicious)];
}

/**
 * Performs comprehensive validation of renamed code.
 */
export async function validateRenamedCode(
  code: string,
): Promise<ValidationResult> {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // Check parseability
  const parseResult = await validateParseable(code);
  if (!parseResult.valid) {
    errors.push({
      type: "parse_error",
      message: parseResult.error || "Code is not parseable",
    });
    return { valid: false, errors, warnings };
  }

  // Check for undefined references
  const undefinedRefs = await findUndefinedReferences(code);
  for (const ref of undefinedRefs) {
    errors.push({
      type: "undefined_reference",
      message: `Undefined reference: ${ref}`,
    });
  }

  // Check for reserved words
  const reservedWords = await findReservedWordUsage(code);
  for (const word of reservedWords) {
    errors.push({
      type: "reserved_word",
      message: `Reserved word used as identifier: ${word}`,
    });
  }

  // Check for duplicate declarations (as warnings, since they might be legitimate)
  const duplicates = await findDuplicateDeclarations(code);
  for (const dup of duplicates) {
    warnings.push({
      type: "shadowing",
      message: `Potential duplicate declaration: ${dup.name} in scope ${dup.scopeId}`,
    });
  }

  // Check for shadowing
  const shadowings = await findShadowing(code);
  for (const shadow of shadowings) {
    warnings.push({
      type: "shadowing",
      message: `Variable "${shadow.name}" shadows outer scope variable`,
    });
  }

  // Check for suspicious names
  const suspicious = findSuspiciousNames(code);
  for (const name of suspicious) {
    warnings.push({
      type: "suspicious_name",
      message: `Suspicious identifier name: ${name}`,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Quick validation that just checks parseability and critical errors.
 */
export async function quickValidate(
  code: string,
): Promise<{ valid: boolean; error?: string }> {
  const parseResult = await validateParseable(code);
  if (!parseResult.valid) {
    return parseResult;
  }

  // Check for reserved words as that's a critical error
  const reservedWords = await findReservedWordUsage(code);
  if (reservedWords.length > 0) {
    return {
      valid: false,
      error: `Reserved words used as identifiers: ${reservedWords.join(", ")}`,
    };
  }

  return { valid: true };
}

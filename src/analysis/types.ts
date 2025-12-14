import type { NodePath } from "@babel/core";
import type { Identifier } from "@babel/types";

/**
 * Unique identifier for a binding in the symbol table.
 * Format: "scope_uid:binding_name" to ensure uniqueness across scopes.
 */
export type BindingId = string;

/**
 * Kind of declaration for a binding.
 */
export type DeclarationKind =
  | "var"
  | "let"
  | "const"
  | "function"
  | "class"
  | "param"
  | "catch"
  | "import";

/**
 * Describes how an identifier is used at a particular location.
 */
export type UseSiteKind =
  | "call" // foo()
  | "property_access" // foo.bar
  | "computed_access" // foo[x]
  | "assignment" // foo = x
  | "arithmetic" // foo + x
  | "comparison" // foo === x
  | "logical" // foo && x
  | "await" // await foo
  | "typeof" // typeof foo
  | "instanceof" // foo instanceof X or X instanceof foo
  | "spread" // ...foo
  | "template" // `${foo}`
  | "return" // return foo
  | "throw" // throw foo
  | "conditional" // foo ? a : b
  | "new" // new foo()
  | "shorthand_property" // { foo }
  | "method_call" // x.foo()
  | "other";

/**
 * A single use site of a binding.
 */
export type UseSite = {
  kind: UseSiteKind;
  /** The surrounding expression/statement as a string (truncated if too long) */
  context: string;
  /** For property accesses: the property name being accessed */
  propertyName?: string;
  /** For method calls: the method name being called */
  methodName?: string;
  /** For calls: argument count */
  argCount?: number;
};

/**
 * Type hints inferred from usage patterns.
 */
export type TypeHints = {
  /** Methods called on this value (e.g., ["map", "filter", "reduce"] suggests array) */
  methodsCalled: string[];
  /** Properties accessed on this value */
  propertiesAccessed: string[];
  /** Whether this is called as a function */
  isCalledAsFunction: boolean;
  /** Whether this is used with `new` */
  isConstructed: boolean;
  /** Whether this is awaited */
  isAwaited: boolean;
  /** Whether this appears in a typeof check */
  hasTypeofCheck: boolean;
  /** Whether this is used in instanceof */
  hasInstanceofCheck: boolean;
  /** Inferred type based on patterns (best guess) */
  inferredType?:
    | "array"
    | "function"
    | "promise"
    | "object"
    | "string"
    | "number"
    | "boolean"
    | "class";
};

/**
 * Complete information about a binding, used for LLM context.
 */
export type SymbolDossier = {
  /** Unique identifier for this binding */
  id: BindingId;
  /** Original name in the minified code */
  originalName: string;
  /** How this identifier was declared */
  declarationKind: DeclarationKind;
  /** The immediate surrounding code of the declaration */
  declarationContext: string;
  /** Summary of all use sites */
  useSites: UseSite[];
  /** Inferred type hints */
  typeHints: TypeHints;
  /** The scope UID where this binding is declared */
  scopeId: string;
  /** Whether this binding is exported */
  isExported: boolean;
  /** Whether renaming this binding might be unsafe (e.g., eval in scope) */
  isUnsafe: boolean;
  /** Reason why renaming might be unsafe */
  unsafeReason?: string;
};

/**
 * Information about a scope in the scope tree.
 */
export type ScopeInfo = {
  /** Unique identifier for this scope */
  id: string;
  /** Parent scope ID (null for program scope) */
  parentId: string | null;
  /** Kind of scope */
  kind: "program" | "function" | "class" | "block" | "module";
  /** A summary of what this scope does (function name, class name, etc.) */
  summary: string;
  /** IDs of bindings declared in this scope */
  bindingIds: BindingId[];
  /** The code for this entire scope (may be truncated for large scopes) */
  code: string;
  /** Size of the scope in characters (for sorting) */
  size: number;
};

/**
 * The complete symbol table for a parsed file.
 */
export type SymbolTable = {
  /** All bindings indexed by their ID */
  bindings: Map<BindingId, SymbolDossier>;
  /** All scopes indexed by their ID */
  scopes: Map<string, ScopeInfo>;
  /** Root scope ID (the program scope) */
  rootScopeId: string;
};

/**
 * A candidate name suggested by the LLM for a binding.
 */
export type NameCandidate = {
  name: string;
  confidence: number; // 0-1
  rationale: string;
};

/**
 * LLM response for a batch of symbol renames.
 */
export type BatchRenameResult = {
  renames: {
    bindingId: BindingId;
    candidates: NameCandidate[];
  }[];
};

/**
 * The final selected name for a binding after constraint solving.
 */
export type ResolvedRename = {
  bindingId: BindingId;
  originalName: string;
  newName: string;
  confidence: number;
};

/**
 * Internal representation used during AST traversal.
 */
export type BindingInfo = {
  path: NodePath<Identifier>;
  declarationKind: DeclarationKind;
  scopeUid: string;
};

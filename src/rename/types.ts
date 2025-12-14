import type { Node } from "@babel/types";

/**
 * Unique identifier for a binding in the symbol table.
 * Format: `scope_${scopeId}_binding_${index}`
 */
export type BindingId = string;

/**
 * Unique identifier for a scope in the scope tree.
 * Format: `scope_${index}` or `scope_program`
 */
export type ScopeId = string;

/**
 * The kind of declaration that created a binding.
 */
export type BindingKind =
  | "param"
  | "const"
  | "let"
  | "var"
  | "function"
  | "class"
  | "catch"
  | "import";

/**
 * How an identifier reference is used.
 */
export type ReferenceType =
  | "read"
  | "write"
  | "call"
  | "property-access"
  | "shorthand"
  | "export";

/**
 * A reference to a binding (a use site).
 */
export type Reference = {
  /** The identifier node in the AST */
  node: Node;
  /** How the identifier is used */
  type: ReferenceType;
  /** Additional context (e.g., property name for property access) */
  context?: string;
};

/**
 * A hint about how a symbol is used, derived from static analysis.
 */
export type UsageHint = {
  /** Description of the usage pattern */
  hint: string;
  /** How many times this pattern was observed */
  count: number;
};

/**
 * A binding in the symbol table (a declared identifier).
 */
export type SymbolBinding = {
  /** Unique identifier for this binding */
  id: BindingId;
  /** Original name of the identifier */
  name: string;
  /** Kind of declaration */
  kind: BindingKind;
  /** ID of the scope this binding belongs to */
  scopeId: ScopeId;
  /** The declaration node in the AST */
  declarationNode: Node;
  /** All references to this binding */
  references: Reference[];
  /** Usage hints derived from static analysis */
  usageHints: UsageHint[];
  /** Surrounding code context for LLM */
  surroundingCode: string;
  /** Whether this binding is exported */
  isExported: boolean;
  /** Whether this binding is used in dynamic contexts (eval, with) */
  hasDynamicAccess: boolean;
};

/**
 * Information about a lexical scope.
 */
export type ScopeInfo = {
  /** Unique identifier for this scope */
  id: ScopeId;
  /** Parent scope ID, null for program scope */
  parentId: ScopeId | null;
  /** Kind of scope */
  kind: "program" | "function" | "block" | "class" | "module";
  /** IDs of bindings declared in this scope */
  bindingIds: BindingId[];
  /** IDs of child scopes */
  childScopeIds: ScopeId[];
  /** Summary of what this scope does (for functions/classes) */
  summary?: string;
  /** The AST node that creates this scope */
  node: Node;
  /** Start position in source */
  start: number;
  /** End position in source */
  end: number;
};

/**
 * A candidate name suggested by the LLM.
 */
export type NameCandidate = {
  /** The suggested name */
  name: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Brief rationale for the suggestion */
  rationale: string;
};

/**
 * Result from LLM naming for a single symbol.
 */
export type SymbolNamingResult = {
  /** The binding this result is for */
  bindingId: BindingId;
  /** Candidate names in order of preference */
  candidates: NameCandidate[];
};

/**
 * A resolved rename after constraint solving.
 */
export type ResolvedRename = {
  /** The binding being renamed */
  bindingId: BindingId;
  /** Original name */
  originalName: string;
  /** New name after constraint resolution */
  newName: string;
  /** Confidence of the chosen name */
  confidence: number;
};

/**
 * The complete symbol dossier for a binding, used as LLM input.
 */
export type SymbolDossier = {
  /** Binding ID */
  id: BindingId;
  /** Current name */
  name: string;
  /** Declaration kind */
  kind: BindingKind;
  /** Surrounding code context */
  surroundingCode: string;
  /** Summary of all use sites */
  useSummary: string;
  /** Type-ish hints */
  typeHints: string[];
};

/**
 * A batch of symbols to be named together (usually from the same scope).
 */
export type NamingBatch = {
  /** Scope summary/description */
  scopeSummary: string;
  /** Scope ID */
  scopeId: ScopeId;
  /** Symbol dossiers in this batch */
  symbols: SymbolDossier[];
};

/**
 * Result of the complete symbol analysis phase.
 */
export type SymbolAnalysisResult = {
  /** Map of scope ID to scope info */
  scopes: Map<ScopeId, ScopeInfo>;
  /** Map of binding ID to binding info */
  bindings: Map<BindingId, SymbolBinding>;
  /** The root scope ID (program) */
  rootScopeId: ScopeId;
  /** Whether any dynamic features (eval, with) were detected */
  hasDynamicFeatures: boolean;
  /** The parsed AST */
  ast: Node;
};

/**
 * Options for symbol analysis.
 */
export type SymbolAnalysisOptions = {
  /** Maximum lines of surrounding code to include */
  contextLines?: number;
};

/**
 * Options for LLM naming.
 */
export type LLMNamingOptions = {
  /** Model to use */
  model?: string;
  /** Maximum symbols per batch */
  batchSize?: number;
  /** Number of candidate names to request per symbol */
  candidatesPerSymbol?: number;
};

/**
 * Options for constraint solving.
 */
export type ConstraintSolverOptions = {
  /** Enforce camelCase for variables/functions */
  enforceCamelCase?: boolean;
  /** Enforce PascalCase for classes */
  enforcePascalCase?: boolean;
  /** Enforce UPPER_SNAKE_CASE for constants */
  enforceConstantCase?: boolean;
  /** Minimum confidence to accept a rename */
  minConfidence?: number;
};

/**
 * Validation result after applying renames.
 */
export type ValidationResult = {
  /** Whether the output is valid */
  isValid: boolean;
  /** Any errors found */
  errors: ValidationError[];
  /** Any warnings */
  warnings: ValidationWarning[];
};

export type ValidationError = {
  type: "parse-error" | "undefined-var" | "duplicate-declaration";
  message: string;
  location?: { line: number; column: number };
};

export type ValidationWarning = {
  type: "suspicious-rename" | "low-confidence" | "high-fanout";
  message: string;
  bindingId?: BindingId;
};

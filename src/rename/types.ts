import type { NodePath } from "@babel/core";
import type { Identifier, Node } from "@babel/types";

export type SymbolKind =
  | "param"
  | "function"
  | "class"
  | "var"
  | "let"
  | "const"
  | "import"
  | "catch"
  | "unknown";

export type NamingUnitKind = "program" | "function" | "class";

export type NamingStyle = "camelCase" | "pascalCase" | "upperSnakeCase";

export type CandidateName = {
  name: string;
  confidence: number;
  rationale?: string;
};

export type SymbolSuggestion = {
  id: string;
  candidates: CandidateName[];
};

export type RenameSymbol = {
  id: string;
  originalName: string;
  kind: SymbolKind;

  bindingPath: NodePath<Identifier>;
  /**
   * Babel binding for this symbol (untyped because Babel's Binding type isn't
   * exported in a stable way).
   */
  binding: any;

  /** Babel lexical scope where this symbol is declared. */
  scope: any;
  scopeId: string;

  /** Naming unit (program/function/class) used for batching LLM calls. */
  unitId: string;
  unitKind: NamingUnitKind;
  unitPath: NodePath<Node>;

  /** Higher means more important to name well (more fan-out, etc.). */
  importance: number;
};

export type NamingUnit = {
  id: string;
  kind: NamingUnitKind;
  /** Optional display name (function/class name, method key, etc.). */
  displayName?: string;
  /** A truncated snippet of the unit's code (for LLM context). */
  snippet: string;
  /** Symbols belonging to this unit. */
  symbols: RenameSymbol[];
};

export type NamingUnitSummary = {
  id: string;
  kind: NamingUnitKind;
  displayName?: string;
  snippet: string;
};

export type ScopeMeta = {
  id: string;
  scope: any;
  parentId?: string;
  depth: number;
};

export type SymbolDossier = {
  id: string;
  originalName: string;
  kind: SymbolKind;

  declaration: string;

  referenceCount: number;
  writeCount: number;

  memberAccesses: Array<{ name: string; count: number }>;

  callInfo: {
    callCount: number;
    awaitedCount: number;
    argCounts: Array<{ count: number; occurrences: number }>;
  };

  newCount: number;

  passedTo: Array<{ callee: string; count: number }>;

  binaryOps: Array<{ op: string; count: number }>;

  comparedToLiterals: Array<{ literal: string; count: number }>;

  typeHints: string[];
};

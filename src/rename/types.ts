import type { Identifier, Node } from "@babel/types";
import type { Binding, NodePath, Scope } from "../babel-traverse";

export type SymbolId = string;
export type ScopeId = string;
export type ChunkId = string;

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

export type CandidateName = {
  name: string;
  confidence: number; // 0..1
  rationale?: string;
};

export type SymbolInfo = {
  id: SymbolId;
  originalName: string;
  kind: SymbolKind;

  // Babel binding for this symbol. Used for reference analysis and applying renames.
  binding: Binding;
  declIdPath: NodePath<Identifier>;

  declScope: Scope;
  declScopeId: ScopeId;

  // Chunk (function/program) used for batched LLM calls.
  chunkId: ChunkId;

  // Tainted scopes are conservatively skipped due to dynamic features (eval/with/Function).
  isTainted: boolean;

  // Export metadata used for prompt/context and for preserving export interfaces.
  isExported: boolean;
  isDirectlyExportedDeclaration: boolean;

  referenceCount: number;
};

export type ChunkKind = "program" | "function" | "class";

export type ChunkInfo = {
  id: ChunkId;
  kind: ChunkKind;
  scopeId: ScopeId;
  summary: string;
  symbolIds: SymbolId[];
};

export type RenamingAnalysis = {
  ast: Node;
  code: string;

  symbols: Map<SymbolId, SymbolInfo>;
  chunks: Map<ChunkId, ChunkInfo>;

  bindingToSymbolId: Map<Binding, SymbolId>;
  taintedScopeIds: Set<ScopeId>;
};

export type SymbolDossier = {
  id: SymbolId;
  originalName: string;
  kind: SymbolKind;
  isExported: boolean;
  declarationSnippet: string;
  usageSummary: string;
  typeHints: string[];
};

export type ScopeSuggestionRequest = {
  chunk: ChunkInfo;
  dossiers: SymbolDossier[];
  maxCandidates: number;
};

export type ScopeSuggestionResponse = {
  suggestions: Array<{
    id: SymbolId;
    candidates: CandidateName[];
  }>;
};

export type NameSuggestionProvider = (
  req: ScopeSuggestionRequest,
) => Promise<ScopeSuggestionResponse>;

export type RenamePlan = Map<SymbolId, string>;

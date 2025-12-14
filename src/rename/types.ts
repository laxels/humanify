export type SymbolId = string;
export type ScopeChunkId = string;
export type ScopeId = string;

export type DeclarationKind =
  | "param"
  | "const"
  | "let"
  | "var"
  | "function"
  | "class"
  | "catch"
  | "import"
  | "unknown";

export type NameStyle = "camel" | "pascal" | "upper_snake";

export type SymbolUsageSummary = {
  referenceCount: number;
  isCalled: boolean;
  isConstructed: boolean;
  isAwaited: boolean;
  isIterated: boolean;
  isReturned: boolean;
  isAssignedTo: boolean;

  unaryOperators: string[];
  binaryOperators: string[];
  comparedWith: string[];

  memberReads: string[];
  memberWrites: string[];
  calledMethods: string[];
};

export type SymbolDossier = {
  symbolId: SymbolId;
  originalName: string;
  declarationKind: DeclarationKind;
  nameStyle: NameStyle;

  isConstant: boolean;
  isExported: boolean;
  isImported: boolean;
  isUnsafeToRename: boolean;

  declarationSnippet: string;
  usageSummary: SymbolUsageSummary;
  typeHints: string[];
};

export type NameCandidate = {
  name: string;
  confidence: number;
  rationale?: string;
};

export type SymbolNameSuggestion = {
  symbolId: SymbolId;
  candidates: NameCandidate[];
};

export type SuggestNamesInput = {
  chunkId: ScopeChunkId;
  scopeSummary: string;
  symbols: SymbolDossier[];
};

export type SuggestNames = (
  input: SuggestNamesInput,
) => Promise<SymbolNameSuggestion[]>;
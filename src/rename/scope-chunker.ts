import generate from "@babel/generator";
import type { SymbolDossier } from "./symbol-dossier";
import { formatDossierForLLM } from "./symbol-dossier";
import type {
  ScopeId,
  ScopeInfo,
  SymbolInfo,
  SymbolTable,
} from "./symbol-table";
import { isSymbolSafeToRename } from "./symbol-table";

export type ScopeChunk = {
  scopeId: ScopeId;
  scopeSummary: string;
  scopeCode: string;
  symbols: SymbolInfo[];
  dossiers: SymbolDossier[];
  formattedPrompt: string;
};

export type ChunkingOptions = {
  maxSymbolsPerChunk: number;
  maxContextLength: number;
};

const DEFAULT_CHUNKING_OPTIONS: ChunkingOptions = {
  maxSymbolsPerChunk: 10,
  maxContextLength: 4000,
};

function getScopeCode(scope: ScopeInfo, maxLength: number): string {
  try {
    const code = generate(scope.path.node, { compact: false }).code;
    if (code.length <= maxLength) {
      return code;
    }
    return code.slice(0, maxLength) + "\n// ... (truncated)";
  } catch {
    return "";
  }
}

function getScopeSummary(scope: ScopeInfo): string {
  const node = scope.path.node;

  if (scope.path.isProgram()) {
    return "Program/Module scope";
  }

  if (scope.path.isFunctionDeclaration()) {
    const funcNode = scope.path.node;
    if (funcNode.id?.type === "Identifier") {
      return `Function: ${funcNode.id.name}`;
    }
  }

  if (scope.path.isFunctionExpression()) {
    const funcNode = scope.path.node;
    if (funcNode.id?.type === "Identifier") {
      return `Function expression: ${funcNode.id.name}`;
    }
  }

  if (scope.path.isArrowFunctionExpression()) {
    return "Arrow function";
  }

  if (scope.path.isClassDeclaration()) {
    const classNode = scope.path.node;
    if (classNode.id?.type === "Identifier") {
      return `Class: ${classNode.id.name}`;
    }
  }

  if (
    scope.path.isClassMethod() &&
    "key" in node &&
    node.key.type === "Identifier"
  ) {
    return `Method: ${node.key.name}`;
  }

  if (scope.path.isBlockStatement()) {
    const parent = scope.path.parentPath;
    if (parent?.isIfStatement()) {
      return "if block";
    }
    if (
      parent?.isForStatement() ||
      parent?.isForInStatement() ||
      parent?.isForOfStatement()
    ) {
      return "for loop block";
    }
    if (parent?.isWhileStatement() || parent?.isDoWhileStatement()) {
      return "while loop block";
    }
    if (parent?.isTryStatement()) {
      return "try block";
    }
    if (parent?.isCatchClause()) {
      return "catch block";
    }
  }

  return "Block scope";
}

export function chunkByScope(
  table: SymbolTable,
  dossiers: Map<string, SymbolDossier>,
  options: Partial<ChunkingOptions> = {},
): ScopeChunk[] {
  const opts = { ...DEFAULT_CHUNKING_OPTIONS, ...options };
  const chunks: ScopeChunk[] = [];

  // Group symbols by scope
  const symbolsByScope = new Map<ScopeId, SymbolInfo[]>();

  for (const symbol of table.symbols.values()) {
    // Skip unsafe symbols
    if (!isSymbolSafeToRename(table, symbol.id)) {
      continue;
    }

    const scopeSymbols = symbolsByScope.get(symbol.scopeId) || [];
    scopeSymbols.push(symbol);
    symbolsByScope.set(symbol.scopeId, scopeSymbols);
  }

  // Create chunks for each scope, potentially splitting large scopes
  for (const [scopeId, symbols] of symbolsByScope) {
    const scope = table.scopes.get(scopeId);
    if (!scope) continue;

    const scopeSummary = getScopeSummary(scope);
    const scopeCode = getScopeCode(scope, opts.maxContextLength);

    // Split into sub-chunks if too many symbols
    for (let i = 0; i < symbols.length; i += opts.maxSymbolsPerChunk) {
      const chunkSymbols = symbols.slice(i, i + opts.maxSymbolsPerChunk);
      const chunkDossiers = chunkSymbols
        .map((s) => dossiers.get(s.id))
        .filter((d): d is SymbolDossier => d !== undefined);

      const formattedPrompt = formatChunkPrompt(
        scopeSummary,
        scopeCode,
        chunkDossiers,
      );

      chunks.push({
        scopeId,
        scopeSummary,
        scopeCode,
        symbols: chunkSymbols,
        dossiers: chunkDossiers,
        formattedPrompt,
      });
    }
  }

  // Sort chunks by scope size (largest first) to process outer scopes before inner
  chunks.sort((a, b) => {
    const scopeA = table.scopes.get(a.scopeId);
    const scopeB = table.scopes.get(b.scopeId);
    if (!scopeA || !scopeB) return 0;

    const sizeA = (scopeA.path.node.end ?? 0) - (scopeA.path.node.start ?? 0);
    const sizeB = (scopeB.path.node.end ?? 0) - (scopeB.path.node.start ?? 0);

    return sizeB - sizeA;
  });

  return chunks;
}

function formatChunkPrompt(
  scopeSummary: string,
  scopeCode: string,
  dossiers: SymbolDossier[],
): string {
  const lines: string[] = [];

  lines.push(`## Scope: ${scopeSummary}`);
  lines.push("");
  lines.push("```javascript");
  lines.push(scopeCode);
  lines.push("```");
  lines.push("");
  lines.push("## Symbols to rename:");
  lines.push("");

  for (const dossier of dossiers) {
    lines.push(formatDossierForLLM(dossier));
    lines.push("");
  }

  return lines.join("\n");
}

export function groupChunksForParallelProcessing(
  chunks: ScopeChunk[],
  table: SymbolTable,
): ScopeChunk[][] {
  // Group chunks that can be processed in parallel
  // Chunks from the same scope or nested scopes must be sequential
  // Chunks from sibling scopes can be parallel

  const groups: ScopeChunk[][] = [];
  const processedScopeIds = new Set<ScopeId>();

  // Helper to check if a scope is an ancestor of another
  const isAncestor = (
    potentialAncestor: ScopeId,
    scopeId: ScopeId,
  ): boolean => {
    let current = table.scopes.get(scopeId);
    while (current) {
      if (current.parentId === potentialAncestor) {
        return true;
      }
      current = current.parentId
        ? table.scopes.get(current.parentId)
        : undefined;
    }
    return false;
  };

  // Process chunks in order (already sorted by scope size)
  for (const chunk of chunks) {
    // Check if this chunk can be added to an existing parallel group
    let addedToGroup = false;

    for (const group of groups) {
      const canAddToGroup = group.every((existingChunk) => {
        // Cannot be in same group if same scope or if one is ancestor of other
        if (existingChunk.scopeId === chunk.scopeId) return false;
        if (isAncestor(existingChunk.scopeId, chunk.scopeId)) return false;
        if (isAncestor(chunk.scopeId, existingChunk.scopeId)) return false;
        return true;
      });

      if (canAddToGroup) {
        group.push(chunk);
        addedToGroup = true;
        break;
      }
    }

    if (!addedToGroup) {
      groups.push([chunk]);
    }

    processedScopeIds.add(chunk.scopeId);
  }

  return groups;
}

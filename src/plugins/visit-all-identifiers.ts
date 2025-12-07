import { type NodePath, parseAsync, transformFromAstAsync } from "@babel/core";
import * as babelTraverse from "@babel/traverse";
import { type Identifier, type Node, toIdentifier } from "@babel/types";

const traverse = (
  typeof (babelTraverse as unknown as { default?: unknown }).default === "function"
    ? (babelTraverse as unknown as { default: typeof babelTraverse.default }).default
    : (babelTraverse as unknown as { default: { default: typeof babelTraverse.default } }).default.default
) as typeof babelTraverse.default;

type Visitor = (name: string, scope: string) => Promise<string>;

export async function visitAllIdentifiers(
  code: string,
  visitor: Visitor,
  contextWindowSize: number,
  onProgress?: (done: number, total: number) => void,
) {
  const ast = await parseAsync(code, { sourceType: "unambiguous" });
  const renames = new Set<string>();
  const visited = new Set<string>();

  if (!ast) {
    throw new Error("Failed to parse code");
  }

  const scopes = await findScopes(ast);
  const numRenamesExpected = scopes.length;

  for (const smallestScope of scopes) {
    if (hasVisited(smallestScope, visited)) continue;

    const smallestScopeNode = smallestScope.node;
    if (smallestScopeNode.type !== "Identifier") {
      throw new Error("No identifiers found");
    }

    const surroundingCode = await scopeToString(
      smallestScope,
      contextWindowSize,
    );
    const renamed = await visitor(smallestScopeNode.name, surroundingCode);
    if (renamed !== smallestScopeNode.name) {
      let safeRenamed = toIdentifier(renamed);
      while (
        renames.has(safeRenamed) ||
        smallestScope.scope.hasBinding(safeRenamed)
      ) {
        safeRenamed = `_${safeRenamed}`;
      }
      renames.add(safeRenamed);

      smallestScope.scope.rename(smallestScopeNode.name, safeRenamed);
    }
    markVisited(smallestScope, smallestScopeNode.name, visited);

    onProgress?.(visited.size, numRenamesExpected);
  }
  onProgress?.(numRenamesExpected, numRenamesExpected);

  const stringified = await transformFromAstAsync(ast);
  if (stringified?.code == null) {
    throw new Error("Failed to stringify code");
  }
  return stringified.code;
}

function findScopes(ast: Node): NodePath<Identifier>[] {
  const scopes: [nodePath: NodePath<Identifier>, scopeSize: number][] = [];
  traverse(ast, {
    BindingIdentifier(path: NodePath<Identifier>) {
      const bindingBlock = closestSurroundingContextPath(path).scope.block;
      const pathSize = bindingBlock.end! - bindingBlock.start!;

      scopes.push([path, pathSize]);
    },
  });

  scopes.sort((a, b) => b[1] - a[1]);

  return scopes.map(([nodePath]) => nodePath);
}

function hasVisited(path: NodePath<Identifier>, visited: Set<string>) {
  return visited.has(path.node.name);
}

function markVisited(
  path: NodePath<Identifier>,
  newName: string,
  visited: Set<string>,
) {
  visited.add(newName);
}

async function scopeToString(
  path: NodePath<Identifier>,
  contextWindowSize: number,
) {
  const surroundingPath = closestSurroundingContextPath(path);
  const code = `${surroundingPath}`; // Implements a hidden `.toString()`
  if (code.length < contextWindowSize) {
    return code;
  }
  if (surroundingPath.isProgram()) {
    const start = path.node.start ?? 0;
    const end = path.node.end ?? code.length;
    if (end < contextWindowSize / 2) {
      return code.slice(0, contextWindowSize);
    }
    if (start > code.length - contextWindowSize / 2) {
      return code.slice(-contextWindowSize);
    }

    return code.slice(
      start - contextWindowSize / 2,
      end + contextWindowSize / 2,
    );
  } else {
    return code.slice(0, contextWindowSize);
  }
}

function closestSurroundingContextPath(
  path: NodePath<Identifier>,
): NodePath<Node> {
  const programOrBindingNode = path.findParent(
    (p) => p.isProgram() || path.node.name in p.getOuterBindingIdentifiers(),
  )?.scope.path;
  return programOrBindingNode ?? path.scope.path;
}

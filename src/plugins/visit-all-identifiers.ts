import { type NodePath, parseAsync, transformFromAstAsync } from "@babel/core";
import * as babelTraverse from "@babel/traverse";
import { type Identifier, type Node, toIdentifier } from "@babel/types";

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

  const bindingPaths = findBindingIdentifiers(ast);
  const numRenamesExpected = bindingPaths.length;

  for (const bindingPath of bindingPaths) {
    if (hasVisited(bindingPath, visited)) continue;

    const identifierNode = bindingPath.node;
    if (identifierNode.type !== "Identifier") {
      throw new Error("No identifiers found");
    }

    const surroundingCode = scopeToString(bindingPath, contextWindowSize);
    const renamed = await visitor(identifierNode.name, surroundingCode);
    if (renamed !== identifierNode.name) {
      let safeRenamed = toIdentifier(renamed);
      while (
        renames.has(safeRenamed) ||
        bindingPath.scope.hasBinding(safeRenamed)
      ) {
        safeRenamed = `_${safeRenamed}`;
      }
      renames.add(safeRenamed);

      bindingPath.scope.rename(identifierNode.name, safeRenamed);
    }
    markVisited(bindingPath, identifierNode.name, visited);

    onProgress?.(visited.size, numRenamesExpected);
  }
  onProgress?.(numRenamesExpected, numRenamesExpected);

  const stringified = await transformFromAstAsync(ast);
  if (stringified?.code == null) {
    throw new Error("Failed to stringify code");
  }
  return stringified.code;
}

function findBindingIdentifiers(ast: Node): NodePath<Identifier>[] {
  const pathsWithScopeSize: [
    nodePath: NodePath<Identifier>,
    scopeSize: number,
  ][] = [];
  traverse(ast, {
    BindingIdentifier(path: NodePath<Identifier>) {
      const bindingBlock = closestSurroundingContextPath(path).scope.block;
      const scopeSize = bindingBlock.end! - bindingBlock.start!;

      pathsWithScopeSize.push([path, scopeSize]);
    },
  });

  // Sort by scope size descending (largest first) so outer scopes are renamed before inner
  pathsWithScopeSize.sort((a, b) => b[1] - a[1]);

  return pathsWithScopeSize.map(([nodePath]) => nodePath);
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

function scopeToString(path: NodePath<Identifier>, contextWindowSize: number) {
  const surroundingPath = closestSurroundingContextPath(path);
  const code = surroundingPath.toString();
  if (code.length <= contextWindowSize) {
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

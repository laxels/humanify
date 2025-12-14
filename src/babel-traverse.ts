import * as babelTraverse from "@babel/traverse";

/**
 * Babel's traverse package is sometimes bundled with a double-default export.
 * This helper normalizes it so it works in both CJS and ESM environments.
 */
export const traverse = (
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

export type { Binding, NodePath, Scope } from "@babel/traverse";

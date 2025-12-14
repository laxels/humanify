import * as babelTraverse from "@babel/traverse";

/**
 * Bun / ESM interop for `@babel/traverse`.
 *
 * Depending on runtime/bundler, the default export can be nested.
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

export type NodePath<T = any> = import("@babel/traverse").NodePath<T>;
export type Scope = import("@babel/traverse").Scope;
export type Binding = import("@babel/traverse").Binding;
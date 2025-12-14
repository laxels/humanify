import type { NodePath } from "@babel/core";
import * as t from "@babel/types";
import type { Identifier, Node } from "@babel/types";
import type { RenameSymbol, SymbolDossier } from "./types";

export function buildSymbolDossier(
  symbol: RenameSymbol,
  opts: { maxDeclarationChars?: number; maxEntriesPerSection?: number } = {},
): SymbolDossier {
  const maxDeclarationChars = opts.maxDeclarationChars ?? 700;
  const maxEntriesPerSection = opts.maxEntriesPerSection ?? 8;

  const binding = symbol.binding;

  const referencePaths: Array<NodePath<Identifier>> =
    (binding?.referencePaths as Array<NodePath<Identifier>> | undefined) ?? [];

  const constantViolations: Array<NodePath<Node>> =
    (binding?.constantViolations as Array<NodePath<Node>> | undefined) ?? [];

  const memberAccesses = new Map<string, number>();
  const passedTo = new Map<string, number>();
  const binaryOps = new Map<string, number>();
  const comparedToLiterals = new Map<string, number>();

  let callCount = 0;
  let awaitedCount = 0;
  const argCounts = new Map<number, number>();
  let newCount = 0;

  for (const ref of referencePaths) {
    const parent = ref.parentPath;

    // Member access: x.foo
    if (parent && (parent.isMemberExpression() || (parent as any).isOptionalMemberExpression?.())) {
      if ((ref as any).key === "object") {
        const prop = (parent.node as any).property;
        const computed = (parent.node as any).computed === true;

        const name = computed
          ? "[computed]"
          : t.isIdentifier(prop)
            ? `.${prop.name}`
            : t.isStringLiteral(prop)
              ? `.${prop.value}`
              : ".<?>";

        memberAccesses.set(name, (memberAccesses.get(name) ?? 0) + 1);
      }
      continue;
    }

    // Called as a function: x(...)
    if (parent && (parent.isCallExpression() || (parent as any).isOptionalCallExpression?.())) {
      if ((ref as any).key === "callee") {
        callCount += 1;
        const argc = (parent.node as any).arguments?.length ?? 0;
        argCounts.set(argc, (argCounts.get(argc) ?? 0) + 1);

        const maybeAwait = parent.parentPath;
        if (maybeAwait?.isAwaitExpression?.()) {
          awaitedCount += 1;
        }
      } else if ((ref as any).listKey === "arguments") {
        const callee = (parent.node as any).callee;
        const calleeName = calleeToDisplayName(callee);
        passedTo.set(calleeName, (passedTo.get(calleeName) ?? 0) + 1);
      }
      continue;
    }

    // Constructed: new X(...)
    if (parent && parent.isNewExpression()) {
      if ((ref as any).key === "callee") {
        newCount += 1;
        const argc = (parent.node as any).arguments?.length ?? 0;
        argCounts.set(argc, (argCounts.get(argc) ?? 0) + 1);
      }
      continue;
    }

    // Awaited: await x
    if (parent && parent.isAwaitExpression()) {
      awaitedCount += 1;
      continue;
    }

    // Binary ops: x === 0, x + y, x instanceof Foo, ...
    if (parent && parent.isBinaryExpression()) {
      const op = parent.node.operator;
      binaryOps.set(op, (binaryOps.get(op) ?? 0) + 1);

      const other =
        (ref as any).key === "left" ? (parent.node as any).right : (parent.node as any).left;

      const lit = literalToString(other);
      if (lit && isComparisonOperator(op)) {
        comparedToLiterals.set(lit, (comparedToLiterals.get(lit) ?? 0) + 1);
      }
      continue;
    }
  }

  const declaration = truncate(getDeclarationContext(symbol.bindingPath), maxDeclarationChars);

  const typeHints = inferTypeHints({
    kind: symbol.kind,
    callCount,
    awaitedCount,
    newCount,
    memberAccesses: Array.from(memberAccesses.keys()),
  });

  return {
    id: symbol.id,
    originalName: symbol.originalName,
    kind: symbol.kind,
    declaration,

    referenceCount: referencePaths.length,
    writeCount: constantViolations.length,

    memberAccesses: topEntries(memberAccesses, maxEntriesPerSection),

    callInfo: {
      callCount,
      awaitedCount,
      argCounts: topNumberEntries(argCounts, maxEntriesPerSection),
    },

    newCount,

    passedTo: topEntries(passedTo, maxEntriesPerSection),

    binaryOps: topEntries(binaryOps, maxEntriesPerSection),

    comparedToLiterals: topEntries(comparedToLiterals, maxEntriesPerSection),

    typeHints,
  };
}

export function formatSymbolDossier(d: SymbolDossier): string {
  const lines: string[] = [];

  lines.push(`- [${d.id}] ${d.originalName} (${d.kind})`);
  if (d.declaration.trim().length > 0) {
    lines.push(`  declaration: ${singleLine(d.declaration)}`);
  }

  lines.push(
    `  refs: ${d.referenceCount}${d.writeCount > 0 ? `, writes: ${d.writeCount}` : ""}`,
  );

  if (d.callInfo.callCount > 0) {
    const argSummary = d.callInfo.argCounts
      .map((a) => `${a.count} args ×${a.occurrences}`)
      .join(", ");
    lines.push(
      `  called: ${d.callInfo.callCount}${d.callInfo.awaitedCount > 0 ? ` (awaited: ${d.callInfo.awaitedCount})` : ""}${
        argSummary.length > 0 ? `; ${argSummary}` : ""
      }`,
    );
  }

  if (d.newCount > 0) {
    lines.push(`  constructed with new: ${d.newCount}`);
  }

  if (d.memberAccesses.length > 0) {
    lines.push(
      `  member access: ${d.memberAccesses.map((m) => `${m.name}×${m.count}`).join(", ")}`,
    );
  }

  if (d.passedTo.length > 0) {
    lines.push(
      `  passed to: ${d.passedTo.map((p) => `${p.callee}×${p.count}`).join(", ")}`,
    );
  }

  if (d.binaryOps.length > 0) {
    lines.push(`  ops: ${d.binaryOps.map((o) => `${o.op}×${o.count}`).join(", ")}`);
  }

  if (d.comparedToLiterals.length > 0) {
    lines.push(
      `  compared to: ${d.comparedToLiterals
        .map((c) => `${c.literal}×${c.count}`)
        .join(", ")}`,
    );
  }

  if (d.typeHints.length > 0) {
    lines.push(`  type hints: ${d.typeHints.join(", ")}`);
  }

  return lines.join("\n");
}

function getDeclarationContext(path: NodePath<Identifier>): string {
  // Prefer a statement-level context.
  const stmt = path.getStatementParent();
  if (stmt) return stmt.toString();

  // For parameters/pattern bindings, fall back to the closest function/class/program.
  const unit = path.findParent((p) => p.isFunction() || p.isClass() || p.isProgram());
  if (unit) return unit.toString();

  return path.toString();
}

function topEntries(map: Map<string, number>, max: number): Array<{ name: string; count: number }> {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([name, count]) => ({ name, count }));
}

function topNumberEntries(
  map: Map<number, number>,
  max: number,
): Array<{ count: number; occurrences: number }> {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, max)
    .map(([count, occurrences]) => ({ count, occurrences }));
}

function calleeToDisplayName(callee: any): string {
  if (t.isIdentifier(callee)) return callee.name;

  if (t.isMemberExpression(callee) && !callee.computed) {
    const obj = callee.object;
    const prop = callee.property;

    const propName = t.isIdentifier(prop)
      ? prop.name
      : t.isStringLiteral(prop)
        ? prop.value
        : "<?>";

    if (t.isIdentifier(obj)) return `${obj.name}.${propName}`;
    return `.${propName}`;
  }

  return `<${callee?.type ?? "unknown"}>`;
}

function isComparisonOperator(op: string): boolean {
  return op === "==" || op === "!=" || op === "===" || op === "!==" || op === "<" || op === "<=" || op === ">" || op === ">=";
}

function literalToString(node: any): string | undefined {
  if (!node) return undefined;
  if (t.isStringLiteral(node)) return JSON.stringify(node.value);
  if (t.isNumericLiteral(node)) return String(node.value);
  if (t.isBooleanLiteral(node)) return String(node.value);
  if (t.isNullLiteral(node)) return "null";
  if (t.isIdentifier(node, { name: "undefined" })) return "undefined";
  return undefined;
}

function inferTypeHints(input: {
  kind: string;
  callCount: number;
  awaitedCount: number;
  newCount: number;
  memberAccesses: string[];
}): string[] {
  const hints: string[] = [];

  if (input.newCount > 0) hints.push("constructor/class-like");
  if (input.callCount > 0 && input.newCount === 0) hints.push("callable/function-like");
  if (input.awaitedCount > 0) hints.push("promise-like/awaited");

  const m = new Set(input.memberAccesses);

  const arrayish = [".map", ".filter", ".reduce", ".forEach", ".push", ".pop", ".slice", ".splice", ".concat"];
  if (arrayish.some((x) => m.has(x))) hints.push("array-like");

  const stringish = [".substring", ".substr", ".slice", ".split", ".toLowerCase", ".toUpperCase", ".charCodeAt", ".includes", ".startsWith", ".endsWith", ".replace"];
  if (stringish.some((x) => m.has(x))) hints.push("string-like");

  const promiseish = [".then", ".catch", ".finally"];
  if (promiseish.some((x) => m.has(x))) hints.push("promise-like");

  const eventish = [".addEventListener", ".removeEventListener", ".dispatchEvent"];
  if (eventish.some((x) => m.has(x))) hints.push("event-target-like");

  return hints;
}

function truncate(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
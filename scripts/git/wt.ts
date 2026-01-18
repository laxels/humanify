#!/usr/bin/env bun

import path from "node:path";
import { $ } from "bun";

const CP_ITEMS = [`.env.keys`, `.env.local`];

async function main(): Promise<void> {
  const { branchName, force } = parseArgs();

  const projectName = path.basename(process.cwd());
  const dirPath = `../worktrees/${projectName}/${branchName}`;

  if (force) {
    await $`git worktree remove --force ${dirPath}`.nothrow();
  }

  const branchExists =
    (await $`git show-ref --verify --quiet refs/heads/${branchName}`.nothrow())
      .exitCode === 0;

  if (branchExists) {
    await $`git worktree add ${dirPath} ${branchName}`;
  } else {
    await $`git worktree add -b ${branchName} ${dirPath}`;
  }
  for (const item of CP_ITEMS) {
    await $`cp -a ${item} ${dirPath}`.nothrow();
  }
  $.cwd(dirPath);
  await $`direnv allow`;
  await $`bun install`;
  await $`git push -u origin HEAD`;
  await $`cursor .`;
}

function parseArgs(): { branchName: string; force: boolean } {
  const args = process.argv.slice(2);
  let force = false;
  let branchName: string | undefined;

  for (const arg of args) {
    if (arg === "-f" || arg === "--force") {
      force = true;
    } else if (!arg.startsWith("-")) {
      branchName = arg;
    }
  }

  if (!branchName) {
    throw new Error("Branch name is required");
  }

  return { branchName, force };
}

if (import.meta.main) {
  await main();
  process.exit();
}

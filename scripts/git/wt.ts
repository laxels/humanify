#!/usr/bin/env bun

import path from "node:path";
import { $ } from "bun";

const CP_ITEMS = [`.env.keys`, `.env.local`];

async function main(): Promise<void> {
  const branchName = process.argv[2];
  if (!branchName) {
    throw new Error("Branch name is required");
  }

  const projectName = path.basename(process.cwd());
  const dirPath = `../worktrees/${projectName}/${branchName}`;

  const branchExists =
    (await $`git show-ref --verify --quiet refs/heads/${branchName}`.nothrow())
      .exitCode === 0;

  if (branchExists) {
    await $`git worktree add ${dirPath} ${branchName}`;
  } else {
    await $`git worktree add -b ${branchName} ${dirPath}`;
  }
  await $`cp -a ${CP_ITEMS} ${dirPath}`;
  $.cwd(dirPath);
  await $`direnv allow`;
  await $`bun install`;
  await $`git push -u origin HEAD`;
  await $`cursor .`;
}

if (import.meta.main) {
  await main();
  process.exit();
}

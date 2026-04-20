import { simpleGit, type SimpleGit } from "simple-git";
import { logger } from "./logger.js";

function git(cwd: string): SimpleGit {
  return simpleGit(cwd);
}

export async function getCurrentBranch(repoPath: string): Promise<string> {
  const result = await git(repoPath).revparse(["--abbrev-ref", "HEAD"]);
  return result.trim();
}

export async function createBranch(repoPath: string, branchName: string, baseBranch?: string): Promise<void> {
  const g = git(repoPath);
  if (baseBranch) {
    await g.fetch("origin", baseBranch);
    await g.checkoutBranch(branchName, `origin/${baseBranch}`);
  } else {
    await g.checkoutLocalBranch(branchName);
  }
  logger.info(`Created branch ${branchName} in ${repoPath}`);
}

export async function createWorktree(repoPath: string, worktreePath: string, branchName: string, baseBranch?: string): Promise<void> {
  const g = git(repoPath);
  if (baseBranch) {
    await g.fetch("origin", baseBranch);
    try {
      // Try creating with new branch
      await g.raw(["worktree", "add", worktreePath, "-b", branchName, `origin/${baseBranch}`]);
    } catch (err: any) {
      // Branch already exists — use it directly
      if (String(err).includes("already exists")) {
        logger.info(`Branch ${branchName} already exists, reusing it`);
        await g.raw(["worktree", "add", worktreePath, branchName]);
      } else {
        throw err;
      }
    }
    logger.info(`Created worktree at ${worktreePath} on branch ${branchName} (base: origin/${baseBranch})`);
  } else {
    try {
      await g.raw(["worktree", "add", worktreePath, "-b", branchName]);
    } catch (err: any) {
      if (String(err).includes("already exists")) {
        await g.raw(["worktree", "add", worktreePath, branchName]);
      } else {
        throw err;
      }
    }
    logger.info(`Created worktree at ${worktreePath} on branch ${branchName}`);
  }
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  const g = git(repoPath);
  await g.raw(["worktree", "remove", worktreePath, "--force"]);
  logger.info(`Removed worktree at ${worktreePath}`);
}

export async function applyPatch(worktreePath: string, filePath: string, content: string): Promise<void> {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname, resolve } = await import("node:path");
  const fullPath = resolve(worktreePath, filePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
  logger.info(`Wrote ${filePath} in worktree ${worktreePath}`);
}

/**
 * Safety check: ensure the given path is inside a worktree, NOT the main repo.
 * Prevents accidental commits/pushes to developer branches.
 */
async function assertWorktree(path: string): Promise<void> {
  const g = git(path);
  // `git rev-parse --is-inside-work-tree` is true for both repo and worktree,
  // but `git worktree list` + checking if path contains ".worktrees" is more reliable.
  // Also check: in a real worktree, `.git` is a file (not a directory) pointing to the main repo.
  const { statSync } = await import("node:fs");
  const { join } = await import("node:path");
  try {
    const gitStat = statSync(join(path, ".git"));
    if (gitStat.isDirectory()) {
      throw new Error(`SAFETY: ${path} is the main repo (.git is a directory), not a worktree. Refusing git write operation.`);
    }
    // .git is a file → this is a worktree, safe to proceed
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new Error(`SAFETY: ${path} has no .git entry. Refusing git write operation.`);
    }
    if (err.message?.startsWith("SAFETY:")) throw err;
    throw new Error(`SAFETY: cannot verify ${path} is a worktree: ${err}`);
  }
}

export async function commitChanges(worktreePath: string, message: string): Promise<string> {
  await assertWorktree(worktreePath);
  const g = git(worktreePath);
  await g.add("-A");
  const result = await g.commit(message);
  if (!result.commit) {
    throw new Error("nothing to commit — no files were changed by the fix");
  }
  logger.info(`Committed in ${worktreePath}: ${result.commit}`);
  return result.commit;
}

export async function pushBranch(worktreePath: string, remote: string = "origin", opts?: { forceWithLease?: boolean }): Promise<void> {
  await assertWorktree(worktreePath);
  const g = git(worktreePath);
  const branch = await getCurrentBranch(worktreePath);
  const flags = ["--set-upstream"];
  if (opts?.forceWithLease) {
    flags.push("--force-with-lease");
  }
  await g.push(remote, branch, flags);
  logger.info(`Pushed ${branch} to ${remote}${opts?.forceWithLease ? " (force-with-lease)" : ""}`);
}

/**
 * Cherry-pick a commit to a new per-incident branch and push it.
 * Uses a temporary worktree so the main repo checkout is never touched.
 */
export async function cherryPickAndPush(
  repoPath: string,
  commitHash: string,
  newBranchName: string,
  baseBranch: string,
  remote: string = "origin",
): Promise<void> {
  const { mkdirSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");

  const tmpWorktreePath = join(repoPath, ".worktrees", "spirit", `cherry-pick-${commitHash.slice(0, 8)}`);
  mkdirSync(join(repoPath, ".worktrees", "spirit"), { recursive: true });

  const g = git(repoPath);
  await g.fetch(remote, baseBranch);

  // Check if branch already exists remotely or locally
  let branchExists = false;
  try {
    await g.revparse(["--verify", newBranchName]);
    branchExists = true;
  } catch { /* branch doesn't exist */ }

  try {
    if (branchExists) {
      await g.raw(["worktree", "add", tmpWorktreePath, newBranchName]);
      logger.info(`Created temp worktree on existing branch ${newBranchName}`);
    } else {
      await g.raw(["worktree", "add", tmpWorktreePath, "-b", newBranchName, `${remote}/${baseBranch}`]);
      logger.info(`Created temp worktree on new branch ${newBranchName} from ${remote}/${baseBranch}`);
    }

    const wt = git(tmpWorktreePath);
    await wt.raw(["cherry-pick", commitHash]);
    logger.info(`Cherry-picked ${commitHash} to ${newBranchName}`);

    await wt.push(remote, newBranchName, ["--set-upstream"]);
    logger.info(`Pushed ${newBranchName} to ${remote}`);
  } finally {
    try {
      await g.raw(["worktree", "remove", tmpWorktreePath, "--force"]);
      rmSync(tmpWorktreePath, { recursive: true, force: true });
    } catch (err) {
      logger.warn(`Failed to clean up temp worktree ${tmpWorktreePath}:`, err);
    }
  }
}

export async function listWorktrees(repoPath: string): Promise<string[]> {
  const g = git(repoPath);
  const result = await g.raw(["worktree", "list", "--porcelain"]);
  const paths: string[] = [];
  for (const line of result.split("\n")) {
    if (line.startsWith("worktree ")) {
      paths.push(line.slice("worktree ".length));
    }
  }
  return paths;
}

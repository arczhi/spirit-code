import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { logger } from "../shared/logger.js";
import * as gitOps from "../shared/git-ops.js";
import type { Config, CodeRoot, Environment } from "../shared/config.js";
import {
  createMergeRequest,
  findOpenMergeRequest,
  getMergeRequestStatus,
  getIssue,
  getProjectId,
} from "../shared/gitlab-api.js";
import { updateIssueTask, type IssueTask } from "../shared/issue-task-store.js";

export interface FinalizerDeps {
  config: Config;
  db: Database.Database;
}

interface CodeRootMatch {
  env: Environment;
  codeRoot: CodeRoot;
}

/**
 * After a Claude iteration finishes, scan the worktree for uncommitted changes
 * or unpushed commits, commit/push as needed, and create an MR if one does not
 * yet exist for this task's branch. Returns a short human-readable suffix to
 * append to the iteration's issue comment.
 */
export async function finalizeIteration(
  deps: FinalizerDeps,
  task: IssueTask,
  match: CodeRootMatch,
  claudeSummary: string,
): Promise<string> {
  const { config, db } = deps;

  if (!existsSync(join(task.worktree_path, ".git"))) {
    logger.warn(`Worktree missing for task ${task.id.slice(0, 8)}, skipping finalize`);
    return "";
  }

  const targetBranch = config.gitlab.defaultTargetBranch;
  let noteSuffix = "";

  try {
    // 1. Stage + commit any uncommitted changes
    const dirty = gitStatusShort(task.worktree_path);
    if (dirty.length > 0) {
      const files = dirty.map((l) => l.trim().replace(/^..\s+/, ""));
      const commitMsg = buildCommitMessage(task, files, claudeSummary);
      try {
        const hash = await gitOps.commitChanges(task.worktree_path, commitMsg);
        logger.info(`Committed ${files.length} file(s) on ${task.branch}: ${hash.slice(0, 8)}`);
        noteSuffix += `\n\n**💾 已提交：** \`${hash.slice(0, 8)}\` — ${files.length} 个文件\n`;
        for (const f of files.slice(0, 10)) noteSuffix += `- \`${f}\`\n`;
        if (files.length > 10) noteSuffix += `- … 及另外 ${files.length - 10} 个\n`;
      } catch (err) {
        logger.error(`Commit failed for task ${task.id.slice(0, 8)}:`, err);
        noteSuffix += `\n\n⚠️ 提交失败：${String(err).slice(0, 200)}\n`;
        return noteSuffix;
      }
    }

    // 2. Push if the local branch is ahead of remote (or has no remote-tracking yet)
    const pushNeeded = isPushNeeded(task.worktree_path, match.codeRoot.gitRemote, task.branch);
    if (pushNeeded) {
      try {
        await gitOps.pushBranch(task.worktree_path, match.codeRoot.gitRemote);
        logger.info(`Pushed ${task.branch} to ${match.codeRoot.gitRemote}`);
        noteSuffix += `\n**📤 已推送：** \`${task.branch}\`\n`;
      } catch (err) {
        logger.error(`Push failed for task ${task.id.slice(0, 8)}:`, err);
        noteSuffix += `\n⚠️ 推送失败：${String(err).slice(0, 200)}\n`;
        return noteSuffix;
      }
    }

    // 3. Create MR if one doesn't exist yet AND branch has commits beyond target
    if (!task.mr_iid) {
      const aheadCount = commitsAheadOfBase(
        task.worktree_path,
        match.codeRoot.gitRemote,
        targetBranch,
      );
      if (aheadCount > 0) {
        const projectId = await getProjectId(
          config.gitlab.url,
          config.gitlab.token,
          match.codeRoot.gitlabProjectPath,
        );
        const existingOpen = await findOpenMergeRequest(
          config.gitlab.url,
          config.gitlab.token,
          projectId,
          task.branch,
        );
        if (existingOpen) {
          updateIssueTask(db, task.id, {
            mr_iid: existingOpen.iid,
            mr_url: existingOpen.web_url,
            status: "wip",
          });
          noteSuffix += `\n**🔗 现存 MR：** [!${existingOpen.iid}](${existingOpen.web_url})\n`;
        } else {
          const issue = await getIssue(
            config.gitlab.url,
            config.gitlab.token,
            task.gitlab_project_id,
            task.issue_iid,
          );
          const mr = await createMergeRequest({
            gitlabUrl: config.gitlab.url,
            token: config.gitlab.token,
            projectId,
            sourceBranch: task.branch,
            targetBranch,
            title: `[Spirit] Issue #${task.issue_iid}: ${task.issue_title.slice(0, 80)}`,
            description: buildMrDescription(task, issue.web_url, issue.description, targetBranch),
          });
          updateIssueTask(db, task.id, {
            mr_iid: mr.iid,
            mr_url: mr.web_url,
            status: "wip",
          });
          noteSuffix += `\n**✨ 已建 MR：** [!${mr.iid}](${mr.web_url}) → \`${targetBranch}\`\n`;
          logger.info(`Created MR !${mr.iid} for issue #${task.issue_iid}`);
        }
      }
    } else {
      noteSuffix += `\n**🔗 MR：** [!${task.mr_iid}](${task.mr_url})（已推送新 commit）\n`;
    }
  } catch (err) {
    logger.error(`finalizeIteration unexpected error for ${task.id.slice(0, 8)}:`, err);
    noteSuffix += `\n\n⚠️ finalize 异常：${String(err).slice(0, 200)}\n`;
  }

  return noteSuffix;
}

/**
 * Reconcile a task's state against GitLab:
 * - If the MR is merged → mark task `done`, remove worktree
 * - If the MR is closed (not merged) → mark task `stalled`, keep worktree for inspection
 * - If the issue is closed and no MR exists → mark task `closed`, remove worktree
 * Returns true if the task is now terminal (should not be polled further).
 */
export async function reconcileTaskState(
  deps: FinalizerDeps,
  task: IssueTask,
  match: CodeRootMatch,
): Promise<boolean> {
  const { config, db } = deps;

  try {
    // Check MR state if we have one
    if (task.mr_iid) {
      const mr = await getMergeRequestStatus(
        config.gitlab.url,
        config.gitlab.token,
        task.gitlab_project_id,
        task.mr_iid,
      );
      if (mr.state === "merged") {
        logger.info(`Task ${task.id.slice(0, 8)}: MR !${task.mr_iid} merged → done`);
        updateIssueTask(db, task.id, { status: "done" });
        await cleanupWorktree(match.codeRoot.path, task.worktree_path);
        return true;
      }
      if (mr.state === "closed") {
        logger.info(`Task ${task.id.slice(0, 8)}: MR !${task.mr_iid} closed → stalled`);
        updateIssueTask(db, task.id, { status: "stalled" });
        return true;
      }
    }

    // Check issue state
    const issue = await getIssue(
      config.gitlab.url,
      config.gitlab.token,
      task.gitlab_project_id,
      task.issue_iid,
    );
    if (issue.state === "closed") {
      logger.info(`Task ${task.id.slice(0, 8)}: issue #${task.issue_iid} closed → ${task.mr_iid ? "done" : "closed"}`);
      updateIssueTask(db, task.id, { status: task.mr_iid ? "done" : "closed" });
      await cleanupWorktree(match.codeRoot.path, task.worktree_path);
      return true;
    }
  } catch (err) {
    logger.warn(`reconcileTaskState failed for ${task.id.slice(0, 8)}:`, err);
  }

  return false;
}

// ─── Helpers ─────────────────────────────────────────────────

function gitStatusShort(worktreePath: string): string[] {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: 10000,
    });
    return out.trim().split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

function isPushNeeded(worktreePath: string, remote: string, branch: string): boolean {
  try {
    // Does the remote-tracking ref exist?
    try {
      execFileSync("git", ["rev-parse", "--verify", `refs/remotes/${remote}/${branch}`], {
        cwd: worktreePath,
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return true; // No remote tracking yet
    }
    const count = execFileSync("git", ["rev-list", "--count", `${remote}/${branch}..HEAD`], {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    return parseInt(count, 10) > 0;
  } catch {
    return true;
  }
}

function commitsAheadOfBase(worktreePath: string, remote: string, baseBranch: string): number {
  try {
    execFileSync("git", ["fetch", remote, baseBranch], {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: 30000,
    });
    const count = execFileSync("git", ["rev-list", "--count", `${remote}/${baseBranch}..HEAD`], {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    return parseInt(count, 10);
  } catch (err) {
    logger.warn(`commitsAheadOfBase failed at ${worktreePath}:`, err);
    return 0;
  }
}

function buildCommitMessage(task: IssueTask, files: string[], claudeSummary: string): string {
  const subject = `feat(issue-${task.issue_iid}): ${task.issue_title.slice(0, 70)}`;
  const topSummary = claudeSummary.split("\n").slice(0, 20).join("\n").slice(0, 1200);
  return [
    subject,
    "",
    `Iteration ${task.iteration_count + 1} · Issue ${task.issue_url}`,
    "",
    topSummary,
    "",
    `Files (${files.length}):`,
    ...files.slice(0, 20).map((f) => `  - ${f}`),
    "",
    "Auto-generated by Spirit 精灵 (issue-driven development).",
  ].join("\n");
}

function buildMrDescription(
  task: IssueTask,
  issueUrl: string,
  issueDescription: string,
  targetBranch: string,
): string {
  return [
    "## Spirit 精灵 · Issue-Driven Development",
    "",
    `**Driving Issue:** [#${task.issue_iid}](${issueUrl}) — ${task.issue_title}`,
    `**Target:** \`${targetBranch}\``,
    `**Branch:** \`${task.branch}\``,
    "",
    "### Issue Description",
    "",
    (issueDescription || "(empty)").slice(0, 4000),
    "",
    "---",
    "",
    `Closes #${task.issue_iid}`,
    "",
    "*本 MR 由 Spirit 通过 Claude Code 在本地 worktree 中自动产出，随 Issue 评论持续迭代。*",
    "*开发者可继续在 Issue 下评论，Spirit 会 resume 会话并推新 commit 到本 MR。*",
  ].join("\n");
}

async function cleanupWorktree(mainRepoPath: string, worktreePath: string): Promise<void> {
  try {
    if (!existsSync(join(worktreePath, ".git"))) return;
    await gitOps.removeWorktree(mainRepoPath, worktreePath);
  } catch (err) {
    logger.warn(`Failed to cleanup worktree ${worktreePath}:`, err);
  }
}

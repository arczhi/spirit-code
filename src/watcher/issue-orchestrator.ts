import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { logger } from "../shared/logger.js";
import type { Config, CodeRoot, Environment } from "../shared/config.js";
import type { GitlabIssue, GitlabNote } from "../shared/gitlab-api.js";
import { createIssueNote, getIssue, getIssueNotes, getProjectId } from "../shared/gitlab-api.js";
import * as gitOps from "../shared/git-ops.js";
import { runIssueAgent } from "./issue-agent.js";
import type Anthropic from "@anthropic-ai/sdk";
import {
  createIssueTask,
  findIssueTaskByIssue,
  incrementIterationCount,
  updateIssueTask,
  type IssueTask,
} from "../shared/issue-task-store.js";
import { finalizeIteration, reconcileTaskState } from "./issue-finalizer.js";

const SPIRIT_NOTE_MARKER = "<!-- spirit-issue-bot -->";
const SPIRIT_NOTE_HEADER = `## 🧠 Spirit\n\n${SPIRIT_NOTE_MARKER}\n`;

// Per-task lock — serialize initial run and comment-resume on the same issue task
const taskLocks = new Map<string, Promise<void>>();

function withTaskLock(taskId: string, fn: () => Promise<void>): Promise<void> {
  const prev = taskLocks.get(taskId) ?? Promise.resolve();
  const next = prev.then(
    () => fn().catch((err) => {
      logger.error(`Task ${taskId.slice(0, 8)} failed in lock:`, err);
      throw err; // Re-throw to propagate error
    }),
    (err) => {
      logger.error(`Previous task ${taskId.slice(0, 8)} failed, skipping:`, err);
      throw err;
    }
  );
  taskLocks.set(taskId, next);
  return next;
}

export interface OrchestratorDeps {
  config: Config;
  db: Database.Database;
}

export interface CodeRootMatch {
  env: Environment;
  codeRoot: CodeRoot;
}

export function resolveCodeRoot(config: Config, gitlabProjectPath: string): CodeRootMatch | null {
  const preferred = config.watcher.issueWatcher.preferEnv;
  const ordered = [...config.environments].sort((a, b) => {
    if (a.name === preferred) return -1;
    if (b.name === preferred) return 1;
    return 0;
  });
  for (const env of ordered) {
    for (const codeRoot of env.codeRoots) {
      if (codeRoot.gitlabProjectPath === gitlabProjectPath) {
        return { env, codeRoot };
      }
    }
  }
  return null;
}

function slugifyTitle(title: string): string {
  const lowered = title.toLowerCase().trim();
  const asciiOnly = lowered
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const truncated = asciiOnly.slice(0, 30).replace(/-+$/, "");
  return truncated;
}

function buildBranchName(issue: GitlabIssue): string {
  const date = new Date(issue.created_at);
  const yyyymmdd = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(
    date.getUTCDate(),
  ).padStart(2, "0")}`;
  const slug = slugifyTitle(issue.title) || `issue-${issue.iid}`;
  return `feature/${yyyymmdd}_${slug}`;
}

function buildWorktreePath(codeRootPath: string, issueIid: number): string {
  return join(resolve(codeRootPath), ".worktrees", "spirit-issue", String(issueIid));
}

function buildInitialPrompt(issue: GitlabIssue, branch: string, codeRoot: CodeRoot, worktreePath: string): string {
  return [
    "You are Claude Code running headless in a git worktree driven by a GitLab issue.",
    "",
    `Repository: ${codeRoot.gitlabProjectPath}`,
    `Branch: ${branch}`,
    `Worktree path: ${worktreePath}`,
    "",
    "## HARD CONSTRAINTS — read before doing anything",
    "",
    `- Your working directory IS the worktree: ${worktreePath}`,
    "- You MUST only read/write files inside this worktree. Never touch the main repo checkout.",
    "- All git operations (commit, push) must run inside this worktree directory.",
    "- Do NOT run `git checkout`, `git switch`, or `git worktree` commands — the branch is already set.",
    "- Do NOT modify files outside this worktree path.",
    "",
    `## Issue #${issue.iid}: ${issue.title}`,
    "",
    (issue.description || "(empty description)").slice(0, 8000),
    "",
    "## Instructions",
    "",
    "- Treat this as your task. Investigate, implement, or refactor in this worktree.",
    "- Edit files directly. Make commits only when you feel a logical unit is complete.",
    "- If you need clarification, ask concrete questions; the developer will reply via issue comments.",
    "- At the end of this iteration, produce a SHORT markdown summary with these sections:",
    "  1. **What I understood** — 1-3 bullets",
    "  2. **What I changed** — files touched (with one-line reason each), or 'no code changes'",
    "  3. **Next step / questions** — what you'd do next or what you need from the developer",
    "",
    "Do not paste full file contents in the summary. Do not wrap the whole answer in code fences.",
  ].join("\n");
}

function buildResumePrompt(newComments: GitlabNote[]): string {
  const body = newComments
    .map((n) => `[@${n.author.username}]\n${n.body}`)
    .join("\n\n---\n\n");
  return [
    "New comment(s) arrived on the GitLab issue driving this session:",
    "",
    body,
    "",
    "Continue the work. Apply the developer's intent. Finish with the same 3-section summary as before",
    "(What I understood / What I changed / Next step or questions).",
  ].join("\n");
}

function wrapNote(body: string, iteration: number, durationMs: number): string {
  const trimmed = body.trim();
  const footer = `\n\n---\n*iteration ${iteration} · ${Math.round(durationMs / 1000)}s · auto-generated by Spirit 精灵*`;
  return `${SPIRIT_NOTE_HEADER}${trimmed}${footer}`;
}

export function isSpiritNote(note: GitlabNote): boolean {
  return note.system === true || note.body.includes(SPIRIT_NOTE_MARKER);
}

/**
 * Entry point: a new (or returning) issue was detected by the poller.
 * Idempotent: if the issue already has an issue_task row, skips creation.
 */
export async function handleNewIssue(
  deps: OrchestratorDeps,
  projectPath: string,
  projectId: number,
  issue: GitlabIssue,
): Promise<void> {
  const { config, db } = deps;

  const existing = findIssueTaskByIssue(db, projectId, issue.iid);
  if (existing) {
    // Retry pending/failed tasks — they may have been interrupted
    if (existing.status === "pending" || existing.status === "failed") {
      logger.info(`Issue #${issue.iid} task ${existing.id.slice(0, 8)} is ${existing.status}, retrying initial iteration`);
      await withTaskLock(existing.id, () => runInitialIteration(deps, existing.id));
    } else {
      logger.debug(`Issue #${issue.iid} already tracked as task ${existing.id.slice(0, 8)} (status=${existing.status})`);
    }
    return;
  }

  const match = resolveCodeRoot(config, projectPath);
  if (!match) {
    logger.warn(`No codeRoot configured for project ${projectPath}, ignoring issue #${issue.iid}`);
    return;
  }

  const branch = buildBranchName(issue);
  const worktreePath = buildWorktreePath(match.codeRoot.path, issue.iid);
  const taskId = randomUUID();
  const sessionId = randomUUID();

  createIssueTask(db, {
    id: taskId,
    gitlab_project_path: projectPath,
    gitlab_project_id: projectId,
    issue_iid: issue.iid,
    issue_title: issue.title,
    issue_url: issue.web_url,
    env: match.env.name,
    service: match.codeRoot.name,
    branch,
    worktree_path: worktreePath,
    claude_session_id: sessionId,
    status: "pending",
  });

  logger.info(`New issue task ${taskId.slice(0, 8)} for issue #${issue.iid} on branch ${branch}`);

  await withTaskLock(taskId, () => runInitialIteration(deps, taskId));
}

async function runInitialIteration(deps: OrchestratorDeps, taskId: string): Promise<void> {
  const { config, db } = deps;
  const task = db.prepare("SELECT * FROM issue_tasks WHERE id = ?").get(taskId) as IssueTask | undefined;
  if (!task) return;

  const match = resolveCodeRoot(config, task.gitlab_project_path);
  if (!match) {
    updateIssueTask(db, task.id, { status: "failed", last_error: "codeRoot not resolvable" });
    return;
  }

  try {
    // Mark as active and notify user
    updateIssueTask(db, task.id, { status: "active" });

    // Post initial comment to let user know Spirit is working
    await postIssueNote(
      config,
      task.gitlab_project_id,
      task.issue_iid,
      "🚀 Spirit 已接收任务，正在分析需求并准备开发环境...",
      0,
      0,
    );

    // Ensure worktree — base on defaultTargetBranch so the MR diff stays scoped
    const baseBranch = config.gitlab.defaultTargetBranch;
    mkdirSync(join(resolve(match.codeRoot.path), ".worktrees", "spirit-issue"), { recursive: true });
    if (!existsSync(join(task.worktree_path, ".git"))) {
      logger.info(`Creating worktree ${task.worktree_path} on ${task.branch} (base: ${baseBranch})`);
      await gitOps.createWorktree(match.codeRoot.path, task.worktree_path, task.branch, baseBranch);
    } else {
      logger.info(`Reusing existing worktree at ${task.worktree_path}`);
    }

    // Fetch the issue details fresh to get description
    const projectId = task.gitlab_project_id;
    const issue = await getIssue(config.gitlab.url, config.gitlab.token, projectId, task.issue_iid);

    const prompt = buildInitialPrompt(issue, task.branch, match.codeRoot, task.worktree_path);

    const result = await runIssueAgent({
      prompt,
      worktreePath: task.worktree_path,
      config,
      envConfig: match.env,
    });

    incrementIterationCount(db, task.id);

    if (!result.ok || !result.text) {
      updateIssueTask(db, task.id, {
        status: "failed",
        last_error: `issue agent initial run failed: ${result.text.slice(0, 500)}`,
      });
      await postIssueNote(
        config,
        projectId,
        task.issue_iid,
        `⚠️ Spirit 启动失败：Agent 未能处理本 issue。\n\n\`\`\`\n${result.text.slice(0, 1000)}\n\`\`\``,
        0,
        result.durationMs,
      );
      return;
    }

    // Persist messages for resume in next iteration
    updateIssueTask(db, task.id, {
      agent_messages: JSON.stringify(result.messages ?? []),
    });

    // Scan worktree for changes, commit, push, create MR — returns summary suffix
    const refreshedTask = (db.prepare("SELECT * FROM issue_tasks WHERE id = ?").get(task.id) as IssueTask) ?? task;
    const finalizeSuffix = await finalizeIteration(deps, refreshedTask, match, result.text);

    const note = await postIssueNote(
      config,
      projectId,
      task.issue_iid,
      result.text + finalizeSuffix,
      1,
      result.durationMs,
    );

    updateIssueTask(db, task.id, {
      status: "active",
      last_note_id: note?.id ?? task.last_note_id,
      last_error: null,
    });
  } catch (err) {
    logger.error(`Initial iteration failed for task ${task.id}:`, err);
    updateIssueTask(db, task.id, {
      status: "failed",
      last_error: String(err).slice(0, 1000),
    });
  }
}

/**
 * Called by the comment poller when new developer comment(s) have arrived.
 */
export async function handleNewComments(
  deps: OrchestratorDeps,
  task: IssueTask,
  newComments: GitlabNote[],
): Promise<void> {
  if (newComments.length === 0) return;
  await withTaskLock(task.id, () => runResumeIteration(deps, task.id, newComments));
}

async function runResumeIteration(
  deps: OrchestratorDeps,
  taskId: string,
  newComments: GitlabNote[],
): Promise<void> {
  const { config, db } = deps;
  const task = db.prepare("SELECT * FROM issue_tasks WHERE id = ?").get(taskId) as IssueTask | undefined;
  if (!task) return;

  const iw = config.watcher.issueWatcher;
  if (task.iteration_count >= iw.maxIterations) {
    logger.warn(`Task ${task.id.slice(0, 8)} hit maxIterations=${iw.maxIterations}, not resuming`);
    await postIssueNote(
      config,
      task.gitlab_project_id,
      task.issue_iid,
      `⚠️ Spirit 已达迭代上限（${iw.maxIterations}），不再自动响应。请人工接手或关闭 issue 后重开。`,
      task.iteration_count,
      0,
    );
    updateIssueTask(db, task.id, { status: "stalled" });
    return;
  }

  const match = resolveCodeRoot(config, task.gitlab_project_path);
  if (!match) {
    updateIssueTask(db, task.id, { status: "failed", last_error: "codeRoot not resolvable" });
    return;
  }

  // If no prior messages, fall back to a fresh run
  if (!task.agent_messages) {
    logger.warn(`Task ${task.id.slice(0, 8)} has no agent_messages, treating as new run`);
    await runInitialIteration(deps, task.id);
    return;
  }

  try {
    const prompt = buildResumePrompt(newComments);
    // Restore prior conversation and append the new user message
    const priorMessages = JSON.parse(task.agent_messages) as Anthropic.MessageParam[];
    const resumeMessages: Anthropic.MessageParam[] = [
      ...priorMessages,
      { role: "user", content: prompt },
    ];

    const result = await runIssueAgent({
      prompt,
      worktreePath: task.worktree_path,
      config,
      messages: resumeMessages,
    });

    incrementIterationCount(db, task.id);

    const latestCommentId = newComments[newComments.length - 1].id;

    if (!result.ok || !result.text) {
      updateIssueTask(db, task.id, {
        last_note_id: latestCommentId,
        last_error: `issue agent resume failed: ${result.text.slice(0, 500)}`,
      });
      await postIssueNote(
        config,
        task.gitlab_project_id,
        task.issue_iid,
        `⚠️ Spirit 续跑失败。\n\n\`\`\`\n${result.text.slice(0, 1000)}\n\`\`\``,
        task.iteration_count,
        result.durationMs,
      );
      return;
    }

    // Persist updated messages for next resume
    updateIssueTask(db, task.id, {
      agent_messages: JSON.stringify(result.messages ?? resumeMessages),
    });

    // Scan worktree for changes, commit, push, update MR — returns summary suffix
    const refreshedTask = (db.prepare("SELECT * FROM issue_tasks WHERE id = ?").get(task.id) as IssueTask) ?? task;
    const finalizeSuffix = await finalizeIteration(deps, refreshedTask, match, result.text);

    const postedNote = await postIssueNote(
      config,
      task.gitlab_project_id,
      task.issue_iid,
      result.text + finalizeSuffix,
      task.iteration_count + 1,
      result.durationMs,
    );

    updateIssueTask(db, task.id, {
      status: task.mr_iid || refreshedTask.mr_iid ? "wip" : "active",
      last_note_id: postedNote?.id ?? latestCommentId,
      last_error: null,
    });
  } catch (err) {
    logger.error(`Resume iteration failed for task ${task.id}:`, err);
    updateIssueTask(db, task.id, {
      last_error: String(err).slice(0, 1000),
    });
  }
}

async function postIssueNote(
  config: Config,
  projectId: number,
  issueIid: number,
  body: string,
  iteration: number,
  durationMs: number,
): Promise<GitlabNote | null> {
  try {
    return await createIssueNote({
      gitlabUrl: config.gitlab.url,
      token: config.gitlab.token,
      projectId,
      issueIid,
      body: wrapNote(body, iteration, durationMs),
    });
  } catch (err) {
    logger.error(`Failed to post note on issue #${issueIid}:`, err);
    return null;
  }
}

/**
 * Utility used by the poller to filter for human comments that are newer than
 * the last one Spirit processed. Excludes system notes and notes authored by
 * Spirit itself (marked with SPIRIT_NOTE_MARKER in the body).
 */
export function selectNewHumanComments(
  notes: GitlabNote[],
  lastNoteId: number,
): GitlabNote[] {
  return notes.filter(
    (n) => !isSpiritNote(n) && n.id > lastNoteId && n.body.trim().length > 0,
  );
}

/**
 * Resolve GitLab project_id for each configured codeRoot exactly once.
 * Returned map is keyed by gitlabProjectPath.
 */
export async function resolveAllProjectIds(config: Config): Promise<Map<string, number>> {
  const seen = new Map<string, number>();
  const paths = new Set<string>();
  for (const env of config.environments) {
    for (const cr of env.codeRoots) paths.add(cr.gitlabProjectPath);
  }
  for (const p of paths) {
    try {
      const id = await getProjectId(config.gitlab.url, config.gitlab.token, p);
      seen.set(p, id);
    } catch (err) {
      logger.warn(`Failed to resolve GitLab project_id for ${p}:`, err);
    }
  }
  return seen;
}

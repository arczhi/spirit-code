import type Database from "better-sqlite3";
import { logger } from "../shared/logger.js";
import { getIssueNotes, type GitlabNote } from "../shared/gitlab-api.js";
import { listIssueTasks, type IssueTask } from "../shared/issue-task-store.js";
import type { Config } from "../shared/config.js";
import { selectNewHumanComments, resolveCodeRoot } from "./issue-orchestrator.js";
import { reconcileTaskState } from "./issue-finalizer.js";

type NewCommentHandler = (task: IssueTask, newComments: GitlabNote[]) => Promise<void>;

/**
 * Poll issue comments for all active issue_tasks. When new developer comments
 * appear (past `last_note_id` and not authored by Spirit), fire `onNewComment`.
 */
export class IssueCommentWatcher {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private config: Config,
    private db: Database.Database,
    private onNewComment: NewCommentHandler,
  ) {}

  start() {
    const iw = this.config.watcher.issueWatcher;
    if (!iw.enabled) return;

    logger.info(
      `Issue comment watcher starting (interval=${iw.commentPollingInterval / 1000}s)`,
    );
    this.poll().catch((e) => logger.error("Initial comment poll failed:", e));
    this.timer = setInterval(
      () => this.poll().catch((e) => logger.error("Comment poll failed:", e)),
      iw.commentPollingInterval,
    );
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info("Issue comment watcher stopped");
  }

  private async poll() {
    const tasks = listIssueTasks(this.db, { status: ["active", "pending", "wip"], limit: 100 });
    if (tasks.length === 0) return;

    const deps = { config: this.config, db: this.db };

    for (const task of tasks) {
      try {
        const match = resolveCodeRoot(this.config, task.gitlab_project_path);
        if (!match) {
          logger.warn(`Task ${task.id.slice(0, 8)}: codeRoot unresolvable, skipping`);
          continue;
        }

        // Step 1: reconcile against GitLab state — skip task if issue/MR is terminal
        const terminal = await reconcileTaskState(deps, task, match);
        if (terminal) continue;

        // Step 2: look for new developer comments
        const notes = await getIssueNotes(
          this.config.gitlab.url,
          this.config.gitlab.token,
          task.gitlab_project_id,
          task.issue_iid,
        );
        const newComments = selectNewHumanComments(notes, task.last_note_id);
        if (newComments.length === 0) continue;

        logger.info(
          `Issue #${task.issue_iid}: ${newComments.length} new human comment(s) since note ${task.last_note_id}`,
        );
        await this.onNewComment(task, newComments);
      } catch (err) {
        logger.error(`Comment poll failed for issue #${task.issue_iid}:`, err);
      }
    }
  }
}

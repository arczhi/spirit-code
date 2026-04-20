import type Database from "better-sqlite3";
import { logger } from "../shared/logger.js";
import { listIssues, type GitlabIssue } from "../shared/gitlab-api.js";
import { findIssueTaskByIssue } from "../shared/issue-task-store.js";
import type { Config } from "../shared/config.js";

type NewIssueHandler = (projectPath: string, projectId: number, issue: GitlabIssue) => Promise<void>;

/**
 * Poll each configured GitLab project for issues that match the configured
 * label. When a new (unseen) issue is found, fire `onNewIssue`. State is
 * persisted in the issue_tasks table — no in-memory watermark beyond that.
 */
export class IssueWatcher {
  private timer: NodeJS.Timeout | null = null;
  private firstRun = true;

  constructor(
    private config: Config,
    private db: Database.Database,
    private projectIds: Map<string, number>,       // projectPath -> project_id
    private onNewIssue: NewIssueHandler,
  ) {}

  start() {
    const iw = this.config.watcher.issueWatcher;
    if (!iw.enabled) {
      logger.info("Issue watcher disabled (watcher.issueWatcher.enabled=false)");
      return;
    }
    if (this.projectIds.size === 0) {
      logger.warn("Issue watcher has no resolvable projects, not starting");
      return;
    }

    logger.info(
      `Issue watcher starting (interval=${iw.issuePollingInterval / 1000}s, label='${iw.label}', projects=${this.projectIds.size})`,
    );
    this.poll().catch((e) => logger.error("Initial issue poll failed:", e));
    this.timer = setInterval(
      () => this.poll().catch((e) => logger.error("Issue poll failed:", e)),
      iw.issuePollingInterval,
    );
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info("Issue watcher stopped");
  }

  private async poll() {
    const iw = this.config.watcher.issueWatcher;

    for (const [projectPath, projectId] of this.projectIds) {
      try {
        const issues = await listIssues({
          gitlabUrl: this.config.gitlab.url,
          token: this.config.gitlab.token,
          projectId,
          state: "opened",
          labels: iw.label,
          perPage: 50,
        });

        if (issues.length === 0) continue;

        // On first run we just reconcile (existing tasks in DB won't re-fire).
        // On subsequent runs we still check DB — idempotent by design.
        logger.debug(`Issue poll [${projectPath}]: ${issues.length} open issue(s) with label '${iw.label}'`);

        for (const issue of issues) {
          const existing = findIssueTaskByIssue(this.db, projectId, issue.iid);
          // Skip issues that are already being handled or completed
          if (existing && existing.status !== "pending" && existing.status !== "failed") continue;
          try {
            await this.onNewIssue(projectPath, projectId, issue);
          } catch (err) {
            logger.error(`onNewIssue failed for #${issue.iid} in ${projectPath}:`, err);
          }
        }
      } catch (err) {
        logger.error(`Issue poll failed for ${projectPath}:`, err);
      }
    }

    this.firstRun = false;
  }
}

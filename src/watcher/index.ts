import { randomUUID } from "node:crypto";
import { loadConfig } from "../shared/config.js";
import { initDb, createIncident, findByFingerprint, incrementCount, updateIncident, recomputeFingerprints, listIncidents } from "../shared/incident-store.js";
import { initIssueTaskStore } from "../shared/issue-task-store.js";
import { generateFingerprint } from "../shared/fingerprint.js";
import { isSameIssue } from "../shared/semantic-dedup.js";
import { logger } from "../shared/logger.js";
import { EsPoller, type ErrorEvent } from "./es-poller.js";
import { FileWatcher } from "./file-watcher.js";
import { analyzeError } from "./analyzer.js";
import { autoFix, handleMrReview } from "./auto-fix.js";
import { MrCommentPoller } from "./mr-comment-poller.js";
import { IssueWatcher } from "./issue-poller.js";
import { IssueCommentWatcher } from "./issue-comment-poller.js";
import { handleNewIssue, handleNewComments, resolveAllProjectIds } from "./issue-orchestrator.js";

const config = loadConfig();
const db = initDb(config.storage.path);

// Migrate old fingerprints to new normalized format
recomputeFingerprints(db, generateFingerprint);

// Ensure issue_tasks table exists (Issue-driven development workflow)
initIssueTaskStore(db);

const esPoller = new EsPoller(config.environments, config.watcher.esPollingInterval, handleErrors);

const fileWatchers: FileWatcher[] = [];
for (const env of config.environments) {
  if (env.logFiles.length > 0) {
    fileWatchers.push(new FileWatcher(env.name, env.logFiles, handleErrors));
  }
}

// Processing queue to avoid concurrent analysis of same batch
let processing = false;
const queue: ErrorEvent[][] = [];

// Track incidents currently being re-analyzed to prevent duplicate work
const reanalyzingIncidents = new Set<string>();

function handleErrors(errors: ErrorEvent[]) {
  queue.push(errors);
  processQueue();
}

async function processQueue() {
  if (processing) return;
  processing = true;

  while (queue.length > 0) {
    const batch = queue.shift()!;
    await processBatch(batch);
  }

  processing = false;
}

async function processBatch(errors: ErrorEvent[]) {
  // Step 1: Group errors by fingerprint
  // fingerprint.ts already normalizes UUIDs, trace IDs, timestamps, hex, URLs, file:line
  // so distinct fingerprints in the same batch represent distinct bugs.
  // Cross-batch / historical dedup is handled by the DB comparison below.
  const groups = new Map<string, ErrorEvent[]>();
  for (const err of errors) {
    const fp = generateFingerprint(err.message, err.stackTrace);
    const existing = groups.get(fp) ?? [];
    existing.push(err);
    groups.set(fp, existing);
  }

  logger.info(`processBatch: ${errors.length} errors → ${groups.size} fingerprint groups`);

  // Step 2: Process incidents in parallel with concurrency limit
  const concurrencyLimit = config.watcher.maxConcurrentFixes;
  const entries = Array.from(groups.entries());

  for (let i = 0; i < entries.length; i += concurrencyLimit) {
    const batch = entries.slice(i, i + concurrencyLimit);
    const tasks: Promise<void>[] = [];

    for (const [fp, groupErrors] of batch) {
    // Wrap each incident processing in a promise for parallel execution
    const task = (async () => {
      try {
        // Dedupe check: exact fingerprint match
        const existing = findByFingerprint(db, fp, config.watcher.dedupeWindow);
        if (existing) {
          incrementCount(db, existing.id);
          logger.debug(`Dedupe: incident ${existing.id} count bumped (fp: ${fp.slice(0, 12)})`);

          // If incident was reopened (status=open), re-trigger analysis and auto-fix
          // But skip if already being re-analyzed to prevent duplicate work
          if (existing.status === "open" && !reanalyzingIncidents.has(existing.id)) {
            reanalyzingIncidents.add(existing.id);
            logger.info(`Incident ${existing.id.slice(0, 8)} is open, re-triggering analysis and auto-fix`);

            try {
              const representative = groupErrors[0];
              const envConfig = config.environments.find((e) => e.name === representative.env);
              if (!envConfig) {
                logger.warn(`No environment config for ${representative.env}`);
                return;
              }

              const codeRoot = envConfig.codeRoots.find((r) => r.name === representative.service) ?? envConfig.codeRoots[0];
              if (!codeRoot) {
                logger.warn(`No code root for service ${representative.service}`);
                return;
              }

              // Re-analyze with Claude
              const analysis = await analyzeError({
                errors: groupErrors,
                codeRootPath: codeRoot.path,
                config,
              });

              // Update incident with new analysis
              updateIncident(db, existing.id, {
                analysis: analysis.diagnosis,
                risk_level: analysis.riskLevel,
                fix_plan: analysis.fixPlan ? JSON.stringify(analysis.fixPlan) : null,
                suspected_files: JSON.stringify(analysis.suspectedFiles),
              });

              // Re-run auto-fix (will run in parallel with other incidents)
              await autoFix({
                incident: { ...db.prepare("SELECT * FROM incidents WHERE id = ?").get(existing.id) as any },
                analysis,
                codeRoot,
                config,
                db,
              });
            } finally {
              reanalyzingIncidents.delete(existing.id);
            }
          } else if (existing.status === "open" && reanalyzingIncidents.has(existing.id)) {
            logger.debug(`Incident ${existing.id.slice(0, 8)} is already being re-analyzed, skipping duplicate work`);
          }

          return;
        }

        const representative = groupErrors[0];

        // Semantic dedup against DB: check both open incidents AND resolved incidents with active MRs
        const recentIncidents = [
          ...listIncidents(db, { env: representative.env, status: "open", limit: 10 }),
          ...listIncidents(db, { env: representative.env, status: "resolved", limit: 10 })
            .filter((inc: any) => inc.mr_url), // Only check resolved incidents with MRs
        ];

        const candidates = recentIncidents.filter((r) => r.fingerprint !== fp);
        if (candidates.length > 0) {
          logger.info(`Semantic dedupe (vs DB): checking ${candidates.length} candidate(s) for fp ${fp.slice(0, 12)}`);
        }
        for (const recent of candidates) {
          const same = await isSameIssue(representative.message, recent.title, config);
          if (same) {
            incrementCount(db, recent.id);
            const statusLabel = recent.status === "resolved" ? `(MR !${(recent as any).mr_iid})` : "(open)";
            logger.info(`Semantic dedupe (vs DB): merged into incident ${recent.id.slice(0, 8)} ${statusLabel}`);
            return;
          }
        }

        const incidentId = randomUUID();

        // Create incident
        createIncident(db, {
          id: incidentId,
          fingerprint: fp,
          title: representative.message.slice(0, 200),
          env: representative.env,
          service: representative.service,
          level: representative.level,
          count: groupErrors.length,
          first_seen: representative.timestamp,
          last_seen: groupErrors[groupErrors.length - 1].timestamp,
          sample_logs: JSON.stringify(groupErrors.slice(0, 5).map((e) => e.message)),
        });

        logger.info(`New incident ${incidentId.slice(0, 8)}: [${representative.env}/${representative.service}] ${representative.message.slice(0, 80)}`);

        // Find matching code root
        const envConfig = config.environments.find((e) => e.name === representative.env);
        if (!envConfig) {
          logger.warn(`No environment config for ${representative.env}`);
          return;
        }

        const codeRoot = envConfig.codeRoots.find((r) => r.name === representative.service) ?? envConfig.codeRoots[0];
        if (!codeRoot) {
          logger.warn(`No code root for service ${representative.service} in env ${representative.env}`);
          return;
        }

        // Analyze with Claude
        const analysis = await analyzeError({
          errors: groupErrors,
          codeRootPath: codeRoot.path,
          config,
        });

        // Update incident with analysis
        updateIncident(db, incidentId, {
          analysis: analysis.diagnosis,
          risk_level: analysis.riskLevel,
          fix_plan: analysis.fixPlan ? JSON.stringify(analysis.fixPlan) : null,
          suspected_files: JSON.stringify(analysis.suspectedFiles),
        });

        // Auto-fix if applicable (will run in parallel with other incidents)
        await autoFix({
          incident: { ...db.prepare("SELECT * FROM incidents WHERE id = ?").get(incidentId) as any },
          analysis,
          codeRoot,
          config,
          db,
        });
      } catch (err) {
        logger.error(`Failed to process error group (fp: ${fp.slice(0, 12)}):`, err);
      }
    })();

      tasks.push(task);
    }

    // Wait for current batch to complete before starting next batch
    await Promise.all(tasks);
  }
}

// MR Comment Poller - 监听 PR 评论并触发自动修复
const mrCommentPoller = new MrCommentPoller(
  config,
  db,
  config.watcher.mrCommentPollingInterval ?? 60000, // 默认 60 秒
  async (incidentId: string, mrIid: number) => {
    try {
      logger.info(`Processing MR comment for incident ${incidentId.slice(0, 8)}, MR !${mrIid}`);

      // 获取 incident 完整信息
      const incident = db.prepare("SELECT * FROM incidents WHERE id = ?").get(incidentId) as any;
      if (!incident) {
        logger.warn(`Incident ${incidentId} not found`);
        return;
      }

      // 找到对应的 code root
      const envConfig = config.environments.find((e) => e.name === incident.env);
      if (!envConfig) {
        logger.warn(`No environment config for ${incident.env}`);
        return;
      }

      const codeRoot = envConfig.codeRoots.find((r) => r.name === incident.service) ?? envConfig.codeRoots[0];
      if (!codeRoot) {
        logger.warn(`No code root for service ${incident.service}`);
        return;
      }

      // 调用 handleMrReview 处理评论
      await handleMrReview({
        incident,
        codeRoot,
        config,
        db,
      });

      logger.info(`MR comment processed for incident ${incidentId.slice(0, 8)}`);
    } catch (err) {
      logger.error(`Failed to handle MR comment for incident ${incidentId}:`, err);
    }
  }
);

// Graceful shutdown
function shutdown() {
  logger.info("Spirit Watcher shutting down...");
  esPoller.stop();
  for (const fw of fileWatchers) fw.stop();
  mrCommentPoller.stop();
  issueWatcher?.stop();
  issueCommentWatcher?.stop();
  db.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start
logger.info("=== Spirit 精灵 Watcher starting ===");
logger.info(`Environments: ${config.environments.map((e) => e.name).join(", ")}`);
logger.info(`ES polling interval: ${config.watcher.esPollingInterval}s`);
logger.info(`Dedupe window: ${config.watcher.dedupeWindow}s`);
logger.info(`Max concurrent fixes: ${config.watcher.maxConcurrentFixes}`);
logger.info(`Auto-fix risk levels: ${config.watcher.riskAutoFix.join(", ")}`);
logger.info(`Target branch: ${config.gitlab.defaultTargetBranch}`);
logger.info(`MR comment polling: ${(config.watcher.mrCommentPollingInterval ?? 60000) / 1000}s`);

esPoller.start();
for (const fw of fileWatchers) fw.start();
mrCommentPoller.start();

// Optional: Issue-driven development workflow
let issueWatcher: IssueWatcher | null = null;
let issueCommentWatcher: IssueCommentWatcher | null = null;

if (config.watcher.issueWatcher.enabled) {
  logger.info(`Issue watcher enabled (label='${config.watcher.issueWatcher.label}', preferEnv='${config.watcher.issueWatcher.preferEnv}')`);
  resolveAllProjectIds(config)
    .then((projectIds) => {
      const deps = { config, db };
      issueWatcher = new IssueWatcher(
        config,
        db,
        projectIds,
        (projectPath, projectId, issue) => handleNewIssue(deps, projectPath, projectId, issue),
      );
      issueCommentWatcher = new IssueCommentWatcher(
        config,
        db,
        (task, newComments) => handleNewComments(deps, task, newComments),
      );
      issueWatcher.start();
      issueCommentWatcher.start();
    })
    .catch((err) => logger.error("Failed to bootstrap issue watcher:", err));
}

logger.info("=== Spirit 精灵 Watcher running ===");

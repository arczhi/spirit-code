import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { logger } from "../shared/logger.js";
import * as gitOps from "../shared/git-ops.js";
import { getProjectId, createMergeRequest, getMergeRequestNotes } from "../shared/gitlab-api.js";
import { updateIncident } from "../shared/incident-store.js";
import { analyzeError, type AnalysisResult, type FixAction } from "./analyzer.js";
import type Database from "better-sqlite3";
import type { Incident } from "../shared/incident-store.js";
import type { Config, CodeRoot } from "../shared/config.js";

let activeFixes = 0;

const MAX_VERIFY_RETRIES = 2; // Claude gets 2 extra attempts to fix build errors

// Mutex per codeRoot to serialize worktree access on the shared branch
const worktreeLocks = new Map<string, Promise<void>>();

async function withWorktreeLock(codeRootPath: string, fn: () => Promise<void>): Promise<void> {
  const prev = worktreeLocks.get(codeRootPath) ?? Promise.resolve();
  const next = prev.then(fn, fn); // always chain, even if prev rejected
  worktreeLocks.set(codeRootPath, next);
  return next;
}

export async function autoFix(params: {
  incident: Incident;
  analysis: AnalysisResult;
  codeRoot: CodeRoot;
  config: Config;
  db: Database.Database;
}): Promise<void> {
  const { incident, analysis, codeRoot, config, db } = params;

  // Check risk level
  if (!config.watcher.riskAutoFix.includes(analysis.riskLevel)) {
    logger.info(`Skipping auto-fix for incident ${incident.id}: risk level ${analysis.riskLevel} not in allowed list`);
    updateIncident(db, incident.id, {
      analysis: analysis.diagnosis,
      risk_level: analysis.riskLevel,
      fix_plan: JSON.stringify(analysis.fixPlan),
      suspected_files: JSON.stringify(analysis.suspectedFiles),
    });
    return;
  }

  if (!analysis.fixPlan || analysis.fixPlan.length === 0) {
    logger.info(`No fix plan for incident ${incident.id}, skipping auto-fix`);
    return;
  }

  // Concurrency check
  if (activeFixes >= config.watcher.maxConcurrentFixes) {
    logger.warn(`Max concurrent fixes (${config.watcher.maxConcurrentFixes}) reached, skipping ${incident.id}`);
    return;
  }

  activeFixes++;

  // Use a shared branch per codeRoot — serialize access via lock
  await withWorktreeLock(codeRoot.path, async () => {
    const branchName = "spirit/auto-fix";
    const worktreeDir = join(resolve(codeRoot.path), ".worktrees", "spirit");
    const worktreePath = join(worktreeDir, "auto-fix");
    const targetBranch = config.gitlab.defaultTargetBranch;

    try {
      mkdirSync(worktreeDir, { recursive: true });

      // Update incident status
      updateIncident(db, incident.id, { status: "fixing", branch: branchName });

      // Create or reuse worktree
      const worktreeExists = existsSync(join(worktreePath, ".git"));
      if (!worktreeExists) {
        // First time: create worktree based on target branch
        logger.info(`Creating worktree for ${branchName} at ${worktreePath} (base: ${targetBranch})`);
        await gitOps.createWorktree(codeRoot.path, worktreePath, branchName, targetBranch);
      } else {
        // Worktree exists: pull latest from target branch to stay up-to-date
        logger.info(`Reusing existing worktree at ${worktreePath}, rebasing on ${targetBranch}`);
        try {
          execFileSync("git", ["fetch", "origin", targetBranch], { cwd: worktreePath, encoding: "utf-8", timeout: 30000 });
          execFileSync("git", ["rebase", `origin/${targetBranch}`], { cwd: worktreePath, encoding: "utf-8", timeout: 30000 });
        } catch (rebaseErr) {
          // If rebase fails (conflict), abort and recreate
          logger.warn("Rebase failed, recreating worktree from scratch");
          try { execFileSync("git", ["rebase", "--abort"], { cwd: worktreePath, encoding: "utf-8", timeout: 5000 }); } catch { /* ignore */ }
          await gitOps.removeWorktree(codeRoot.path, worktreePath);
          await gitOps.createWorktree(codeRoot.path, worktreePath, branchName, targetBranch);
        }
      }

      // Apply fixes
      applyFixes(worktreePath, analysis.fixPlan!);

      // Local verification loop: go vet / go build / tsc
      let verifyResult = runLocalVerification(worktreePath, codeRoot);
      let retries = 0;

      while (!verifyResult.ok && retries < MAX_VERIFY_RETRIES) {
        retries++;
        logger.warn(`Local verification failed (attempt ${retries}/${MAX_VERIFY_RETRIES}), asking Claude to fix:\n${verifyResult.error}`);

        const retryAnalysis = await requestBuildFix({
          originalAnalysis: analysis,
          buildError: verifyResult.error,
          worktreePath,
          codeRoot,
          config,
        });

        if (!retryAnalysis.fixPlan || retryAnalysis.fixPlan.length === 0) {
          logger.error(`Claude could not fix build error after attempt ${retries}`);
          break;
        }

        applyFixes(worktreePath, retryAnalysis.fixPlan);
        verifyResult = runLocalVerification(worktreePath, codeRoot);
      }

      if (!verifyResult.ok) {
        logger.error(`Local verification still failing after ${retries} retries, aborting auto-fix for ${incident.id}`);
        // Revert uncommitted changes so the worktree stays clean for next fix
        try { execFileSync("git", ["checkout", "."], { cwd: worktreePath, encoding: "utf-8", timeout: 5000 }); } catch { /* ignore */ }
        updateIncident(db, incident.id, { status: "open" });
        return;
      }

      logger.info(`Local verification passed for ${incident.id}`);

      // Commit
      const commitMsg = [
        `fix(spirit): ${incident.title.slice(0, 100)}`,
        "",
        `Incident: ${incident.id}`,
        `Risk Level: ${analysis.riskLevel}`,
        `Environment: ${incident.env}/${incident.service}`,
        "",
        `Diagnosis: ${analysis.diagnosis}`,
        "",
        "Auto-generated by Spirit 精灵",
      ].join("\n");

      const commitHash = await gitOps.commitChanges(worktreePath, commitMsg);

      // Push shared branch with force-with-lease — needed after rebase rewrites history
      await gitOps.pushBranch(worktreePath, codeRoot.gitRemote, { forceWithLease: true });

      // Cherry-pick the new commit onto a per-incident branch and push it
      const incidentBranchName = `spirit/fix-${incident.id.slice(0, 8)}`;
      await gitOps.cherryPickAndPush(
        codeRoot.path, commitHash, incidentBranchName, targetBranch, codeRoot.gitRemote,
      );

      // Create an independent MR for the per-incident branch
      const projectId = await getProjectId(config.gitlab.url, config.gitlab.token, codeRoot.gitlabProjectPath);
      const mr = await createMergeRequest({
        gitlabUrl: config.gitlab.url,
        token: config.gitlab.token,
        projectId,
        sourceBranch: incidentBranchName,
        targetBranch,
        title: `[Spirit] Fix: ${incident.title.slice(0, 80)}`,
        description: buildMrDescription(incident, analysis),
      });
      logger.info(`Created MR !${mr.iid} for incident ${incident.id.slice(0, 8)} on branch ${incidentBranchName}`);

      // Update incident with per-incident branch and MR info
      updateIncident(db, incident.id, {
        status: "resolved",
        branch: incidentBranchName,
        mr_url: mr.web_url,
        mr_iid: mr.iid,
      });

      logger.info(`Auto-fix complete for ${incident.id}: MR !${mr.iid} at ${mr.web_url}`);
    } catch (err) {
      logger.error(`Auto-fix failed for ${incident.id}:`, err);
      // Revert uncommitted changes so worktree stays clean
      try { execFileSync("git", ["checkout", "."], { cwd: worktreePath, encoding: "utf-8", timeout: 5000 }); } catch { /* ignore */ }
      updateIncident(db, incident.id, { status: "open" });
    } finally {
      // Do NOT remove worktree — it's reused for the next fix
      activeFixes--;
    }
  });
}

/**
 * Handle MR review comments: read comments, ask Claude to fix, push new commit.
 * Uses worktree lock to serialize with autoFix on the same codeRoot.
 */
export async function handleMrReview(params: {
  incident: Incident;
  codeRoot: CodeRoot;
  config: Config;
  db: Database.Database;
}): Promise<void> {
  const { incident, codeRoot, config, db } = params;

  if (!incident.mr_iid || !incident.branch) {
    logger.warn(`Incident ${incident.id} has no MR or branch, skipping review handling`);
    return;
  }

  // Capture non-null values before entering async closure (TS can't narrow across it)
  const mrIid = incident.mr_iid;
  const branch = incident.branch;

  // Serialize with autoFix using the same worktree lock
  await withWorktreeLock(codeRoot.path, async () => {
    const projectId = await getProjectId(config.gitlab.url, config.gitlab.token, codeRoot.gitlabProjectPath);

    // Fetch MR comments
    const notes = await getMergeRequestNotes(config.gitlab.url, config.gitlab.token, projectId, mrIid);

    // Filter to human comments (not system, not bot)
    const humanNotes = notes.filter((n: any) => !n.system && n.body.trim().length > 0);
    if (humanNotes.length === 0) {
      return;
    }

    const latestComment = humanNotes[humanNotes.length - 1];
    logger.info(`MR !${mrIid} has review comment from ${latestComment.author.username}: ${latestComment.body.slice(0, 100)}`);

    // Use the same shared worktree as autoFix (serialized via withWorktreeLock)
    const sharedBranch = "spirit/auto-fix";
    const targetBranch = config.gitlab.defaultTargetBranch;
    const worktreeDir = join(resolve(codeRoot.path), ".worktrees", "spirit");
    const worktreePath = join(worktreeDir, "auto-fix");

    try {
      mkdirSync(worktreeDir, { recursive: true });

      const worktreeExists = existsSync(join(worktreePath, ".git"));
      if (!worktreeExists) {
        logger.info(`Creating shared worktree for review at ${worktreePath} (base: ${targetBranch})`);
        await gitOps.createWorktree(codeRoot.path, worktreePath, sharedBranch, targetBranch);
      } else {
        // Sync shared branch onto latest target branch
        logger.info(`Reusing shared worktree at ${worktreePath}, rebasing on ${targetBranch}`);
        try {
          execFileSync("git", ["fetch", "origin", targetBranch], { cwd: worktreePath, encoding: "utf-8", timeout: 30000 });
          execFileSync("git", ["rebase", `origin/${targetBranch}`], { cwd: worktreePath, encoding: "utf-8", timeout: 30000 });
        } catch {
          logger.warn("Rebase failed, recreating shared worktree from scratch");
          try { execFileSync("git", ["rebase", "--abort"], { cwd: worktreePath, encoding: "utf-8", timeout: 5000 }); } catch { /* ignore */ }
          await gitOps.removeWorktree(codeRoot.path, worktreePath);
          await gitOps.createWorktree(codeRoot.path, worktreePath, sharedBranch, targetBranch);
        }
      }

      // Read the per-incident branch's changed files (the MR's actual diff scope)
      let changedFilesContext = "";
      const changedFilesList: string[] = [];
      try {
        execFileSync("git", ["fetch", codeRoot.gitRemote, branch], { cwd: worktreePath, encoding: "utf-8", timeout: 30000 });
        const diffOutput = execFileSync("git", ["diff", "--name-only", `${codeRoot.gitRemote}/${targetBranch}...${codeRoot.gitRemote}/${branch}`], {
          cwd: worktreePath, encoding: "utf-8", timeout: 10000,
        });
        for (const f of diffOutput.trim().split("\n").filter(Boolean).slice(0, 10)) {
          changedFilesList.push(f);
          const fullPath = join(worktreePath, f);
          try {
            const content = readFileSync(fullPath, "utf-8");
            if (content.length < 30000) {
              changedFilesContext += `\n\n--- File: ${f} ---\n${content}`;
            }
          } catch { /* skip */ }
        }
      } catch (err) {
        logger.warn(`Failed to compute changed files for incident branch ${branch}:`, err);
      }

      // Read imported dependency files for deeper context (Go files)
      const importedFiles = extractGoImportedFiles(worktreePath, changedFilesList);
      for (const f of importedFiles) {
        const fullPath = join(worktreePath, f);
        try {
          const content = readFileSync(fullPath, "utf-8");
          if (content.length < 20000) {
            changedFilesContext += `\n\n--- Dependency File: ${f} ---\n${content}`;
          }
        } catch { /* skip */ }
      }

      // Build review comments context
      const commentsText = humanNotes.map((n: any) =>
        `[${n.author.username}] ${n.body}`
      ).join("\n---\n");

      // Ask Claude to address the review
      const reviewFix = await requestReviewFix({
        reviewComments: commentsText,
        changedFilesContext,
        worktreePath,
        codeRoot,
        config,
      });

      if (!reviewFix.fixPlan || reviewFix.fixPlan.length === 0) {
        logger.info(`Claude has no changes for MR !${mrIid} review`);
        return;
      }

      // Apply fixes
      applyFixes(worktreePath, reviewFix.fixPlan);

      // Verify
      const verifyResult = runLocalVerification(worktreePath, codeRoot);
      if (!verifyResult.ok) {
        logger.error(`Review fix failed verification: ${verifyResult.error}`);
        // One retry
        const retryFix = await requestBuildFix({
          originalAnalysis: reviewFix,
          buildError: verifyResult.error,
          worktreePath,
          codeRoot,
          config,
        });
        if (retryFix.fixPlan && retryFix.fixPlan.length > 0) {
          applyFixes(worktreePath, retryFix.fixPlan);
          const retry2 = runLocalVerification(worktreePath, codeRoot);
          if (!retry2.ok) {
            logger.error(`Review fix still failing after retry, aborting`);
            return;
          }
        } else {
          return;
        }
      }

      // Commit to shared branch
      const reviewCommitMessage = `fix(spirit): address review feedback\n\n${latestComment.body.slice(0, 200)}\n\nAuto-generated by Spirit 精灵`;
      const reviewCommitHash = await gitOps.commitChanges(worktreePath, reviewCommitMessage);

      // Push shared branch (force-with-lease — rebase rewrites history)
      await gitOps.pushBranch(worktreePath, codeRoot.gitRemote, { forceWithLease: true });

      // Cherry-pick the review commit to the per-incident branch — this updates the MR
      await gitOps.cherryPickAndPush(
        codeRoot.path, reviewCommitHash, branch, targetBranch, codeRoot.gitRemote,
      );

      logger.info(`Pushed review fix for MR !${mrIid} via cherry-pick to ${branch}`);
    } catch (err) {
      logger.error(`Review fix failed for MR !${mrIid}:`, err);
    }
    // Do NOT remove worktree — it's the shared autoFix worktree, reused across runs
  });
}

// ─── Helpers ────────────────────────────────────────────────

function applyFixes(worktreePath: string, fixes: FixAction[]) {
  for (const fix of fixes) {
    logger.info(`Applying fix: ${fix.filePath} — ${fix.description}`);
    const fullPath = resolve(worktreePath, fix.filePath);
    if (fix.oldContent) {
      applySearchReplace(worktreePath, fix.filePath, fix.oldContent, fix.newContent);
    } else {
      // Full file write
      const { mkdirSync: mk } = require("node:fs");
      const { dirname } = require("node:path");
      mk(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, fix.newContent, "utf-8");
    }
  }
}

interface VerifyResult {
  ok: boolean;
  error: string;
}

function runLocalVerification(worktreePath: string, codeRoot: CodeRoot): VerifyResult {
  // Detect project type from code root
  const isGo = codeRoot.name === "backend" || existsFile(join(worktreePath, "go.mod"));
  const isNode = codeRoot.name === "frontend" || existsFile(join(worktreePath, "package.json"));

  const errors: string[] = [];

  if (isGo) {
    // Detect build targets: prefer ./cmd/... or specific packages over ./...
    // This avoids "main redeclared" errors in projects with multiple main packages
    const buildTargets = detectGoBuildTargets(worktreePath);
    const vetTarget = buildTargets.length > 0 ? buildTargets : ["./..."];

    // Run go vet on each target
    for (const target of vetTarget) {
      try {
        execFileSync("go", ["vet", target], {
          cwd: worktreePath, encoding: "utf-8", timeout: 60000,
          env: { ...process.env, GOFLAGS: "-mod=mod" },
        });
        logger.info(`go vet ${target}: PASS`);
      } catch (err: any) {
        const output = (err.stderr || err.stdout || String(err)).slice(0, 2000);
        // Skip "main redeclared" errors from root package — these are project structure issues, not our bug
        if (output.includes("main redeclared") && target === "./...") {
          logger.warn(`go vet ./...: skipping "main redeclared" (multi-main project), retrying with sub-packages`);
          const subTargets = detectGoBuildTargets(worktreePath);
          if (subTargets.length > 0) {
            for (const sub of subTargets) {
              try {
                execFileSync("go", ["vet", sub], {
                  cwd: worktreePath, encoding: "utf-8", timeout: 60000,
                  env: { ...process.env, GOFLAGS: "-mod=mod" },
                });
                logger.info(`go vet ${sub}: PASS`);
              } catch (subErr: any) {
                const subOutput = (subErr.stderr || subErr.stdout || String(subErr)).slice(0, 2000);
                if (!subOutput.includes("main redeclared")) {
                  logger.error(`go vet ${sub}: FAIL\n` + subOutput);
                  errors.push(`go vet ${sub} failed:\n${subOutput}`);
                }
              }
            }
          }
          continue;
        }
        logger.error(`go vet ${target}: FAIL\n` + output);
        errors.push(`go vet ${target} failed:\n${output}`);
      }
    }

    // Run go build on each target
    for (const target of vetTarget) {
      try {
        execFileSync("go", ["build", target], {
          cwd: worktreePath, encoding: "utf-8", timeout: 120000,
          env: { ...process.env, GOFLAGS: "-mod=mod" },
        });
        logger.info(`go build ${target}: PASS`);
      } catch (err: any) {
        const output = (err.stderr || err.stdout || String(err)).slice(0, 2000);
        if (output.includes("main redeclared") && target === "./...") {
          logger.warn(`go build ./...: skipping "main redeclared", retrying with sub-packages`);
          const subTargets = detectGoBuildTargets(worktreePath);
          if (subTargets.length > 0) {
            for (const sub of subTargets) {
              try {
                execFileSync("go", ["build", sub], {
                  cwd: worktreePath, encoding: "utf-8", timeout: 120000,
                  env: { ...process.env, GOFLAGS: "-mod=mod" },
                });
                logger.info(`go build ${sub}: PASS`);
              } catch (subErr: any) {
                const subOutput = (subErr.stderr || subErr.stdout || String(subErr)).slice(0, 2000);
                if (!subOutput.includes("main redeclared")) {
                  logger.error(`go build ${sub}: FAIL\n` + subOutput);
                  errors.push(`go build ${sub} failed:\n${subOutput}`);
                }
              }
            }
          }
          continue;
        }
        logger.error(`go build ${target}: FAIL\n` + output);
        errors.push(`go build ${target} failed:\n${output}`);
      }
    }
  }

  if (isNode) {
    // Run tsc --noEmit
    try {
      execFileSync("npx", ["tsc", "--noEmit"], {
        cwd: worktreePath, encoding: "utf-8", timeout: 60000,
      });
      logger.info("tsc: PASS");
    } catch (err: any) {
      const output = (err.stderr || err.stdout || String(err)).slice(0, 2000);
      logger.error("tsc: FAIL\n" + output);
      errors.push(`tsc failed:\n${output}`);
    }
  }

  if (errors.length === 0) {
    return { ok: true, error: "" };
  }
  return { ok: false, error: errors.join("\n\n") };
}

function existsFile(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect Go build targets for projects with multiple main packages.
 * Returns paths like ["./cmd/web/...", "./cmd/worker/...", "./internal/..."]
 */
function detectGoBuildTargets(worktreePath: string): string[] {
  const targets: string[] = [];

  // Check for cmd/ directory (common Go project layout)
  const cmdDir = join(worktreePath, "cmd");
  if (existsFile(join(cmdDir, "."))) {
    try {
      const { readdirSync } = require("node:fs");
      const entries = readdirSync(cmdDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          targets.push(`./cmd/${entry.name}/...`);
        }
      }
    } catch { /* skip */ }
  }

  // Check for internal/ directory
  if (existsFile(join(worktreePath, "internal"))) {
    targets.push("./internal/...");
  }

  // Check for pkg/ directory
  if (existsFile(join(worktreePath, "pkg"))) {
    targets.push("./pkg/...");
  }

  // If we found Makefile, try to extract build targets (source paths, not -o output paths)
  try {
    const makefile = readFileSync(join(worktreePath, "Makefile"), "utf-8");
    for (const line of makefile.split("\n")) {
      // Match: go build [-flags...] <source>
      // Skip -o and its argument, then capture the last token as the source target
      const m = line.match(/go\s+build\s+(.*)/);
      if (!m) continue;
      const args = m[1].trim();
      // Split into tokens respecting shell quoting
      const tokens = args.match(/\S+/g) || [];
      // Walk tokens: skip flags and their values, find the source target
      let i = 0;
      let sourceTarget: string | null = null;
      while (i < tokens.length) {
        const tok = tokens[i];
        if (tok === "-o" && i + 1 < tokens.length) {
          i += 2; // skip -o and its value (the output binary path)
          continue;
        }
        if (tok.startsWith("-")) {
          // Flags like -v, -race, -ldflags (with next token as value)
          if (["-ldflags", "-gcflags", "-asmflags", "-tags", "-mod", "-trimpath"].some(f => tok.startsWith(f) && tok === f)) {
            i += 2; // flag + value
          } else {
            i += 1; // boolean flag
          }
          continue;
        }
        // Non-flag token = source target (e.g. "./cmd/...", "web.go", "./...")
        sourceTarget = tok;
        break;
      }
      // Only add Go package paths (./...), not individual .go files
      // Individual .go files in root are handled by the ./internal/... fallback
      if (sourceTarget && sourceTarget.startsWith("./") && !sourceTarget.endsWith(".go") && !targets.includes(sourceTarget)) {
        targets.push(sourceTarget);
      }
    }
  } catch { /* no Makefile */ }

  return targets;
}

/**
 * Ask Claude to fix a build error in the worktree.
 */
async function requestBuildFix(params: {
  originalAnalysis: AnalysisResult;
  buildError: string;
  worktreePath: string;
  codeRoot: CodeRoot;
  config: Config;
}): Promise<AnalysisResult> {
  const { originalAnalysis, buildError, worktreePath, codeRoot, config } = params;
  const Anthropic = (await import("@anthropic-ai/sdk")).default;

  const baseURL = config.claude.baseUrl.replace(/\/v1\/?$/, "");
  const client = new Anthropic({ apiKey: config.claude.apiKey, baseURL, maxRetries: 0, timeout: 120_000 });

  // Read the files that were modified
  let modifiedContext = "";
  for (const fix of originalAnalysis.fixPlan ?? []) {
    const fullPath = resolve(worktreePath, fix.filePath);
    try {
      const content = readFileSync(fullPath, "utf-8");
      if (content.length < 30000) {
        modifiedContext += `\n\n--- File: ${fix.filePath} (current state) ---\n${content}`;
      }
    } catch { /* skip */ }
  }

  const prompt = `The previous auto-fix caused a build error. Fix it.

## Build Error
${buildError}

## Modified Files (current state after previous fix)
${modifiedContext}

## Original Diagnosis
${originalAnalysis.diagnosis}

## CRITICAL Go Rules
- Every import MUST be used. If the build error is "imported and not used", DELETE the unused import line.
- No unused variables allowed. Remove or use them.
- Check that all function calls match their signatures in the provided code.
- Verify struct field access matches the struct definition.
- Read the FULL file content above carefully before proposing changes.

## Self-check before responding:
- [ ] Every import in the modified file is actually used after your fix
- [ ] No unused variables remain
- [ ] The fix addresses the exact build error shown above

Respond with ONLY a JSON object:
{"diagnosis":"what went wrong","riskLevel":"${originalAnalysis.riskLevel}","suspectedFiles":[],"fixPlan":[{"filePath":"...","description":"...","oldContent":"exact lines to replace","newContent":"replacement lines"}]}`;

  try {
    const response = await client.messages.create({
      model: config.claude.model,
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((b: any): b is { type: "text"; text: string } => b.type === "text")
      .map((b: any) => b.text).join("");

    return parseJson(text);
  } catch (err) {
    logger.error("requestBuildFix failed:", err);
    return { diagnosis: `Build fix failed: ${err}`, riskLevel: "C", suspectedFiles: [], fixPlan: null };
  }
}

/**
 * Ask Claude to address MR review comments.
 */
async function requestReviewFix(params: {
  reviewComments: string;
  changedFilesContext: string;
  worktreePath: string;
  codeRoot: CodeRoot;
  config: Config;
}): Promise<AnalysisResult> {
  const { reviewComments, changedFilesContext, config } = params;
  const Anthropic = (await import("@anthropic-ai/sdk")).default;

  const baseURL = config.claude.baseUrl.replace(/\/v1\/?$/, "");
  const client = new Anthropic({ apiKey: config.claude.apiKey, baseURL, maxRetries: 0, timeout: 120_000 });

  const prompt = `A developer reviewed the auto-fix MR and left comments. Address their feedback.

## Review Comments
${reviewComments}

## Current Changed Files
${changedFilesContext}

## CRITICAL: Read ALL code context before making changes

You MUST:
1. Read the FULL content of every file provided above, not just the lines mentioned in comments
2. Understand the import dependencies, function signatures, and struct definitions
3. Apply the reviewer's requested changes precisely

### Go-specific rules (MANDATORY for .go files):
- Every import MUST be used. If your change removes usage of an import, DELETE that import line.
- If your change adds a new function call from another package, ADD the required import.
- No unused variables allowed.
- All error returns must be checked (\`if err != nil\`).
- Verify function signatures and struct fields match the provided code context.

### Self-check before responding:
- [ ] Every import in the modified file is actually used after your fix
- [ ] No unused variables remain
- [ ] All referenced functions/types exist in the provided code
- [ ] The fix matches what the reviewer asked for

Apply the reviewer's requested changes. Respond with ONLY a JSON object:
{"diagnosis":"summary of review feedback","riskLevel":"B","suspectedFiles":[],"fixPlan":[{"filePath":"...","description":"...","oldContent":"exact lines to replace","newContent":"replacement lines"}]}`;

  try {
    const response = await client.messages.create({
      model: config.claude.model,
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((b: any): b is { type: "text"; text: string } => b.type === "text")
      .map((b: any) => b.text).join("");

    return parseJson(text);
  } catch (err) {
    logger.error("requestReviewFix failed:", err);
    return { diagnosis: `Review fix failed: ${err}`, riskLevel: "C", suspectedFiles: [], fixPlan: null };
  }
}

function parseJson(text: string): AnalysisResult {
  try { return JSON.parse(text); } catch { /* continue */ }
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* continue */ } }
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s >= 0 && e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch { /* continue */ } }
  return { diagnosis: text.slice(0, 2000), riskLevel: "C", suspectedFiles: [], fixPlan: null };
}

function buildMrDescription(incident: Incident, analysis: AnalysisResult): string {
  const sampleLogs = incident.sample_logs
    ? JSON.parse(incident.sample_logs).slice(0, 3).join("\n")
    : "(no sample logs)";

  return [
    "## Spirit 精灵 Auto-Fix",
    "",
    `**Incident:** \`${incident.id}\``,
    `**Environment:** ${incident.env} / ${incident.service}`,
    `**Risk Level:** ${analysis.riskLevel}`,
    `**Error Count:** ${incident.count}`,
    `**First Seen:** ${incident.first_seen}`,
    `**Last Seen:** ${incident.last_seen}`,
    "",
    "### Diagnosis",
    "",
    analysis.diagnosis,
    "",
    "### Sample Error Logs",
    "",
    "```",
    sampleLogs,
    "```",
    "",
    "### Changes",
    "",
    ...(analysis.fixPlan ?? []).map((f) => `- \`${f.filePath}\`: ${f.description}`),
    "",
    "---",
    "*Auto-generated by Spirit 精灵. Please review before merging.*",
    "*Leave a comment on this MR and Spirit will read it and push a fix commit.*",
  ].join("\n");
}

function applySearchReplace(worktreePath: string, filePath: string, oldContent: string, newContent: string): void {
  const fullPath = resolve(worktreePath, filePath);
  const original = readFileSync(fullPath, "utf-8");

  const normalizeWs = (s: string) => s.split("\n").map((l) => l.trimEnd()).join("\n");
  const normalizedOriginal = normalizeWs(original);
  const normalizedOld = normalizeWs(oldContent);

  if (normalizedOriginal.includes(normalizedOld)) {
    const result = original.replace(oldContent.trimEnd(), newContent.trimEnd());
    if (result === original) {
      const result2 = normalizedOriginal.replace(normalizedOld, normalizeWs(newContent));
      writeFileSync(fullPath, result2, "utf-8");
    } else {
      writeFileSync(fullPath, result, "utf-8");
    }
    logger.info(`Applied search-replace to ${filePath}`);
  } else {
    const oldLines = normalizedOld.split("\n").filter((l) => l.trim().length > 0);
    if (oldLines.length >= 2) {
      const firstLine = oldLines[0].trim();
      const lastLine = oldLines[oldLines.length - 1].trim();
      const origLines = normalizedOriginal.split("\n");

      let startIdx = -1, endIdx = -1;
      for (let i = 0; i < origLines.length; i++) {
        if (origLines[i].trim() === firstLine) { startIdx = i; break; }
      }
      if (startIdx >= 0) {
        for (let i = startIdx; i < origLines.length; i++) {
          if (origLines[i].trim() === lastLine) { endIdx = i; break; }
        }
      }

      if (startIdx >= 0 && endIdx >= startIdx) {
        const before = origLines.slice(0, startIdx);
        const after = origLines.slice(endIdx + 1);
        const result = [...before, ...newContent.split("\n"), ...after].join("\n");
        writeFileSync(fullPath, result, "utf-8");
        logger.info(`Applied fuzzy search-replace to ${filePath} (lines ${startIdx + 1}-${endIdx + 1})`);
      } else {
        logger.warn(`Could not find oldContent in ${filePath}, skipping this fix`);
      }
    } else {
      logger.warn(`oldContent too short for fuzzy match in ${filePath}, skipping`);
    }
  }
}

/**
 * Extract Go import paths from changed files and resolve them to local file paths.
 * This provides deeper context for Claude to understand dependencies.
 */
function extractGoImportedFiles(worktreePath: string, changedFiles: string[]): string[] {
  const importedFiles = new Set<string>();

  // Detect Go module path from go.mod
  let modulePath = "";
  try {
    const goMod = readFileSync(join(worktreePath, "go.mod"), "utf-8");
    const moduleMatch = goMod.match(/^module\s+(\S+)/m);
    if (moduleMatch) modulePath = moduleMatch[1];
  } catch { /* not a Go project or no go.mod */ }

  if (!modulePath) return [];

  for (const f of changedFiles) {
    if (!f.endsWith(".go")) continue;
    try {
      const content = readFileSync(join(worktreePath, f), "utf-8");
      // Extract imports
      const importBlock = content.match(/import\s*\(([\s\S]*?)\)/);
      if (!importBlock) continue;

      for (const line of importBlock[1].split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("//")) continue;
        // Extract import path (handle aliased imports like `foo "path/to/pkg"`)
        const pathMatch = trimmed.match(/"([^"]+)"/);
        if (!pathMatch) continue;
        const importPath = pathMatch[1];

        // Only resolve local imports (same module)
        if (!importPath.startsWith(modulePath)) continue;

        // Convert module import path to relative file path
        const relDir = importPath.replace(modulePath, "").replace(/^\//, "");
        // Find .go files in that directory
        try {
          const dirPath = join(worktreePath, relDir);
          const files = execFileSync("find", [dirPath, "-maxdepth", "1", "-name", "*.go", "-not", "-name", "*_test.go"], {
            encoding: "utf-8", timeout: 3000,
          });
          for (const goFile of files.trim().split("\n").filter(Boolean).slice(0, 3)) {
            const rel = goFile.replace(worktreePath + "/", "");
            if (!changedFiles.includes(rel)) {
              importedFiles.add(rel);
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  // Limit to 10 dependency files to avoid context overflow
  return [...importedFiles].slice(0, 10);
}

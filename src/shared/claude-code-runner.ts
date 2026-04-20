import { spawn } from "node:child_process";
import { logger } from "./logger.js";

export interface ClaudeRunParams {
  bin: string;                    // e.g. "claude"
  prompt: string;
  cwd: string;                    // worktree path
  sessionId?: string;             // UUID — if set, reuse/initialize that session
  resume?: boolean;               // true: `--resume <sessionId>`; false: `--session-id <sessionId>`
  model?: string;                 // optional override
  timeoutMs?: number;             // hard kill timeout, default 30 min
  allowedDirs?: string[];         // --add-dir entries
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;        // override process env (e.g. inject ANTHROPIC_API_KEY)
}

export interface ClaudeRunResult {
  ok: boolean;
  sessionId: string | null;
  text: string;                   // Claude's final textual result
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  rawJson: unknown | null;        // parsed JSON object if available
}

/**
 * Spawn `claude` CLI in --print --output-format json mode and capture the result.
 *
 * Output shape (from `claude --print --output-format json`):
 *   {"type":"result","result":"...","session_id":"...","total_cost_usd":...,"duration_ms":...}
 *
 * The child process runs detached from Spirit's stdin/stdout/stderr pipes — we only
 * collect its own stdout/stderr buffers. No TTY needed.
 */
export async function runClaudeCode(params: ClaudeRunParams): Promise<ClaudeRunResult> {
  const {
    bin,
    prompt,
    cwd,
    sessionId,
    resume = false,
    model,
    timeoutMs = 30 * 60 * 1000,
    allowedDirs = [],
    extraArgs = [],
    env,
  } = params;

  const args: string[] = ["--print", "--output-format", "json", "--dangerously-skip-permissions"];

  if (sessionId) {
    args.push(resume ? "--resume" : "--session-id", sessionId);
  }
  if (model) args.push("--model", model);
  for (const d of allowedDirs) args.push("--add-dir", d);
  args.push(...extraArgs);
  args.push(prompt);

  logger.info(`Spawning ${bin} in ${cwd} (session=${sessionId ?? "new"}, resume=${resume}, timeout=${timeoutMs}ms)`);

  const t0 = Date.now();
  return new Promise<ClaudeRunResult>((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      logger.warn(`Claude process timed out after ${timeoutMs}ms, sending SIGTERM`);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5000);
    }, timeoutMs);

    child.stdout.on("data", (d) => stdoutChunks.push(d));
    child.stderr.on("data", (d) => stderrChunks.push(d));

    child.on("error", (err) => {
      clearTimeout(timer);
      logger.error(`Claude spawn error: ${err.message}`);
      resolve({
        ok: false,
        sessionId: sessionId ?? null,
        text: "",
        stderr: err.message,
        exitCode: null,
        durationMs: Date.now() - t0,
        rawJson: null,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      const durationMs = Date.now() - t0;

      let rawJson: any = null;
      try {
        rawJson = JSON.parse(stdout);
      } catch {
        // Stream-json or non-JSON output — leave as null, fall back to raw text
      }

      const text =
        typeof rawJson?.result === "string"
          ? rawJson.result
          : stdout.trim();
      const resolvedSessionId =
        (typeof rawJson?.session_id === "string" ? rawJson.session_id : null) ?? sessionId ?? null;

      // Claude CLI may exit with code 1 on permission denials or tool errors
      // but still produce valid JSON output — treat as ok if we got text.
      const ok = !killed && text.length > 0;
      if (ok) {
        logger.info(`Claude done in ${durationMs}ms (exit=${code}, session=${resolvedSessionId})`);
      } else {
        logger.warn(`Claude failed: exit=${code}, killed=${killed}, stderr=${stderr.slice(0, 300)}`);
      }

      resolve({
        ok,
        sessionId: resolvedSessionId,
        text,
        stderr,
        exitCode: code,
        durationMs,
        rawJson,
      });
    });
  });
}

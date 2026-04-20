import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { loadConfig } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import { LogMonitor } from "./log-monitor.js";
import { ErrorDetector } from "./error-detector.js";
import { SelfFixer } from "./self-fixer.js";

const config = loadConfig();

// Determine log file glob pattern
const logGlob = resolve(process.cwd(), "spirit-*.log");

logger.info("=== Spirit Self-Monitor starting ===");
logger.info(`Monitoring spirit watcher process + log files: ${logGlob}`);

const detector = new ErrorDetector(200);
const fixer = new SelfFixer(config, 300_000, 3);

const monitor = new LogMonitor(logGlob, async ({ source, line }) => {
  // Feed to detector
  const error = detector.feed(line);
  if (error) {
    logger.warn(`[self-monitor] Blocking error detected (${error.type}): ${error.message.slice(0, 100)}`);

    // Attempt fix
    const attempt = await fixer.tryFix(error);
    if (attempt.success) {
      logger.info(`[self-monitor] Fix applied to ${attempt.filesChanged.length} file(s) — hot-reload will restart watcher`);
    } else if (attempt.filesChanged.length === 0 && attempt.diagnosis) {
      logger.info(`[self-monitor] No fix applied: ${attempt.diagnosis}`);
    }
  }
});

// Start file watching
monitor.startFileWatch();

// Spawn spirit watcher process
const watcherArgs = ["watch", "src/watcher/index.ts"];
const watcherProc = spawn("tsx", watcherArgs, {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
});

logger.info(`[self-monitor] Spawned spirit watcher (PID ${watcherProc.pid})`);

// Pipe watcher stdout/stderr to monitor
watcherProc.stdout.on("data", (chunk) => {
  const lines = chunk.toString().split("\n");
  for (const line of lines) {
    if (line.trim()) {
      process.stdout.write(line + "\n"); // echo to console
      monitor.feedProcessLine(line);
    }
  }
});

watcherProc.stderr.on("data", (chunk) => {
  const lines = chunk.toString().split("\n");
  for (const line of lines) {
    if (line.trim()) {
      process.stderr.write(line + "\n"); // echo to console
      monitor.feedProcessLine(line);
    }
  }
});

watcherProc.on("error", (err) => {
  logger.error(`[self-monitor] Watcher spawn error: ${err.message}`);
  process.exit(1);
});

watcherProc.on("exit", (code, signal) => {
  logger.warn(`[self-monitor] Watcher exited (code=${code}, signal=${signal})`);
  // Don't auto-restart — let systemd/pm2 handle it, or user can manually restart
  monitor.stop();
  process.exit(code ?? 1);
});

// Graceful shutdown
function shutdown() {
  logger.info("[self-monitor] Shutting down...");
  monitor.stop();
  watcherProc.kill("SIGTERM");
  setTimeout(() => {
    if (!watcherProc.killed) watcherProc.kill("SIGKILL");
    process.exit(0);
  }, 5000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

logger.info("=== Spirit Self-Monitor running ===");

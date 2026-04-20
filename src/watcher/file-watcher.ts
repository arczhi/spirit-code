import { watch } from "chokidar";
import { readFileSync, statSync } from "node:fs";
import { logger } from "../shared/logger.js";
import type { ErrorEvent } from "./es-poller.js";

type ErrorCallback = (errors: ErrorEvent[]) => void;

const ERROR_PATTERN = /\b(ERROR|FATAL|PANIC|panic|exception|Exception)\b/;

export class FileWatcher {
  private watcher: ReturnType<typeof watch> | null = null;
  private filePositions: Map<string, number> = new Map();

  constructor(
    private envName: string,
    private logPaths: string[],
    private onErrors: ErrorCallback,
  ) {}

  start() {
    if (this.logPaths.length === 0) {
      logger.info(`File watcher [${this.envName}]: no log paths configured, skipping`);
      return;
    }

    this.watcher = watch(this.logPaths, {
      persistent: true,
      ignoreInitial: true,
      followSymlinks: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });

    this.watcher.on("add", (path) => this.handleFile(path));
    this.watcher.on("change", (path) => this.handleFile(path));
    this.watcher.on("error", (err) => logger.error(`File watcher [${this.envName}] error:`, err));

    logger.info(`File watcher started for '${this.envName}' watching ${this.logPaths.length} paths`);
  }

  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    logger.info(`File watcher [${this.envName}] stopped`);
  }

  private handleFile(filePath: string) {
    try {
      const stat = statSync(filePath);
      const prevPos = this.filePositions.get(filePath) ?? 0;

      if (stat.size <= prevPos) {
        // File was truncated or no new data
        this.filePositions.set(filePath, stat.size);
        return;
      }

      // Read only new content
      const content = readFileSync(filePath, "utf-8");
      const lines = content.slice(prevPos).split("\n");
      this.filePositions.set(filePath, stat.size);

      const errorLines = lines.filter((line) => ERROR_PATTERN.test(line));
      if (errorLines.length === 0) return;

      const now = new Date().toISOString();
      const errors: ErrorEvent[] = errorLines.map((line) => ({
        env: this.envName,
        service: guessServiceFromPath(filePath),
        level: extractLevel(line),
        message: line.trim(),
        timestamp: extractTimestamp(line) ?? now,
        raw: { file: filePath, line },
      }));

      logger.info(`File watcher [${this.envName}]: found ${errors.length} errors in ${filePath}`);
      this.onErrors(errors);
    } catch (err) {
      logger.error(`File watcher failed to read ${filePath}:`, err);
    }
  }
}

function guessServiceFromPath(filePath: string): string {
  if (filePath.includes("worker")) return "backend";
  if (filePath.includes("web")) return "backend";
  if (filePath.includes("frontend")) return "frontend";
  return "backend";
}

function extractLevel(line: string): string {
  if (/FATAL|PANIC|panic/i.test(line)) return "FATAL";
  return "ERROR";
}

function extractTimestamp(line: string): string | undefined {
  // Try to extract ISO-like timestamp from log line
  const match = line.match(/\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}/);
  if (match) {
    return new Date(match[0].replace(/\//g, "-")).toISOString();
  }
  return undefined;
}

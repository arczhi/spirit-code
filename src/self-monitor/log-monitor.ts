import { createReadStream, statSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { watch, type FSWatcher } from "chokidar";
import { logger } from "../shared/logger.js";

export type LogLine = { source: "process" | "file"; line: string };

export class LogMonitor {
  private fileWatcher: FSWatcher | null = null;
  private fileOffsets = new Map<string, number>();
  private onLine: (line: LogLine) => void;
  private logGlob: string;

  constructor(logGlob: string, onLine: (line: LogLine) => void) {
    this.logGlob = logGlob;
    this.onLine = onLine;
  }

  /** Feed a line from the watcher process stdout/stderr directly */
  feedProcessLine(line: string) {
    this.onLine({ source: "process", line });
  }

  /** Start watching log files matching the glob pattern */
  startFileWatch() {
    this.fileWatcher = watch(this.logGlob, {
      persistent: true,
      ignoreInitial: false,
      usePolling: false,
    });

    this.fileWatcher.on("add", (filePath: string) => {
      logger.debug(`[self-monitor] Watching log file: ${filePath}`);
      // Start from end of existing file
      try {
        const size = statSync(filePath).size;
        this.fileOffsets.set(filePath, size);
      } catch {
        this.fileOffsets.set(filePath, 0);
      }
    });

    this.fileWatcher.on("change", (filePath: string) => {
      this.tailFile(filePath);
    });

    this.fileWatcher.on("error", (err: unknown) => {
      logger.warn(`[self-monitor] File watcher error: ${err}`);
    });
  }

  private tailFile(filePath: string) {
    if (!existsSync(filePath)) return;
    const offset = this.fileOffsets.get(filePath) ?? 0;

    try {
      const stat = statSync(filePath);
      if (stat.size <= offset) return; // no new data

      const stream = createReadStream(filePath, {
        start: offset,
        end: stat.size - 1,
        encoding: "utf-8",
      });

      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      rl.on("line", (line) => {
        if (line.trim()) this.onLine({ source: "file", line });
      });
      rl.on("close", () => {
        this.fileOffsets.set(filePath, stat.size);
      });
    } catch (err) {
      logger.warn(`[self-monitor] Failed to tail ${filePath}: ${err}`);
    }
  }

  stop() {
    this.fileWatcher?.close();
  }
}

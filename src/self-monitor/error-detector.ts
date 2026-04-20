export interface BlockingError {
  type: "uncaught_exception" | "unhandled_rejection" | "startup_failure" | "consecutive_errors";
  message: string;
  stackTrace?: string;
  timestamp: Date;
  context: string[];
}

const BLOCKING_PATTERNS = [
  { re: /uncaught\s+exception/i, type: "uncaught_exception" as const },
  { re: /unhandledpromiserejection/i, type: "unhandled_rejection" as const },
  { re: /unhandled\s+promise\s+rejection/i, type: "unhandled_rejection" as const },
  { re: /cannot find module/i, type: "startup_failure" as const },
  { re: /syntaxerror:/i, type: "startup_failure" as const },
  { re: /error: cannot/i, type: "startup_failure" as const },
];

const CONSECUTIVE_ERROR_WINDOW_MS = 10_000;
const CONSECUTIVE_ERROR_THRESHOLD = 5;

export class ErrorDetector {
  private history: string[] = [];
  private errorTimestamps: number[] = [];
  private readonly maxHistory: number;

  constructor(maxHistory = 200) {
    this.maxHistory = maxHistory;
  }

  feed(line: string): BlockingError | null {
    this.history.push(line);
    if (this.history.length > this.maxHistory) this.history.shift();

    // Check explicit blocking patterns
    for (const { re, type } of BLOCKING_PATTERNS) {
      if (re.test(line)) {
        const stack = this.extractStack();
        return {
          type,
          message: line.trim(),
          stackTrace: stack,
          timestamp: new Date(),
          context: this.history.slice(-20),
        };
      }
    }

    // Track ERROR lines for consecutive error detection
    if (/\[ERROR\]/.test(line)) {
      const now = Date.now();
      this.errorTimestamps.push(now);
      // Keep only timestamps within window
      this.errorTimestamps = this.errorTimestamps.filter(
        (t) => now - t < CONSECUTIVE_ERROR_WINDOW_MS
      );

      if (this.errorTimestamps.length >= CONSECUTIVE_ERROR_THRESHOLD) {
        this.errorTimestamps = []; // reset to avoid re-triggering immediately
        return {
          type: "consecutive_errors",
          message: `${CONSECUTIVE_ERROR_THRESHOLD}+ errors within ${CONSECUTIVE_ERROR_WINDOW_MS / 1000}s`,
          timestamp: new Date(),
          context: this.history.slice(-30),
        };
      }
    }

    return null;
  }

  private extractStack(): string | undefined {
    // Grab last lines that look like a stack trace
    const stackLines: string[] = [];
    for (let i = this.history.length - 1; i >= 0 && stackLines.length < 15; i--) {
      const l = this.history[i];
      if (/^\s+at\s/.test(l) || /Error:/.test(l)) {
        stackLines.unshift(l);
      } else if (stackLines.length > 0) {
        break;
      }
    }
    return stackLines.length > 0 ? stackLines.join("\n") : undefined;
  }
}

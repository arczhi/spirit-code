const LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const;
type Level = (typeof LEVELS)[number];

let minLevel: Level = "INFO";

export function setLogLevel(level: Level) {
  minLevel = level;
}

function shouldLog(level: Level): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(minLevel);
}

function fmt(level: Level, msg: string, ...args: unknown[]): string {
  const ts = new Date().toISOString();
  const extra = args.length
    ? " " +
      args
        .map((a) => {
          if (a instanceof Error) return `${a.message}${a.stack ? "\n" + a.stack : ""}`;
          if (typeof a === "object" && a !== null) return JSON.stringify(a);
          return String(a);
        })
        .join(" ")
    : "";
  return `[${ts}] [${level}] ${msg}${extra}`;
}

export const logger = {
  debug(msg: string, ...args: unknown[]) {
    if (shouldLog("DEBUG")) process.stderr.write(fmt("DEBUG", msg, ...args) + "\n");
  },
  info(msg: string, ...args: unknown[]) {
    if (shouldLog("INFO")) process.stderr.write(fmt("INFO", msg, ...args) + "\n");
  },
  warn(msg: string, ...args: unknown[]) {
    if (shouldLog("WARN")) process.stderr.write(fmt("WARN", msg, ...args) + "\n");
  },
  error(msg: string, ...args: unknown[]) {
    if (shouldLog("ERROR")) process.stderr.write(fmt("ERROR", msg, ...args) + "\n");
  },
};

import { createEsClient, searchErrors } from "../shared/es-client.js";
import { logger } from "../shared/logger.js";
import type { Environment } from "../shared/config.js";

export interface ErrorEvent {
  env: string;
  service: string;
  level: string;
  message: string;
  stackTrace?: string;
  timestamp: string;
  raw: Record<string, unknown>;
}

type ErrorCallback = (errors: ErrorEvent[]) => void;

export class EsPoller {
  private timers: NodeJS.Timeout[] = [];
  private lastPollTimes: Map<string, string> = new Map();

  constructor(
    private environments: Environment[],
    private intervalSec: number,
    private onErrors: ErrorCallback,
  ) {}

  start() {
    for (const env of this.environments) {
      const key = env.name;
      // Start from 1 hour ago to catch recent errors on first poll
      this.lastPollTimes.set(key, new Date(Date.now() - 60 * 60 * 1000).toISOString());

      const timer = setInterval(() => this.poll(env).catch((err) => {
        logger.error(`ES poller [${env.name}] unhandled error:`, err);
      }), this.intervalSec * 1000);
      this.timers.push(timer);

      // Also poll immediately on start
      this.poll(env).catch((err) => {
        logger.error(`ES poller [${env.name}] initial poll error:`, err);
      });
      logger.info(`ES poller started for '${env.name}' (every ${this.intervalSec}s)`);
    }
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    logger.info("ES poller stopped");
  }

  private async poll(env: Environment) {
    const key = env.name;
    const since = this.lastPollTimes.get(key)!;
    const now = new Date().toISOString();

    try {
      logger.debug(`ES poller [${env.name}]: polling since ${since}`);
      const client = createEsClient(env.elasticsearch.url);
      const hits = await searchErrors({
        client,
        indices: env.elasticsearch.indices,
        errorQuery: env.elasticsearch.errorQuery,
        since,
        size: 100,
      });

      if (hits.length > 0) {
        const errors: ErrorEvent[] = hits.map((h) => {
          const s = h.source;
          return {
            env: env.name,
            service: guessService(h.index, s),
            level: String(s["level"] ?? "ERROR"),
            message: String(s["message"] ?? s["error"] ?? JSON.stringify(s)),
            stackTrace: s["stack_trace"] as string | undefined,
            timestamp: String(s["@timestamp"] ?? now),
            raw: s,
          };
        });
        logger.info(`ES poller [${env.name}]: found ${errors.length} errors since ${since}`);
        this.onErrors(errors);
      } else {
        logger.debug(`ES poller [${env.name}]: 0 errors since ${since}`);
      }

      this.lastPollTimes.set(key, now);
    } catch (err) {
      logger.error(`ES poller [${env.name}] failed:`, err);
    }
  }
}

function guessService(index: string, source: Record<string, unknown>): string {
  if (source["service"]) return String(source["service"]);
  if (index.includes("backend") || index.includes("web") || index.includes("worker")) return "backend";
  if (index.includes("frontend")) return "frontend";
  return "unknown";
}

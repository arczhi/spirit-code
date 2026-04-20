import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { logger } from "../shared/logger.js";
import type { BlockingError } from "./error-detector.js";
import type { Config } from "../shared/config.js";

export interface FixAttempt {
  errorType: string;
  errorMessage: string;
  timestamp: Date;
  success: boolean;
  filesChanged: string[];
  diagnosis?: string;
}

interface FixAction {
  filePath: string;
  description: string;
  newContent: string;
}

const SPIRIT_SRC = resolve(import.meta.dirname ?? process.cwd(), "../../src");

export class SelfFixer {
  private cooldowns = new Map<string, number>(); // errorKey -> last fix timestamp
  private attempts = new Map<string, number>();  // errorKey -> attempt count
  private readonly cooldownMs: number;
  private readonly maxAttempts: number;
  private readonly config: Config;

  constructor(config: Config, cooldownMs = 300_000, maxAttempts = 3) {
    this.config = config;
    this.cooldownMs = cooldownMs;
    this.maxAttempts = maxAttempts;
  }

  async tryFix(error: BlockingError): Promise<FixAttempt> {
    const key = this.errorKey(error);
    const attempt: FixAttempt = {
      errorType: error.type,
      errorMessage: error.message,
      timestamp: new Date(),
      success: false,
      filesChanged: [],
    };

    // Cooldown check
    const lastFix = this.cooldowns.get(key) ?? 0;
    if (Date.now() - lastFix < this.cooldownMs) {
      logger.info(`[self-monitor] Skipping fix for "${key}" — cooldown active`);
      return attempt;
    }

    // Max attempts check
    const count = this.attempts.get(key) ?? 0;
    if (count >= this.maxAttempts) {
      logger.warn(`[self-monitor] Max fix attempts (${this.maxAttempts}) reached for "${key}", giving up`);
      return attempt;
    }

    this.cooldowns.set(key, Date.now());
    this.attempts.set(key, count + 1);

    logger.info(`[self-monitor] Attempting fix #${count + 1} for ${error.type}: ${error.message.slice(0, 80)}`);

    try {
      const result = await this.analyzeAndFix(error);
      attempt.diagnosis = result.diagnosis;
      attempt.filesChanged = result.filesChanged;
      attempt.success = result.filesChanged.length > 0;
    } catch (err) {
      logger.error(`[self-monitor] Fix attempt failed:`, err);
    }

    return attempt;
  }

  private async analyzeAndFix(error: BlockingError): Promise<{ diagnosis: string; filesChanged: string[] }> {
    const context = error.context.join("\n");
    const stack = error.stackTrace ?? "";

    // Collect relevant source files from stack trace
    const srcFiles = this.extractSrcFiles(stack + "\n" + context);
    let codeContext = "";
    for (const f of srcFiles.slice(0, 5)) {
      if (existsSync(f)) {
        try {
          codeContext += `\n\n--- ${f} ---\n${readFileSync(f, "utf-8")}`;
        } catch { /* skip */ }
      }
    }

    const baseURL = this.config.claude.baseUrl.replace(/\/v1\/?$/, "");
    const client = new Anthropic({
      apiKey: this.config.claude.apiKey,
      baseURL,
      maxRetries: 0,
      timeout: 120_000,
    });

    const prompt = `You are Spirit's self-repair agent. Spirit is a TypeScript service that crashed or encountered a blocking error. Fix the source code.

ERROR TYPE: ${error.type}
ERROR MESSAGE:
${error.message}

STACK TRACE:
${stack || "(none)"}

RECENT LOG CONTEXT (last 20 lines):
${context}

RELEVANT SOURCE FILES:
${codeContext || "(none found)"}

Spirit source root: ${SPIRIT_SRC}

Respond with ONLY a valid JSON object, no markdown, no code fences:
{
  "diagnosis": "Root cause in 1-2 sentences",
  "fixPlan": [
    {
      "filePath": "absolute/path/to/file.ts",
      "description": "What this change does",
      "newContent": "complete new file content"
    }
  ]
}

Rules:
- Only fix files under ${SPIRIT_SRC}
- Provide complete file content in newContent (not diffs)
- If you cannot safely fix, return fixPlan: []
- Do NOT modify config files, package.json, or node_modules`;

    const msg = await client.messages.create({
      model: this.config.claude.model,
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    });

    const text = msg.content.find((b) => b.type === "text")?.text ?? "";
    let parsed: { diagnosis: string; fixPlan: FixAction[] };
    try {
      parsed = JSON.parse(text);
    } catch {
      // Try to extract JSON from response
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error(`Claude returned non-JSON: ${text.slice(0, 200)}`);
      parsed = JSON.parse(match[0]);
    }

    logger.info(`[self-monitor] Diagnosis: ${parsed.diagnosis}`);

    if (!parsed.fixPlan || parsed.fixPlan.length === 0) {
      logger.info(`[self-monitor] No fix plan generated`);
      return { diagnosis: parsed.diagnosis, filesChanged: [] };
    }

    const filesChanged: string[] = [];

    for (const action of parsed.fixPlan) {
      const absPath = resolve(action.filePath);

      // Safety: only allow changes under spirit src
      if (!absPath.startsWith(SPIRIT_SRC)) {
        logger.warn(`[self-monitor] Refusing to modify file outside src: ${absPath}`);
        continue;
      }

      if (!existsSync(absPath)) {
        logger.warn(`[self-monitor] File not found, skipping: ${absPath}`);
        continue;
      }

      // Backup original
      const backup = absPath + ".bak";
      writeFileSync(backup, readFileSync(absPath));

      // Apply fix
      writeFileSync(absPath, action.newContent, "utf-8");
      logger.info(`[self-monitor] Applied fix to ${absPath} (${action.description})`);
      filesChanged.push(absPath);
    }

    if (filesChanged.length > 0) {
      // Verify typecheck passes
      const ok = this.runTypecheck();
      if (!ok) {
        logger.warn(`[self-monitor] Typecheck failed after fix — rolling back`);
        for (const f of filesChanged) {
          const backup = f + ".bak";
          if (existsSync(backup)) writeFileSync(f, readFileSync(backup));
        }
        return { diagnosis: parsed.diagnosis, filesChanged: [] };
      }
      logger.info(`[self-monitor] Typecheck passed — fix applied, hot-reload will pick it up`);
    }

    return { diagnosis: parsed.diagnosis, filesChanged };
  }

  private runTypecheck(): boolean {
    try {
      execFileSync("npx", ["tsc", "--noEmit"], {
        cwd: resolve(SPIRIT_SRC, ".."),
        timeout: 30_000,
        stdio: "pipe",
      });
      return true;
    } catch {
      return false;
    }
  }

  private extractSrcFiles(text: string): string[] {
    const files = new Set<string>();
    // Match absolute paths to .ts files
    for (const m of text.matchAll(/([/\w.-]+\/src\/[/\w.-]+\.ts)/g)) {
      files.add(m[1]);
    }
    // Match relative src/ paths
    for (const m of text.matchAll(/\b(src\/[/\w.-]+\.ts)/g)) {
      files.add(resolve(SPIRIT_SRC, "..", m[1]));
    }
    return [...files];
  }

  private errorKey(error: BlockingError): string {
    // Normalize message to a stable key (strip timestamps, line numbers)
    return `${error.type}:${error.message.replace(/\d+/g, "N").slice(0, 100)}`;
  }
}

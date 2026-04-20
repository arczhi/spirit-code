import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { logger } from "../shared/logger.js";
import { getAgentTools, executeAgentTool } from "../shared/agent-tools.js";
import type { Config } from "../shared/config.js";
import type { ErrorEvent } from "./es-poller.js";

export interface AnalysisResult {
  diagnosis: string;
  riskLevel: "A" | "B" | "C";
  suspectedFiles: string[];
  fixPlan: FixAction[] | null;
}

export interface FixAction {
  filePath: string;
  description: string;
  oldContent?: string;
  newContent: string;
}

const MAX_RETRIES = 10;
const RETRY_DELAYS = [5000, 15000, 30000, 45000, 60000, 90000, 120000, 150000, 180000, 210000]; // ms

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function analyzeError(params: {
  errors: ErrorEvent[];
  codeRootPath: string;
  config: Config;
}): Promise<AnalysisResult> {
  const { errors, codeRootPath, config } = params;

  const sampleLogs = errors
    .slice(0, 5)
    .map((e) => `[${e.timestamp}] [${e.level}] ${e.message}${e.stackTrace ? "\n" + e.stackTrace : ""}`)
    .join("\n---\n");

  // Try to read suspected files from stack traces
  const fileHints = extractFileHints(errors, codeRootPath);

  // Extract keywords from error messages and grep for relevant code files
  const keywords = extractKeywords(errors);
  const grepFiles = grepForKeywords(keywords, codeRootPath);

  // Merge and dedupe: stack trace files first, then grep results
  const allFiles = [...new Set([...fileHints, ...grepFiles])];
  logger.info(`Analyzer: ${fileHints.length} files from stack, ${grepFiles.length} from grep, ${allFiles.length} total`);

  let codeContext = "";
  let contextSize = 0;
  const MAX_CONTEXT = 80000; // chars

  for (const filePath of allFiles) {
    if (contextSize >= MAX_CONTEXT) break;
    if (!existsSync(filePath)) continue;
    try {
      const content = readFileSync(filePath, "utf-8");
      if (content.length > 30000) continue; // skip huge files
      codeContext += `\n\n--- File: ${filePath} ---\n${content}`;
      contextSize += content.length;
    } catch { /* skip unreadable */ }
  }

  // Anthropic SDK auto-appends /v1, strip it if user included it in config
  const baseURL = config.claude.baseUrl.replace(/\/v1\/?$/, "");

  const client = new Anthropic({
    apiKey: config.claude.apiKey,
    baseURL,
    maxRetries: 0, // Disable SDK auto-retry; we handle retries ourselves
    timeout: 120_000, // 2 min per request
  });

  const systemPrompt = `You are Spirit (精灵), an AI error analysis and auto-fix agent. You analyze production/test errors and propose fixes.

Your task:
1. Analyze the error logs and identify the root cause
2. Classify the risk level:
   - A: Safe to auto-fix (type errors, null checks, config issues, log format, unhandled sql.ErrNoRows)
   - B: Needs human review after fix (business logic, state machines, rate limiting)
   - C: Manual only, do NOT auto-fix (auth credentials, security, data deletion, DB migration, payment, third-party API keys)
3. If risk is A or B, you MUST provide exact file changes in fixPlan. This is critical.
4. List suspected source files

You MUST respond with ONLY a valid JSON object, no markdown, no code fences, no extra text.

Schema:
{
  "diagnosis": "Root cause explanation in 1-3 sentences",
  "riskLevel": "A" | "B" | "C",
  "suspectedFiles": ["relative/path/to/file.go"],
  "fixPlan": [
    {
      "filePath": "relative/path/to/file.go",
      "description": "What this change does",
      "oldContent": "the exact lines to replace (copy from the source file)",
      "newContent": "the replacement lines"
    }
  ]
}

Rules for fixPlan:
- fixPlan is null ONLY when riskLevel is C
- When riskLevel is A or B, you MUST provide at least one fix entry. Do not leave fixPlan empty or null.
- filePath must be relative to the code root
- oldContent: copy the EXACT lines from the provided source code that need to change (enough context to be unique)
- newContent: the replacement for those exact lines
- This is a search-and-replace operation, NOT a full file rewrite
- Keep changes minimal and focused

## CRITICAL: Code Context & Go Syntax Rules

You MUST thoroughly read ALL provided code context before proposing any fix. Do NOT guess or assume code structure.

### Go-specific rules (MANDATORY for .go files):
1. **Import hygiene**: Every import in the final file MUST be used. If you add code that removes usage of an import, DELETE that import line. If you add new function calls, ADD the required import.
2. **Unused variables**: Go does not allow unused variables. If your fix introduces or leaves an unused variable, it WILL fail \`go vet\`. Remove or use it.
3. **Type correctness**: Ensure all types match. Check function signatures, return types, and interface implementations in the provided context.
4. **Error handling**: Every error return in Go must be checked (\`if err != nil\`). Do not swallow errors silently.
5. **Package references**: When calling functions from other packages, verify the package is imported and the function name/signature matches the provided code context.
6. **Struct fields**: When accessing struct fields, verify the field exists in the struct definition from the provided context.

### Context reading rules:
- Read the FULL file content provided, not just the error location
- Check import blocks, function signatures, struct definitions, and interface implementations
- If the fix touches file A and file A imports package B, check if package B's code is in the context
- If you reference a function/type from another file, verify it exists in the provided context
- When removing code, check if other code in the same file depends on it

### Self-check before outputting fixPlan:
- [ ] Every import in the modified file is actually used
- [ ] No unused variables are introduced
- [ ] All referenced functions/types exist in the codebase
- [ ] Error returns are properly handled
- [ ] The fix addresses the ROOT CAUSE, not just the symptom

## Available Tools

You have access to tools to gather more context:

1. **search_logs**: Search Elasticsearch for more error logs by keyword, level, or time range
2. **query_database**: Execute SQL queries to check database state (read-only)
3. **read_file**: Read additional source files not in the initial context
4. **list_files**: List files in a directory to discover related code

Use these tools BEFORE proposing a fix if you need more information. For example:
- If the error mentions a database query, use query_database to check the actual data
- If you need to see related files, use list_files then read_file
- If you want to see more error context, use search_logs

After gathering enough context, respond with the JSON analysis.

IMPORTANT: When you have enough information, output ONLY the JSON object. No markdown. No code blocks. No explanation.`;

  const userPrompt = `## Error Logs (${errors[0].env} / ${errors[0].service})

${sampleLogs}

## Code Context
${codeContext || "(no code context available)"}

## Code Root
${codeRootPath}

Analyze the error and use tools if you need more context. When ready, respond with the JSON analysis.`;

  // Find environment config for tool execution
  const envConfig = config.environments.find((e) => e.name === errors[0].env);

  // Get tools from shared module
  const toolCtx = { config, envConfig, codeRootPath };
  const tools = getAgentTools(toolCtx);

  const MAX_TOOL_ROUNDS = 1000;
  // Keep messages outside retry loop so 429 retries resume from where they left off
  let messages: Anthropic.MessageParam[] = [{ role: "user", content: userPrompt }];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Tool-use loop
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const response = await client.messages.create({
          model: config.claude.model,
          max_tokens: 8192,
          system: systemPrompt,
          messages,
          tools,
        });

        // Check if Claude wants to use tools
        const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

        if (toolUseBlocks.length === 0 || response.stop_reason === "end_turn") {
          // No tool calls — extract final text response
          const text = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("");

          if (text.trim().length > 0) {
            const parsed = parseAnalysisResponse(text);
            logger.info(`Analyzer: risk=${parsed.riskLevel}, files=${parsed.suspectedFiles.length}, fixes=${parsed.fixPlan?.length ?? 0}, tool_rounds=${round}`);
            return parsed;
          }
          break;
        }

        // Execute tool calls and build tool results
        logger.info(`Analyzer: Claude requested ${toolUseBlocks.length} tool(s) in round ${round + 1}`);

        // Add assistant message with tool use
        messages.push({ role: "assistant", content: response.content });

        // Execute each tool and collect results
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const toolUse of toolUseBlocks) {
          const result = await executeAgentTool(toolUse.name, toolUse.input as Record<string, any>, toolCtx);
          logger.info(`Analyzer tool ${toolUse.name}: ${result.slice(0, 100)}...`);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result.slice(0, 30000), // Limit tool result size
          });
        }

        messages.push({ role: "user", content: toolResults });
      }

      // If we exhausted tool rounds without a final answer, make one last call without tools
      logger.warn("Analyzer: exhausted tool rounds, making final call without tools");
      const finalResponse = await client.messages.create({
        model: config.claude.model,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt + "\n\n**IMPORTANT**: You have exhausted the tool rounds. You MUST respond with the JSON analysis object NOW. Do NOT request more tools. Output ONLY the JSON object, no other text." }],
        // Explicitly disable tools in final call
      });

      const text = finalResponse.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      const parsed = parseAnalysisResponse(text);
      logger.info(`Analyzer (final): risk=${parsed.riskLevel}, files=${parsed.suspectedFiles.length}, fixes=${parsed.fixPlan?.length ?? 0}`);
      return parsed;
    } catch (err: unknown) {
      const isRetryable = isRetryableError(err);
      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS[attempt];
        logger.warn(`Analyzer attempt ${attempt + 1} failed (retryable), retrying in ${delay / 1000}s...`, err);
        await sleep(delay);
        continue;
      }
      logger.error("Analyzer failed:", err);
      return {
        diagnosis: `Analysis failed: ${err}`,
        riskLevel: "C",
        suspectedFiles: [],
        fixPlan: null,
      };
    }
  }

  // Should not reach here, but just in case
  return { diagnosis: "Analysis failed: max retries exceeded", riskLevel: "C", suspectedFiles: [], fixPlan: null };
}

function isRetryableError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as { status?: number; error?: { type?: string } };
    // 429 rate limit, 503 overloaded, 529 overloaded
    if (e.status === 429 || e.status === 503 || e.status === 529) return true;
    if (e.error?.type === "rate_limit_error") return true;
  }
  return false;
}

function parseAnalysisResponse(text: string): AnalysisResult {
  // Try direct parse first
  try {
    return JSON.parse(text) as AnalysisResult;
  } catch { /* continue to fallback strategies */ }

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]) as AnalysisResult;
    } catch { /* continue */ }
  }

  // Find the outermost { ... } — greedy match for the last }
  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    try {
      return JSON.parse(text.slice(braceStart, braceEnd + 1)) as AnalysisResult;
    } catch { /* continue */ }
  }

  // All parsing failed — return as diagnosis text
  logger.error("Analyzer: could not parse JSON from response, first 500 chars:", text.slice(0, 500));
  return { diagnosis: text.slice(0, 2000), riskLevel: "C", suspectedFiles: [], fixPlan: null };
}

function extractFileHints(errors: ErrorEvent[], codeRoot: string): string[] {
  const files = new Set<string>();
  for (const e of errors) {
    const text = `${e.message} ${e.stackTrace ?? ""}`;
    // Go stack traces: /path/to/file.go:123
    const goMatches = text.matchAll(/([a-zA-Z0-9_/.-]+\.go):\d+/g);
    for (const m of goMatches) {
      const f = m[1];
      if (!f.includes("vendor/") && !f.includes("go/src/")) {
        files.add(f.startsWith("/") ? f : `${codeRoot}/${f}`);
      }
    }
    // JS/TS stack traces: at ... (file.ts:123:45)
    const jsMatches = text.matchAll(/\(([a-zA-Z0-9_/.-]+\.[jt]sx?):\d+:\d+\)/g);
    for (const m of jsMatches) {
      files.add(m[1].startsWith("/") ? m[1] : `${codeRoot}/${m[1]}`);
    }
  }
  return [...files];
}

/**
 * Extract meaningful keywords from error messages for code search.
 * Looks for: [ModuleName], function names, error identifiers.
 */
function extractKeywords(errors: ErrorEvent[]): string[] {
  const keywords = new Set<string>();
  for (const e of errors) {
    const msg = e.message;

    // Extract [ModuleName] patterns — e.g. [Billing], [SeedanceWaitVideo], [AuthMiddleware]
    const bracketMatches = msg.matchAll(/\[([A-Z][a-zA-Z0-9_]+)\]/g);
    for (const m of bracketMatches) {
      keywords.add(m[1]);
    }

    // Extract function-like names before "error"/"failed" — e.g. "getBusinessId query error"
    const funcMatches = msg.matchAll(/\b([a-z][a-zA-Z0-9_]{3,})\s+(?:query\s+)?(?:error|failed|failure|panic)/gi);
    for (const m of funcMatches) {
      keywords.add(m[1]);
    }

    // Extract camelCase identifiers (Go unexported funcs) — e.g. getBusinessId, recordBillingForAsset
    const lowerCamelMatches = msg.matchAll(/\b([a-z][a-z0-9]*(?:[A-Z][a-zA-Z0-9]*)+)\b/g);
    for (const m of lowerCamelMatches) {
      if (m[1].length >= 6 && m[1].length <= 50) keywords.add(m[1]);
    }

    // Extract CamelCase identifiers (likely function/type names)
    const camelMatches = msg.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]+){1,})\b/g);
    for (const m of camelMatches) {
      if (m[1].length <= 40) keywords.add(m[1]);
    }

    // Extract identifiers after common prefixes like "Send", "Query", "Get"
    const actionMatches = msg.matchAll(/\b(Send[A-Z]\w+|Query\w+|Get\w+|Create\w+|Update\w+|Delete\w+)\b/g);
    for (const m of actionMatches) {
      keywords.add(m[1]);
    }
  }
  return [...keywords];
}

/**
 * Grep code root for keywords, return matching file paths (deduplicated).
 */
function grepForKeywords(keywords: string[], codeRoot: string): string[] {
  const files = new Set<string>();
  const resolved = resolve(codeRoot);

  for (const kw of keywords.slice(0, 8)) { // limit to 8 keywords
    try {
      const stdout = execFileSync("grep", [
        "-rl",
        "--max-count=1",
        "--include=*.go",
        "--include=*.ts",
        "--include=*.js",
        "--exclude-dir=node_modules",
        "--exclude-dir=vendor",
        "--exclude-dir=.git",
        "--exclude-dir=dist",
        kw,
        resolved,
      ], { maxBuffer: 512 * 1024, timeout: 5000, encoding: "utf-8" });

      for (const line of stdout.trim().split("\n")) {
        if (line && !line.includes("_test.go") && !line.includes(".test.")) {
          files.add(line);
        }
      }
    } catch {
      // grep returns exit code 1 when no matches — ignore
    }

    if (files.size >= 15) break; // enough context
  }

  return [...files].slice(0, 10); // max 10 files from grep
}


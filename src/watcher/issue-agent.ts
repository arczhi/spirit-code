import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../shared/logger.js";
import { getAgentTools, executeAgentTool } from "../shared/agent-tools.js";
import type { Config, Environment } from "../shared/config.js";

export interface IssueAgentResult {
  ok: boolean;
  text: string;
  durationMs: number;
  toolRounds: number;
  messages?: Anthropic.MessageParam[];
}

export interface IssueAgentParams {
  prompt: string;
  worktreePath: string;
  config: Config;
  envConfig?: Environment;
  messages?: Anthropic.MessageParam[];
}

const MAX_TOOL_ROUNDS = 100;
const MAX_RETRIES = 10;
const RETRY_DELAYS = [5000, 15000, 30000, 45000, 60000, 90000, 120000, 150000, 180000, 210000];

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runIssueAgent(params: IssueAgentParams): Promise<IssueAgentResult> {
  const { prompt, worktreePath, config, envConfig, messages: resumeMessages } = params;

  const baseURL = config.claude.baseUrl.replace(/\/v1\/?$/, "");
  const client = new Anthropic({ apiKey: config.claude.apiKey, baseURL, maxRetries: 0, timeout: 120_000 });

  const ctx = { config, envConfig, worktreePath };
  const tools = getAgentTools(ctx);

  const systemPrompt = `You are an AI developer running headless in a git worktree driven by a GitLab issue.

## Environment
- Working directory: ${worktreePath}
- Isolated worktree — changes here don't affect the main repository

## Task
Implement the feature or fix described in the issue:
1. Explore the codebase with available tools
2. Make changes incrementally
3. Test your changes (run_command: go build / npm test)
4. Commit when a logical unit is complete

## CRITICAL Rules
- ONLY read/write files inside ${worktreePath}
- Do NOT run git checkout/switch/worktree commands
- File paths in tools must be relative to the worktree root

## Output Format
End with a SHORT markdown summary:
1. **What I understood** — 1-3 bullets
2. **What I changed** — files touched with one-line reason, or "no code changes"
3. **Next step / questions** — what's next or what you need`;

  const t0 = Date.now();
  let toolRounds = 0;
  // Keep messages outside the retry loop so 429 retries resume from where they left off
  let messages: Anthropic.MessageParam[] = resumeMessages ?? [{ role: "user", content: prompt }];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        toolRounds = round + 1;

        const response = await client.messages.create({
          model: config.claude.model,
          max_tokens: 8192,
          system: systemPrompt,
          messages,
          tools,
        });

        const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

        if (toolUseBlocks.length === 0 || response.stop_reason === "end_turn") {
          const text = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("");

          if (text.trim().length > 0) {
            messages.push({ role: "assistant", content: response.content });
            logger.info(`Issue agent done in ${Date.now() - t0}ms (${toolRounds} tool rounds)`);
            return { ok: true, text, durationMs: Date.now() - t0, toolRounds, messages };
          }
          break;
        }

        logger.info(`Issue agent: ${toolUseBlocks.length} tool(s) in round ${round + 1}`);
        messages.push({ role: "assistant", content: response.content });

        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const toolUse of toolUseBlocks) {
          const result = await executeAgentTool(toolUse.name, toolUse.input as Record<string, any>, ctx);
          logger.info(`Issue agent tool ${toolUse.name}: ${result.slice(0, 100)}...`);
          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result.slice(0, 50000) });
        }
        messages.push({ role: "user", content: toolResults });
      }

      // Exhausted rounds — final call without tools
      logger.warn("Issue agent: exhausted tool rounds, making final call");
      const finalResponse = await client.messages.create({
        model: config.claude.model,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt + "\n\n**IMPORTANT**: Respond with the 3-section summary NOW." }],
      });
      const text = finalResponse.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      return { ok: true, text, durationMs: Date.now() - t0, toolRounds };
    } catch (err: unknown) {
      if (isRetryable(err) && attempt < MAX_RETRIES) {
        logger.warn(`Issue agent attempt ${attempt + 1} failed, retrying in ${RETRY_DELAYS[attempt] / 1000}s...`, err);
        await sleep(RETRY_DELAYS[attempt]);
        continue;
      }
      logger.error("Issue agent failed:", err);
      return { ok: false, text: `Agent failed: ${err}`, durationMs: Date.now() - t0, toolRounds };
    }
  }

  return { ok: false, text: "Agent failed: max retries exceeded", durationMs: Date.now() - t0, toolRounds };
}

function isRetryable(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as { status?: number; error?: { type?: string } };
    if (e.status === 429 || e.status === 503 || e.status === 529) return true;
    if (e.error?.type === "rate_limit_error") return true;
  }
  return false;
}

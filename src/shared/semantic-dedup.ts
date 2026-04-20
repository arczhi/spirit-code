import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger.js";
import type { Config } from "./config.js";

/**
 * Calculate simple text similarity using Jaccard similarity on words.
 * Returns a score between 0 (completely different) and 1 (identical).
 */
function textSimilarity(text1: string, text2: string): number {
  const words1 = new Set(text1.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const words2 = new Set(text2.toLowerCase().split(/\s+/).filter(w => w.length > 2));

  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);

  return union.size === 0 ? 0 : intersection.size / union.size;
}

/**
 * Extract error type prefix from error message.
 * e.g., "[Billing] getBusinessId query error: ..." -> "Billing getBusinessId"
 *       "DeepThinking error: ..." -> "DeepThinking error"
 *       "[FallbackLLM] Fallback also failed: ..." -> "FallbackLLM Fallback"
 *       "[API Error] /api/v1/..." -> "API Error"
 */
function extractErrorType(message: string): string {
  // Remove log prefix: timestamp + level
  let cleaned = message.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\s*\[(?:ERRO|WARN|INFO|DEBUG)\]\s*/i, "");

  // Remove all {hex/numeric} trace/request IDs
  cleaned = cleaned.replace(/\{[0-9a-f]{16,}\}\s*/g, "");
  cleaned = cleaned.replace(/\{?\d{13,}\}?\s*/g, "");

  // Extract [Module] FunctionName pattern
  const bracketMatch = cleaned.match(/^\[([^\]]+)\]\s+(\w+)/);
  if (bracketMatch) {
    return `${bracketMatch[1]} ${bracketMatch[2]}`;
  }

  // Extract "ErrorType error:" or "ErrorType:" pattern
  const colonMatch = cleaned.match(/^(\w[\w\s]*?)(?:\s+error)?:/);
  if (colonMatch) {
    return colonMatch[1].trim();
  }

  // Fallback: first meaningful words
  return cleaned.split(/\s+/).slice(0, 2).join(" ");
}

/**
 * Use LLM to determine if two error messages represent the same underlying issue.
 * This is used when fingerprint-based dedup is uncertain.
 *
 * Fast path: use text similarity first, only call LLM if uncertain.
 */
export async function isSameIssue(
  error1: string,
  error2: string,
  config: Config,
): Promise<boolean> {
  // Fast path 1: check error type prefix
  const type1 = extractErrorType(error1);
  const type2 = extractErrorType(error2);

  if (type1 !== type2) {
    // Different error types -> definitely different issues
    return false;
  }

  // Fast path 2: text similarity
  const similarity = textSimilarity(error1, error2);

  if (similarity > 0.8) {
    // Very similar -> same issue
    logger.debug(`Semantic dedup: high similarity (${similarity.toFixed(2)}), treating as same issue`);
    return true;
  }

  if (similarity < 0.3) {
    // Very different -> different issues
    logger.debug(`Semantic dedup: low similarity (${similarity.toFixed(2)}), treating as different issues`);
    return false;
  }

  // Uncertain (0.3 - 0.8) -> ask LLM
  const preview1 = error1.replace(/\s+/g, " ").slice(0, 60);
  const preview2 = error2.replace(/\s+/g, " ").slice(0, 60);
  logger.info(`Semantic dedup LLM call start (sim=${similarity.toFixed(2)}): "${preview1}" vs "${preview2}"`);

  const baseURL = config.claude.baseUrl.replace(/\/v1\/?$/, "");
  const client = new Anthropic({ apiKey: config.claude.apiKey, baseURL, maxRetries: 0, timeout: 30_000 });

  const prompt = `You are an error deduplication expert. Determine if these two error messages represent the SAME underlying issue that should be fixed together, or DIFFERENT issues that need separate fixes.

## Error 1
${error1}

## Error 2
${error2}

## Guidelines
- Same issue: errors from the same code path with different parameters/IDs/URLs
- Same issue: same error type with different request IDs or timestamps
- Same issue: same API failure with different endpoints/payloads
- Different issue: different error types (e.g., "connection timeout" vs "permission denied")
- Different issue: errors from different modules/functions
- Different issue: different root causes requiring different fixes

Respond with ONLY "SAME" or "DIFFERENT" (no explanation).`;

  const t0 = Date.now();
  try {
    const response = await client.messages.create({
      model: config.claude.model,
      max_tokens: 10,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as any).text)
      .join("")
      .trim()
      .toUpperCase();

    const elapsed = Date.now() - t0;
    logger.info(`Semantic dedup LLM call done in ${elapsed}ms → ${text}`);
    return text === "SAME";
  } catch (err: any) {
    const elapsed = Date.now() - t0;
    // On rate limit or error, use similarity as fallback
    if (err.status === 429 || err.error?.type === "rate_limit_error") {
      logger.warn(`Semantic dedup LLM rate limited in ${elapsed}ms, using similarity fallback: ${similarity.toFixed(2)}`);
      return similarity > 0.5; // Conservative threshold
    }

    logger.warn(`Semantic dedup LLM call failed in ${elapsed}ms, assuming different:`, err);
    return false;
  }
}

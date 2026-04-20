import { createHash } from "node:crypto";

/**
 * Normalize error message by removing dynamic values (IDs, timestamps, URLs, etc.)
 * to generate consistent fingerprints for the same error type.
 *
 * Strategy: strip all dynamic content so that errors from the same code path
 * produce the same fingerprint regardless of request-specific data.
 */
function normalizeErrorMessage(message: string): string {
  return message
    // Strip leading timestamp + log level prefix: "2026-04-16T16:18:45 [ERRO] "
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\s*\[(?:ERRO|WARN|INFO|DEBUG)\]\s*/i, "")
    // Remove request/trace IDs in braces: {026f79d226c8a618598b4e7ade084d7e}
    .replace(/\{[0-9a-f]{16,}\}/g, "")
    // Remove bare large numeric IDs (trace IDs, snowflake IDs): {1774514120888176877}
    .replace(/\{?\d{13,}\}?/g, "")
    // Remove numeric IDs after common patterns
    .replace(/\b(id|ID|Id|userId|userInputId|taskId|orderId|businessId):\s*\d+/gi, "$1:ID")
    .replace(/\b(id|ID|Id|userId|userInputId|taskId|orderId|businessId)\s*=\s*\d+/gi, "$1=ID")
    // Remove timestamps (ISO format)
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, "")
    // Remove UUIDs
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "")
    // Remove URLs entirely (keep just the error context around them)
    .replace(/https?:\/\/[^\s'")\]]+/g, "URL")
    // Remove IP addresses
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?\b/g, "IP")
    // Remove JSON payloads (error details that vary per request)
    .replace(/\{[^{}]*"(message|error|code)"[^{}]*\}/g, "{JSON}")
    // Remove request id references: (request id: 20260416...)
    .replace(/\(request id:\s*[^)]+\)/gi, "")
    // Remove file paths with line numbers
    .replace(/\b[\w/.-]+\.(go|ts|js|java|py):\d+/g, "FILE:LINE")
    // Remove hex strings (session tokens, hashes)
    .replace(/\b[0-9a-f]{16,}\b/g, "HEX")
    // Collapse everything after the first colon-separated error detail
    // e.g. "DeepThinking error: LLM deep thinking error: ChatCompletion request error: Post ..."
    // becomes "DeepThinking error: LLM deep thinking error: ..."
    .replace(/^(\[[^\]]+\]\s+\w[^:]*:\s+\w[^:]*):.*$/s, "$1")
    .replace(/^(\w[^:]*:\s+\w[^:]*:\s+\w[^:]*):.*$/s, "$1")
    // Normalize whitespace
    .replace(/\s+/g, " ")
    .trim();
}

export function generateFingerprint(errorMessage: string, stackTop?: string): string {
  const normalizedMessage = normalizeErrorMessage(errorMessage);
  const normalizedStack = stackTop ? normalizeErrorMessage(stackTop) : "";
  const input = `${normalizedMessage}||${normalizedStack}`;
  return createHash("sha256").update(input).digest("hex");
}

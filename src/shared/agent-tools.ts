/**
 * Shared tool execution logic for Anthropic SDK agent loops.
 * Used by both analyzer.ts and issue-agent.ts.
 * Decoupled from MCP server — pure function implementations.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join, dirname, relative } from "node:path";
import { mkdirSync } from "node:fs";
import mysql from "mysql2/promise";
import type Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger.js";
import { createEsClient, searchLogs } from "./es-client.js";
import type { Config, Environment } from "./config.js";

export interface ToolExecutionContext {
  config: Config;
  envConfig?: Environment;
  codeRootPath?: string;
  worktreePath?: string;
}

/**
 * Define all available tools for agent loops.
 * Returns Anthropic.Tool[] for use in messages.create().
 */
export function getAgentTools(ctx: ToolExecutionContext): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [];

  // File operations (require worktreePath or codeRootPath)
  if (ctx.worktreePath || ctx.codeRootPath) {
    tools.push(
      {
        name: "read_file",
        description: "Read a file from the code root or worktree. Path must be relative to root.",
        input_schema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "File path relative to code root or worktree" },
          },
          required: ["filePath"],
        },
      },
      {
        name: "list_files",
        description: "List files in a directory. Path must be relative to code root or worktree.",
        input_schema: {
          type: "object" as const,
          properties: {
            dirPath: { type: "string", description: "Directory path relative to root (empty string for root)" },
          },
          required: ["dirPath"],
        },
      },
      {
        name: "search_code",
        description: "Search for code patterns using grep. Returns matching file paths and line numbers.",
        input_schema: {
          type: "object" as const,
          properties: {
            pattern: { type: "string", description: "Search pattern (regex supported)" },
            filePattern: { type: "string", description: "File pattern to search (e.g., '*.go', '*.ts')" },
          },
          required: ["pattern"],
        },
      },
    );
  }

  // Write operations (require worktreePath only)
  if (ctx.worktreePath) {
    tools.push(
      {
        name: "write_file",
        description: "Write or create a file in the worktree. Creates parent directories automatically.",
        input_schema: {
          type: "object" as const,
          properties: {
            filePath: { type: "string", description: "File path relative to worktree root" },
            content: { type: "string", description: "File content to write" },
          },
          required: ["filePath", "content"],
        },
      },
      {
        name: "run_command",
        description: "Execute a shell command in the worktree. Use for git operations, build tools, tests.",
        input_schema: {
          type: "object" as const,
          properties: {
            command: { type: "string", description: "Shell command to execute" },
          },
          required: ["command"],
        },
      },
    );
  }

  // Log search (requires envConfig with elasticsearch)
  if (ctx.envConfig?.elasticsearch) {
    tools.push({
      name: "search_logs",
      description: "Search Elasticsearch for error logs by keyword, level, or time range.",
      input_schema: {
        type: "object" as const,
        properties: {
          keyword: { type: "string", description: "Search keyword" },
          level: { type: "string", description: "Log level (ERROR, WARN, INFO)" },
          timeFrom: { type: "string", description: "Start time (ISO8601)" },
          timeTo: { type: "string", description: "End time (ISO8601)" },
          size: { type: "number", description: "Max results (default 20)" },
        },
      },
    });
  }

  // Database query (requires envConfig with databases)
  if (ctx.envConfig?.databases && ctx.envConfig.databases.length > 0) {
    tools.push({
      name: "query_database",
      description: "Execute a read-only SQL query against the database. Only SELECT/SHOW/DESCRIBE/EXPLAIN allowed.",
      input_schema: {
        type: "object" as const,
        properties: {
          sql: { type: "string", description: "SQL SELECT query to execute" },
          dbName: { type: "string", description: "Database name from config (optional, uses first DB if not specified)" },
        },
        required: ["sql"],
      },
    });
  }

  return tools;
}

/**
 * Execute a tool call from Claude during agent loop.
 * Returns a string result to be sent back to Claude.
 */
export async function executeAgentTool(
  toolName: string,
  input: Record<string, any>,
  ctx: ToolExecutionContext,
): Promise<string> {
  const { config, envConfig, codeRootPath, worktreePath } = ctx;
  const basePath = worktreePath || codeRootPath;

  switch (toolName) {
    case "read_file": {
      if (!basePath) return "Error: No code root or worktree path configured";
      const filePath = input.filePath;
      if (!filePath) return "Error: No filePath provided";

      const fullPath = resolve(basePath, filePath);
      const resolvedBase = resolve(basePath);
      if (!fullPath.startsWith(resolvedBase)) {
        return "Error: Access denied - path outside allowed root";
      }

      if (!existsSync(fullPath)) {
        const dir = dirname(fullPath);
        if (existsSync(dir)) {
          try {
            const entries = readdirSync(dir);
            const suggestions = entries.slice(0, 5);
            return `Error: File not found: ${filePath}\n\nFiles in ${relative(basePath, dir) || "."}:\n${suggestions.join("\n")}`;
          } catch {
            return `Error: File not found: ${filePath}`;
          }
        }
        return `Error: File not found: ${filePath}`;
      }

      try {
        const content = readFileSync(fullPath, "utf-8");
        if (content.length > 100000) {
          return `File too large (${content.length} chars), showing first 100000:\n${content.slice(0, 100000)}`;
        }
        return content;
      } catch (err) {
        return `Error reading file: ${err}`;
      }
    }

    case "write_file": {
      if (!worktreePath) return "Error: Write operations require worktree path";
      const filePath = input.filePath;
      const content = input.content;
      if (!filePath) return "Error: No filePath provided";
      if (content === undefined) return "Error: No content provided";

      const fullPath = resolve(worktreePath, filePath);
      const resolvedWorktree = resolve(worktreePath);
      if (!fullPath.startsWith(resolvedWorktree)) {
        return "Error: Access denied - path outside worktree";
      }

      try {
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content, "utf-8");
        return `Successfully wrote ${content.length} bytes to ${filePath}`;
      } catch (err) {
        return `Error writing file: ${err}`;
      }
    }

    case "list_files": {
      if (!basePath) return "Error: No code root or worktree path configured";
      const dirPath = input.dirPath ?? "";
      const fullPath = resolve(basePath, dirPath);
      const resolvedBase = resolve(basePath);
      if (!fullPath.startsWith(resolvedBase)) {
        return "Error: Access denied - path outside allowed root";
      }

      try {
        const entries = readdirSync(fullPath, { withFileTypes: true });
        const filtered = entries.filter((e) => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "vendor");

        if (filtered.length === 0) {
          return `Directory is empty: ${dirPath || "."}`;
        }

        return filtered
          .map((e) => {
            const icon = e.isDirectory() ? "📁" : "📄";
            return `${icon} ${e.name}`;
          })
          .join("\n");
      } catch (err) {
        return `Error listing directory: ${err}`;
      }
    }

    case "run_command": {
      if (!worktreePath) return "Error: Command execution requires worktree path";
      const command = input.command?.trim();
      if (!command) return "Error: No command provided";

      // Security: block dangerous git commands
      const lowerCmd = command.toLowerCase();
      if (lowerCmd.includes("git checkout") || lowerCmd.includes("git switch") || lowerCmd.includes("git worktree")) {
        return "Error: git checkout/switch/worktree commands are not allowed";
      }

      try {
        const output = execFileSync("sh", ["-c", command], {
          cwd: worktreePath,
          encoding: "utf-8",
          timeout: 60000,
          maxBuffer: 1024 * 1024,
        });
        return output || "(command completed with no output)";
      } catch (err: any) {
        const stderr = err.stderr || "";
        const stdout = err.stdout || "";
        return `Command failed (exit ${err.status || "unknown"}):\n${stdout}\n${stderr}`.slice(0, 5000);
      }
    }

    case "search_code": {
      if (!basePath) return "Error: No code root or worktree path configured";
      const pattern = input.pattern;
      const filePattern = input.filePattern || "*";
      if (!pattern) return "Error: No pattern provided";

      try {
        const args = [
          "-rn",
          "--include", filePattern,
          "--exclude-dir=node_modules",
          "--exclude-dir=vendor",
          "--exclude-dir=.git",
          "--exclude-dir=dist",
          "--max-count=3",
          pattern,
          basePath,
        ];

        const output = execFileSync("grep", args, {
          encoding: "utf-8",
          timeout: 10000,
          maxBuffer: 512 * 1024,
        });

        const lines = output.trim().split("\n").slice(0, 50);
        return lines.join("\n") || "No matches found";
      } catch (err: any) {
        if (err.status === 1) return "No matches found";
        return `Search failed: ${err.message || err}`;
      }
    }

    case "search_logs": {
      if (!envConfig) return "Error: Environment config not available for log search";
      try {
        const client = createEsClient(envConfig.elasticsearch.url);
        const timeRange = input.timeFrom && input.timeTo
          ? { from: input.timeFrom, to: input.timeTo }
          : undefined;
        const hits = await searchLogs({
          client,
          indices: envConfig.elasticsearch.indices,
          keyword: input.keyword,
          level: input.level,
          timeRange,
          size: input.size ?? 20,
        });
        if (hits.length === 0) return "No logs found.";
        return hits.map((h) => {
          const s = h.source;
          return `[${s["@timestamp"] ?? ""}] [${s["level"] ?? ""}] ${s["message"] ?? JSON.stringify(s)}`;
        }).join("\n");
      } catch (err) {
        return `ES search failed: ${err}`;
      }
    }

    case "query_database": {
      if (!envConfig) return "Error: Environment config not available for database query";
      const sql = input.sql?.trim();
      if (!sql) return "Error: No SQL query provided";

      const sqlUpper = sql.toUpperCase();
      if (!sqlUpper.startsWith("SELECT") && !sqlUpper.startsWith("SHOW") && !sqlUpper.startsWith("DESCRIBE") && !sqlUpper.startsWith("EXPLAIN")) {
        return "Error: Read-only mode - only SELECT, SHOW, DESCRIBE, EXPLAIN are allowed";
      }

      const dbName = input.dbName ?? envConfig.databases[0]?.name;
      const dbConfig = envConfig.databases.find((d) => d.name === dbName);
      if (!dbConfig) {
        const available = envConfig.databases.map((d) => d.name).join(", ") || "(none)";
        return `Error: Database '${dbName}' not found. Available: ${available}`;
      }

      let conn: mysql.Connection | null = null;
      try {
        const connStr = `mysql://${dbConfig.username}:${encodeURIComponent(dbConfig.password)}@${dbConfig.host}:${dbConfig.port}/${dbConfig.dbName}`;
        conn = await mysql.createConnection({
          uri: connStr,
          connectTimeout: 5000,
          enableKeepAlive: true,
          keepAliveInitialDelay: 0,
        });
        const [rows] = await Promise.race([
          conn.execute(sql),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Query timeout after 10s")), 10000)),
        ]);
        const result = Array.isArray(rows) ? rows.slice(0, 50) : rows;
        return JSON.stringify(result, null, 2);
      } catch (err: any) {
        logger.warn(`Database query failed for ${dbName}:`, err.message || err);
        return `Query failed: ${err.message || err}`;
      } finally {
        if (conn) {
          try {
            await conn.end();
          } catch { /* ignore cleanup errors */ }
        }
      }
    }

    default:
      return `Error: Unknown tool: ${toolName}`;
  }
}

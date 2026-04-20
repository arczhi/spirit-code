import { z } from "zod";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../shared/config.js";

const execFileAsync = promisify(execFile);

export function registerSearchCode(server: McpServer, config: Config) {
  const allCodeRoots = config.environments.flatMap((e) => e.codeRoots.map((r) => r.path));

  server.tool(
    "search_code",
    "Search code files with regex pattern using grep",
    {
      pattern: z.string().describe("Regex pattern to search for"),
      codePath: z.string().describe("Code root path to search in"),
      filePattern: z.string().optional().describe("File glob pattern (e.g. *.go, *.ts)"),
      maxResults: z.number().optional().describe("Max results (default 50)"),
    },
    async (params) => {
      const resolved = resolve(params.codePath);
      const allowed = allCodeRoots.some((root) => resolved.startsWith(resolve(root)));
      if (!allowed) {
        return { content: [{ type: "text", text: `Access denied: ${resolved} is not under any configured code root` }] };
      }

      const args = ["-rn", "--max-count", String(params.maxResults ?? 50)];
      if (params.filePattern) {
        args.push("--include", params.filePattern);
      }
      args.push("--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=vendor", "--exclude-dir=dist");
      args.push(params.pattern, resolved);

      try {
        const { stdout } = await execFileAsync("grep", args, { maxBuffer: 1024 * 512, timeout: 15000 });
        return { content: [{ type: "text", text: stdout || "No matches found." }] };
      } catch (err: unknown) {
        const e = err as { code?: number; stdout?: string };
        if (e.code === 1) return { content: [{ type: "text", text: "No matches found." }] };
        return { content: [{ type: "text", text: `Search failed: ${err}` }] };
      }
    },
  );
}

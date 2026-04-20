import { z } from "zod";
import { readdirSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../shared/config.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "vendor", "dist", "__pycache__", ".next"]);

function listDir(dirPath: string, recursive: boolean, maxDepth: number, depth = 0): string[] {
  const entries: string[] = [];
  try {
    const items = readdirSync(dirPath, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith(".") && item.name !== ".") continue;
      if (SKIP_DIRS.has(item.name)) continue;
      const fullPath = join(dirPath, item.name);
      if (item.isDirectory()) {
        entries.push(item.name + "/");
        if (recursive && depth < maxDepth) {
          const sub = listDir(fullPath, true, maxDepth, depth + 1);
          entries.push(...sub.map((s) => item.name + "/" + s));
        }
      } else {
        entries.push(item.name);
      }
    }
  } catch { /* skip unreadable dirs */ }
  return entries;
}

export function registerListFiles(server: McpServer, config: Config) {
  const allCodeRoots = config.environments.flatMap((e) => e.codeRoots.map((r) => r.path));

  server.tool(
    "list_files",
    "List files and directories in a path",
    {
      dirPath: z.string().describe("Directory path to list"),
      recursive: z.boolean().optional().describe("List recursively (default false, max depth 3)"),
    },
    async (params) => {
      const resolved = resolve(params.dirPath);
      const allowed = allCodeRoots.some((root) => resolved.startsWith(resolve(root)));
      if (!allowed) {
        return { content: [{ type: "text", text: `Access denied: ${resolved} is not under any configured code root` }] };
      }

      const entries = listDir(resolved, params.recursive ?? false, 3);
      return { content: [{ type: "text", text: entries.length === 0 ? "Empty directory." : entries.join("\n") }] };
    },
  );
}

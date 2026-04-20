import { z } from "zod";
import { readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../shared/config.js";

export function registerReadFile(server: McpServer, config: Config) {
  const allCodeRoots = config.environments.flatMap((e) => e.codeRoots.map((r) => r.path));

  server.tool(
    "read_file",
    "Read a source code file. Path must be under a configured code root.",
    {
      filePath: z.string().describe("Absolute path to the file"),
      startLine: z.number().optional().describe("Start line (1-based)"),
      endLine: z.number().optional().describe("End line (1-based, inclusive)"),
    },
    async (params) => {
      const resolved = resolve(params.filePath);
      const allowed = allCodeRoots.some((root) => resolved.startsWith(resolve(root)));
      if (!allowed) {
        return { content: [{ type: "text", text: `Access denied: ${resolved} is not under any configured code root` }] };
      }

      try {
        const content = readFileSync(resolved, "utf-8");
        if (content.length > 1024 * 1024) {
          return { content: [{ type: "text", text: "File too large (>1MB)" }] };
        }
        const lines = content.split("\n");
        const start = (params.startLine ?? 1) - 1;
        const end = params.endLine ?? lines.length;
        const sliced = lines.slice(start, end);
        const numbered = sliced.map((l, i) => `${start + i + 1}\t${l}`).join("\n");
        return { content: [{ type: "text", text: numbered }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to read file: ${err}` }] };
      }
    },
  );
}

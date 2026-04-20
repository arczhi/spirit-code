import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as gitOps from "../../shared/git-ops.js";

export function registerApplyPatch(server: McpServer) {
  server.tool(
    "apply_patch",
    "Write file content into a worktree (create or overwrite)",
    {
      worktreePath: z.string().describe("Path to the git worktree"),
      filePath: z.string().describe("Relative file path within the worktree"),
      content: z.string().describe("File content to write"),
    },
    async (params) => {
      try {
        await gitOps.applyPatch(params.worktreePath, params.filePath, params.content);
        return { content: [{ type: "text", text: `Written ${params.filePath} in ${params.worktreePath}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to apply patch: ${err}` }] };
      }
    },
  );
}

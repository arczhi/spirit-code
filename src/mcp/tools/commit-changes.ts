import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as gitOps from "../../shared/git-ops.js";

export function registerCommitChanges(server: McpServer) {
  server.tool(
    "commit_changes",
    "Stage all changes and commit in a worktree",
    {
      worktreePath: z.string().describe("Path to the git worktree"),
      message: z.string().describe("Commit message"),
    },
    async (params) => {
      try {
        const hash = await gitOps.commitChanges(params.worktreePath, params.message);
        return { content: [{ type: "text", text: `Committed ${hash} in ${params.worktreePath}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Commit failed: ${err}` }] };
      }
    },
  );
}
